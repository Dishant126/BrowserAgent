/**
 * MaskLifecycleManager — Deterministic Lifecycle Management for PII Masks & Redaction Overlays
 *
 * Ensures that visual redaction overlays:
 * 1. Are tracked deterministically via registered handles with step/perception IDs.
 * 2. Never outlive their perception/action step.
 * 3. Are cleaned up immediately upon action execution, modal opening, DOM replacement, or navigation.
 * 4. Are cleaned up on error, agent stop, or step transitions.
 * 5. Do NOT modify or pollute the live page DOM.
 */

import type { PIIEntity, BoundingBox } from '../utils/types';
import { buildOverlayBoxes } from '../privacy/redaction-engine';
import { isElementFixedOrSticky } from '../vision/face-detector';

export interface MaskHandle {
  id: string;
  stepId: number | string;
  perceptionId: string;
  boxEl: HTMLDivElement;
  targetEl?: HTMLElement | Element | null;
  isFixed: boolean;
  baseBbox: BoundingBox;
  createdAt: number;
}

const MODAL_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  'dialog[open]',
  '.modal.show',
  '.modal.open',
  '.swal2-container',
  '.modal-backdrop',
  'iframe[src*="razorpay"]',
  'iframe[name*="razorpay"]',
  '.razorpay-checkout-frame',
  '.razorpay-container',
  '#razorpay-checkout-frame',
  'iframe[src*="stripe"]',
  'iframe[name*="__privateStripe"]',
  '#kavach',
  '.checkout-modal',
  '.payment-modal',
];

export class MaskLifecycleManager {
  private activeMasks: Map<string, MaskHandle> = new Map();
  private overlayContainer: HTMLDivElement | null = null;
  private currentStepId: number | string | null = null;
  private currentPerceptionId: string | null = null;
  private scrollRafId: number | null = null;
  private scrollListenersAttached = false;
  private domMutationObserver: MutationObserver | null = null;
  private isCleaningUp = false;

  constructor() {
    this.handleScrollOrResize = this.handleScrollOrResize.bind(this);
    this.handleDomMutations = this.handleDomMutations.bind(this);
  }

  /**
   * Create temporary visual masking overlays for detected PII entities.
   * Associated strictly with the given stepId / perceptionId.
   */
  public createMasks(
    entities: PIIEntity[],
    stepId: number | string = 1,
    perceptionId?: string
  ): void {
    // 1. Deterministically clean up any previous masks before rendering new ones
    this.cleanupMasks('perception_cycle_start');

    if (!entities || entities.length === 0) {
      return;
    }

    this.currentStepId = stepId;
    this.currentPerceptionId = perceptionId || `perc-${stepId}-${Date.now()}`;

    // 2. Ensure or create the dedicated root overlay container
    this.ensureOverlayContainer();
    if (!this.overlayContainer) return;

    const boxes = buildOverlayBoxes(entities);

    for (let i = 0; i < boxes.length; i++) {
      const { bbox, label, color, targetElement, isFixed: boxIsFixed } = boxes[i];
      const entity = entities[i];

      let targetEl: HTMLElement | Element | null = targetElement || null;
      if (!targetEl && entity?.domSelector) {
        try { targetEl = document.querySelector(entity.domSelector); } catch {}
      }
      if (!targetEl && bbox) {
        const vpX = bbox.x - window.scrollX + bbox.width / 2;
        const vpY = bbox.y - window.scrollY + bbox.height / 2;
        if (vpX >= 0 && vpX <= window.innerWidth && vpY >= 0 && vpY <= window.innerHeight) {
          const probe = document.elementFromPoint(vpX, vpY);
          if (probe && !probe.closest('#__privacy-agent-overlay__, #__privsight-host__')) {
            if (entity?.type === 'face') {
              targetEl = probe.closest('img, canvas, svg, [class*="avatar"], [class*="profile-photo"], [class*="user-photo"], [itemprop="image"]') || null;
            } else {
              targetEl = probe.closest('input, textarea, select, [contenteditable="true"]') || null;
            }
          }
        }
      }

      // Validate targetEl: NEVER use layout containers (div, section, main, body) or oversized elements
      if (targetEl) {
        const r = targetEl.getBoundingClientRect();
        const isLayoutTag = ['HTML', 'BODY', 'MAIN', 'SECTION', 'ARTICLE', 'DIV'].includes(targetEl.tagName.toUpperCase());
        const isOversized = r.width > window.innerWidth * 0.4 || r.height > window.innerHeight * 0.4 || (entity?.type === 'face' && (r.width > 350 || r.height > 350));
        if (isOversized || (isLayoutTag && entity?.type === 'face')) {
          targetEl = null;
        }
      }

      // If using bbox directly for a face, discard anomalous huge boxes
      if (!targetEl && entity?.type === 'face' && (bbox.width > 350 || bbox.height > 350 || (bbox.width * bbox.height > window.innerWidth * window.innerHeight * 0.15))) {
        continue;
      }

      const isFixed = boxIsFixed || (targetEl ? isElementFixedOrSticky(targetEl) : false);

      let boxLeft = 0;
      let boxTop = 0;
      let boxWidth = 0;
      let boxHeight = 0;

      if (targetEl) {
        const rect = targetEl.getBoundingClientRect();
        boxLeft = isFixed ? Math.round(rect.left) : Math.round(rect.left + window.scrollX);
        boxTop = isFixed ? Math.round(rect.top) : Math.round(rect.top + window.scrollY);
        boxWidth = Math.round(rect.width);
        boxHeight = Math.round(rect.height);
      } else {
        boxLeft = isFixed ? Math.round(bbox.x - window.scrollX) : Math.round(bbox.x);
        boxTop = isFixed ? Math.round(bbox.y - window.scrollY) : Math.round(bbox.y);
        boxWidth = Math.round(bbox.width);
        boxHeight = Math.round(bbox.height);
      }

      // Never blur if the box is abnormally large (more than 60% of viewport in either dimension)
      const isReasonablySized = boxWidth <= window.innerWidth * 0.6 && boxHeight <= window.innerHeight * 0.6 && boxWidth <= 600 && boxHeight <= 600;
      const isSensitive = !entity || entity.sensitivity === 'CRITICAL' || entity.sensitivity === 'HIGH' || entity.type === 'face' || entity.type === 'email' || entity.type === 'password' || entity.type === 'credit_card' || entity.type === 'cvv' || entity.type === 'phone' || entity.type === 'name';
      const blurStyle = (isSensitive && isReasonablySized) ? 'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' : '';
      const posStyle = isFixed ? 'position:fixed;' : 'position:absolute;';

      const maskId = `privsight-mask-${this.currentStepId}-${i}-${Math.random().toString(36).slice(2, 7)}`;
      const box = document.createElement('div');
      box.dataset.privsightMaskId = maskId;
      box.dataset.privsightStepId = String(this.currentStepId);
      box.style.cssText = `${posStyle}left:${boxLeft}px;top:${boxTop}px;width:${boxWidth}px;height:${boxHeight}px;border:2px solid ${color};background:${color}25;${blurStyle}pointer-events:none;border-radius:4px;box-sizing:border-box;z-index:2147483640;`;

      // Prevent top badge label from overlapping another mask placed directly above it (e.g. Expiry/CVV under Card Number)
      const hasBoxAbove = boxes.some((other, oi) => oi !== i && Math.abs((other.bbox.y + other.bbox.height) - bbox.y) < 8);
      if (!hasBoxAbove) {
        const lbl = document.createElement('div');
        lbl.style.cssText = `position:absolute;top:-20px;left:0;background:${color};color:#fff;font:bold 10px monospace;padding:2px 6px;border-radius:3px;white-space:nowrap;pointer-events:none;`;
        lbl.textContent = label;
        box.appendChild(lbl);
      }

      // Add centered placeholder text inside the blur box for immediate visual clarity
      if (entity?.placeholder && isReasonablySized && boxWidth >= 50) {
        const centerLbl = document.createElement('div');
        centerLbl.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#ffffff;font:bold 11px monospace;text-shadow:0 1px 3px rgba(0,0,0,0.8);pointer-events:none;letter-spacing:0.5px;';
        centerLbl.textContent = entity.placeholder;
        box.appendChild(centerLbl);
      }

      this.overlayContainer.appendChild(box);

      const handle: MaskHandle = {
        id: maskId,
        stepId: this.currentStepId,
        perceptionId: this.currentPerceptionId,
        boxEl: box,
        targetEl,
        isFixed,
        baseBbox: bbox,
        createdAt: Date.now(),
      };

      this.activeMasks.set(maskId, handle);
    }

    // 3. Attach position update listeners and DOM observers
    this.attachScrollListeners();
    this.startDomMutationObserver();

    console.log(`[MaskLifecycle] Registered ${this.activeMasks.size} masks for Step ${this.currentStepId} (${this.currentPerceptionId})`);
  }

  /**
   * Deterministically removes all active masks and cleans up the DOM container.
   */
  public cleanupMasks(reason = 'unspecified', filterStepId?: number | string): void {
    if (this.isCleaningUp) return;
    this.isCleaningUp = true;

    try {
      if (this.scrollRafId !== null) {
        cancelAnimationFrame(this.scrollRafId);
        this.scrollRafId = null;
      }

      if (filterStepId !== undefined) {
        // Remove only masks matching this stepId
        for (const [id, handle] of this.activeMasks.entries()) {
          if (handle.stepId === filterStepId) {
            handle.boxEl.remove();
            this.activeMasks.delete(id);
          }
        }
        if (this.activeMasks.size === 0) {
          this.removeOverlayContainers();
        }
      } else {
        // Remove all active masks
        for (const handle of this.activeMasks.values()) {
          try { handle.boxEl.remove(); } catch {}
        }
        this.activeMasks.clear();
        this.removeOverlayContainers();
        this.currentStepId = null;
        this.currentPerceptionId = null;
      }

      // Check for any detached or orphaned overlay containers with our exact ID
      this.removeOverlayContainers();

      console.log(`[MaskLifecycle] Cleanup completed (${reason}). Active masks: ${this.activeMasks.size}`);
    } finally {
      this.isCleaningUp = false;
    }
  }

  // ── LIFECYCLE HOOKS ──────────────────────────────────────────────────────────

  /**
   * Triggered right as an action starts executing.
   * Guarantees the old visual masks are removed before the page/modal transitions.
   */
  public onActionExecuting(action?: any): void {
    this.cleanupMasks('action_executing');
  }

  /**
   * Triggered immediately after action execution completes.
   */
  public onActionCompleted(action?: any): void {
    this.cleanupMasks('action_completed');
  }

  /**
   * Triggered when a modal or dialog is detected entering or exiting the DOM.
   */
  public onModalDetected(modalEl?: Element): void {
    if (this.activeMasks.size > 0) {
      console.log('[MaskLifecycle] Modal opening/closing detected — clearing previous masks');
      this.cleanupMasks('modal_transition');
    }
  }

  /**
   * Triggered on SPA route changes, hash changes, or popstate navigation.
   */
  public onNavigation(): void {
    this.cleanupMasks('navigation');
  }

  /**
   * Triggered when a step transitions.
   */
  public onStepTransition(nextStepId?: number | string): void {
    this.cleanupMasks(`step_transition_to_${nextStepId || 'next'}`);
  }

  /**
   * Query number of active registered masks.
   */
  public getActiveMasksCount(): number {
    return this.activeMasks.size;
  }

  /**
   * Query current active step ID.
   */
  public getCurrentStepId(): number | string | null {
    return this.currentStepId;
  }

  // ── PRIVATE HELPERS ─────────────────────────────────────────────────────────

  private ensureOverlayContainer(): void {
    // Remove any orphaned containers first
    this.removeOverlayContainers();

    this.overlayContainer = document.createElement('div');
    this.overlayContainer.id = '__privacy-agent-overlay__';
    this.overlayContainer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:2147483647;';
    document.body.appendChild(this.overlayContainer);
  }

  private removeOverlayContainers(): void {
    try {
      this.overlayContainer?.remove();
      this.overlayContainer = null;
      // Also query only our exact container ID to prevent multiple duplicates
      const orphans = document.querySelectorAll('#__privacy-agent-overlay__');
      orphans.forEach(el => el.remove());
    } catch {}
  }

  private attachScrollListeners(): void {
    if (this.scrollListenersAttached) return;
    window.addEventListener('scroll', this.handleScrollOrResize, { passive: true, capture: true });
    window.addEventListener('resize', this.handleScrollOrResize, { passive: true });
    document.addEventListener('scroll', this.handleScrollOrResize, { passive: true, capture: true });
    this.scrollListenersAttached = true;
  }

  private handleScrollOrResize(): void {
    if (this.scrollRafId !== null) cancelAnimationFrame(this.scrollRafId);
    this.scrollRafId = requestAnimationFrame(() => {
      this.scrollRafId = null;
      this.updateMaskPositions();
    });
  }

  private updateMaskPositions(): void {
    if (!this.overlayContainer || this.activeMasks.size === 0) return;

    for (const [id, handle] of this.activeMasks.entries()) {
      if (!handle.targetEl || !document.body.contains(handle.targetEl)) {
        // Element disconnected from DOM — hide or prune this mask
        handle.boxEl.style.display = 'none';
        continue;
      }

      const rect = handle.targetEl.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        handle.boxEl.style.display = 'none';
        continue;
      }
      handle.boxEl.style.display = 'block';

      const isFixed = handle.isFixed || isElementFixedOrSticky(handle.targetEl);
      if (isFixed) {
        handle.boxEl.style.position = 'fixed';
        handle.boxEl.style.left = `${Math.round(rect.left)}px`;
        handle.boxEl.style.top = `${Math.round(rect.top)}px`;
      } else {
        handle.boxEl.style.position = 'absolute';
        handle.boxEl.style.left = `${Math.round(rect.left + window.scrollX)}px`;
        handle.boxEl.style.top = `${Math.round(rect.top + window.scrollY)}px`;
      }
      handle.boxEl.style.width = `${Math.round(rect.width)}px`;
      handle.boxEl.style.height = `${Math.round(rect.height)}px`;
    }
  }

  private startDomMutationObserver(): void {
    if (this.domMutationObserver) return;

    try {
      this.domMutationObserver = new MutationObserver((mutations) => {
        if (this.isCleaningUp || this.activeMasks.size === 0) return;
        this.handleDomMutations(mutations);
      });

      this.domMutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden'],
      });
    } catch {}
  }

  private handleDomMutations(mutations: MutationRecord[]): void {
    for (const mutation of mutations) {
      // Check if any modal or dialog was added
      if (mutation.type === 'childList') {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            // Ignore our own overlay and floating panel
            if (el.id === '__privacy-agent-overlay__' || el.id === '__privsight-host__' || el.closest('#__privacy-agent-overlay__, #__privsight-host__')) {
              continue;
            }

            const isModal = MODAL_SELECTORS.some(sel => {
              try { return el.matches(sel) || el.querySelector(sel) !== null; } catch { return false; }
            });

            if (isModal) {
              this.onModalDetected(el);
              return;
            }
          }
        }
      }

      // Check if target elements of any active masks became disconnected
      for (const [id, handle] of this.activeMasks.entries()) {
        if (handle.targetEl && !document.body.contains(handle.targetEl)) {
          handle.boxEl.style.display = 'none';
        }
      }
    }
  }
}

export const maskLifecycleManager = new MaskLifecycleManager();
