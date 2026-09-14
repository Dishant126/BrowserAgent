/**
 * DOM Visibility & Modal Occlusion Detection
 *
 * Prevents stale or occluded elements from previous pages/steps (e.g. background payment forms)
 * from being detected, masked, or redacted when a new modal, dialog, or iframe (e.g. Razorpay, Stripe)
 * appears over them.
 */

import type { BoundingBox, PIIEntity } from './types';

const MODAL_SELECTORS = [
  'dialog[open]',
  '[role="dialog"]:not([aria-hidden="true"])',
  '[role="alertdialog"]:not([aria-hidden="true"])',
  '[aria-modal="true"]:not([aria-hidden="true"])',
  'iframe[src*="razorpay"]',
  'iframe[name*="razorpay"]',
  'iframe.razorpay-checkout-frame',
  '.razorpay-checkout-frame',
  '.razorpay-container',
  '#razorpay-checkout-frame',
  'iframe[src*="stripe"]',
  'iframe[name*="__privateStripe"]',
  '.modal.show',
  '.modal.open',
  '.modal.in',
  '.swal2-container',
  '#kavach',
  '.checkout-modal',
  '.payment-modal',
];

const BACKDROP_SELECTORS = [
  '.modal-backdrop',
  '[class*="backdrop"]',
  '[class*="Backdrop"]',
  '.swal2-backdrop',
  'div[class*="overlay"]:not([role])',
];

/**
 * Returns all currently active visible modals / dialogs / checkout frames,
 * sorted with topmost (highest z-index / innermost) first.
 */
export function getActiveModals(): Element[] {
  if (typeof document === 'undefined' || typeof window === 'undefined') return [];

  const found: Array<{ el: Element; zIndex: number; area: number }> = [];
  const seen = new Set<Element>();

  for (const sel of MODAL_SELECTORS) {
    try {
      const candidates = document.querySelectorAll(sel);
      for (const el of Array.from(candidates)) {
        if (seen.has(el)) continue;
        if (
          el.id === '__privacy-agent-overlay__' ||
          el.id === '__privsight-host__' ||
          el.id === '__privsight-floating-panel__' ||
          el.closest('#__privacy-agent-overlay__, #__privsight-host__, #__privsight-floating-panel__')
        ) {
          continue;
        }

        const rect = el.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 50) {
          try {
            const style = window.getComputedStyle(el);
            if (
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              parseFloat(style.opacity || '1') > 0
            ) {
              const parsedZ = parseInt(style.zIndex, 10);
              const zIndex = isNaN(parsedZ) ? 0 : parsedZ;
              const area = rect.width * rect.height;
              found.push({ el, zIndex, area });
              seen.add(el);
            }
          } catch {
            found.push({ el, zIndex: 0, area: rect.width * rect.height });
            seen.add(el);
          }
        }
      }
    } catch {}
  }

  // Fallback: Check for generic fixed/absolute elements with high z-index covering central screen
  try {
    const fixedElements = document.querySelectorAll<HTMLElement>('div, section, article, aside');
    for (const el of Array.from(fixedElements)) {
      if (seen.has(el)) continue;
      if (
        el.id === '__privacy-agent-overlay__' ||
        el.id === '__privsight-host__' ||
        el.id === '__privsight-floating-panel__' ||
        el.closest('#__privacy-agent-overlay__, #__privsight-host__, #__privsight-floating-panel__')
      ) {
        continue;
      }
      try {
        const style = window.getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'absolute') {
          const z = parseInt(style.zIndex, 10);
          if (z >= 100) {
            const rect = el.getBoundingClientRect();
            if (
              rect.width >= 250 &&
              rect.height >= 150 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              parseFloat(style.opacity || '1') > 0
            ) {
              // Ensure it contains interactive or textual content
              if (el.querySelector('input, button, [role="button"], form, p, h1, h2, h3, h4')) {
                found.push({ el, zIndex: z, area: rect.width * rect.height });
                seen.add(el);
              }
            }
          }
        }
      } catch {}
    }
  } catch {}

  // Separate dialog content cards from pure backdrop curtains
  const dialogs: Array<{ el: Element; zIndex: number; area: number }> = [];
  const backdrops: Array<{ el: Element; zIndex: number; area: number }> = [];

  for (const item of found) {
    const isBackdrop = BACKDROP_SELECTORS.some(b => {
      try { return item.el.matches(b) && !item.el.querySelector('input, button, form'); } catch { return false; }
    });
    if (isBackdrop) {
      backdrops.push(item);
    } else {
      dialogs.push(item);
    }
  }

  // Deduplicate: Keep top-level dialog containers (discard child elements that are inside a parent dialog with >= zIndex)
  const topDialogs = dialogs.filter(d => {
    return !dialogs.some(other => other !== d && other.el.contains(d.el) && other.zIndex >= d.zIndex);
  });

  // Sort by z-index descending (higher z-index = topmost modal)
  topDialogs.sort((a, b) => b.zIndex - a.zIndex);

  return topDialogs.length > 0 ? topDialogs.map(d => d.el) : backdrops.map(b => b.el);
}

/**
 * Returns the currently active, visible modal/dialog/checkout-frame element if one exists.
 */
export function getActiveModal(): Element | null {
  const modals = getActiveModals();
  return modals.length > 0 ? modals[0] : null;
}

/**
 * Helper to identify if an element holds or accepts financial or authentication PII.
 */
export function isElementFinancialOrAuthSensitive(el: Element): boolean {
  if (!el) return false;
  const input = el as HTMLInputElement;
  const type = (input.type || '').toLowerCase();
  const val = (input.value || '').trim();
  const name = (input.name || '').toLowerCase();
  const id = (input.id || '').toLowerCase();
  const placeholder = (input.placeholder || '').toLowerCase();
  const aria = (input.getAttribute('aria-label') || '').toLowerCase();
  const testId = (input.getAttribute('data-testid') || '').toLowerCase();
  const cls = (typeof input.className === 'string' ? input.className : '').toLowerCase();
  const text = (el.textContent || '').trim();
  const combined = `${name} ${id} ${placeholder} ${aria} ${testId} ${cls}`;

  if (type === 'password') return true;
  if (/card|credit|debit|cvv|cvc|csc|security.?code|otp|passcode|expiry|valid.?thru/i.test(combined)) return true;
  if (val && (/\b(?:\d[ \-]?){12,18}\d\b/.test(val) || /^\d{3,4}$/.test(val) || /^\d{4,8}$/.test(val))) return true;
  if (text && /\b(?:\d[ \-]?){12,18}\d\b/.test(text)) return true;
  return false;
}

/**
 * Checks if a DOM element is occluded/covered by an active modal, backdrop,
 * or higher-stacking element, or hidden via styles/attributes.
 */
export function isElementOccluded(el: Element, rect?: DOMRect | BoundingBox): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;

  const r = rect || el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return true;

  // 1. Check computed styles on element
  try {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
      return true;
    }
  } catch {}

  // 2. Check if ancestor is aria-hidden, inert, or hidden
  let parent = el.parentElement;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    if (parent.getAttribute('aria-hidden') === 'true' || parent.hasAttribute('inert')) {
      return true;
    }
    try {
      const pStyle = window.getComputedStyle(parent);
      if (pStyle.display === 'none' || pStyle.visibility === 'hidden' || parseFloat(pStyle.opacity || '1') === 0) {
        return true;
      }
    } catch {}
    parent = parent.parentElement;
  }

  // If inside a child iframe (e.g. payment checkout iframe), the elements inside this document
  // are the active checkout inputs themselves; they are never occluded by parent modals.
  if (window !== window.top) {
    return false;
  }

  // 3. Active modal containment check:
  // If active modals exist, elements outside all active modals are occluded by the modal/backdrop
  const activeModals = getActiveModals();
  if (activeModals.length > 0) {
    const vpLeft = (r as any).left !== undefined ? (r as any).left : (r as any).x - window.scrollX;
    const vpTop = (r as any).top !== undefined ? (r as any).top : (r as any).y - window.scrollY;

    const insideModal = activeModals.find(m => m === el || m.contains(el));

    if (activeModals.length > 0 && !insideModal) {
      // Element is in the background page behind the active modal -> OCCLUDED!
      return true;
    }

    // If multiple stacked modals exist (e.g. OTP popup on top of checkout modal),
    // check if a higher-stacking modal covers this element
    for (const higherModal of activeModals) {
      if (higherModal === insideModal || higherModal.contains(el)) break;
      const hRect = higherModal.getBoundingClientRect();
      if (
        vpLeft < hRect.right &&
        vpLeft + r.width > hRect.left &&
        vpTop < hRect.bottom &&
        vpTop + r.height > hRect.top
      ) {
        return true; // covered by higher modal
      }
    }

    // Element is inside the active modal and not covered by a higher modal -> VISIBLE!
    return false;
  }

  // 4. Hit-test multiple points (center, top-left, bottom-right)
  const vpLeft = (r as any).left !== undefined ? (r as any).left : (r as any).x - window.scrollX;
  const vpTop = (r as any).top !== undefined ? (r as any).top : (r as any).y - window.scrollY;

  const testPoints = [
    { x: Math.round(vpLeft + r.width / 2), y: Math.round(vpTop + r.height / 2) },
    { x: Math.round(vpLeft + Math.min(8, r.width / 2)), y: Math.round(vpTop + Math.min(8, r.height / 2)) },
    { x: Math.round(vpLeft + r.width - Math.min(8, r.width / 2)), y: Math.round(vpTop + r.height - Math.min(8, r.height / 2)) },
  ];

  let anyVisible = false;

  for (const pt of testPoints) {
    if (pt.x < 0 || pt.x > window.innerWidth || pt.y < 0 || pt.y > window.innerHeight) {
      continue;
    }

    try {
      const probe = document.elementFromPoint(pt.x, pt.y);
      if (!probe) continue;

      // Ignore our own visual overlay / floating panel
      if (
        probe.id === '__privacy-agent-overlay__' ||
        probe.id === '__privsight-host__' ||
        probe.id === '__privsight-floating-panel__' ||
        probe.closest('#__privacy-agent-overlay__, #__privsight-host__, #__privsight-floating-panel__')
      ) {
        anyVisible = true;
        break;
      }

      // If probe is the element itself or a child/parent container -> visible
      if (probe === el || el.contains(probe) || probe.contains(el)) {
        anyVisible = true;
        break;
      }

      // Check associated label or wrapper
      const elId = (el as any).id;
      if (elId && probe.closest(`label[for="${elId}"]`)) {
        anyVisible = true;
        break;
      }
      if (el.closest('.input-group, .form-group, .field, label') === probe.closest('.input-group, .form-group, .field, label')) {
        anyVisible = true;
        break;
      }

      // If probe is a modal backdrop or overlay that does NOT contain el -> occluded!
      const blocking = probe.closest(
        '.modal-backdrop, [class*="backdrop"], .swal2-backdrop, [class*="Backdrop"], div[class*="overlay"]:not([role])'
      );
      if (blocking && !blocking.contains(el)) {
        return true;
      }
    } catch {
      anyVisible = true;
    }
  }

  return !anyVisible;
}

/**
 * Checks if a bounding box (e.g. from text range or OCR) is occluded by an active modal or backdrop.
 */
export function isRectOccluded(rect: DOMRect | BoundingBox, containerEl?: Element | null): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;

  if (rect.width <= 0 || rect.height <= 0) return true;

  const activeModals = getActiveModals();
  if (activeModals.length > 0) {
    if (containerEl) {
      const insideAnyModal = activeModals.some(m => m === containerEl || m.contains(containerEl));
      if (!insideAnyModal) {
        return true; // outside all active modals
      }
    } else {
      // If no container element given, check if rect lies inside any active modal
      const vpLeft = (rect as any).left !== undefined ? (rect as any).left : (rect as any).x - window.scrollX;
      const vpTop = (rect as any).top !== undefined ? (rect as any).top : (rect as any).y - window.scrollY;
      const vpRight = vpLeft + rect.width;
      const vpBottom = vpTop + rect.height;

      const insideAny = activeModals.some(m => {
        const mRect = m.getBoundingClientRect();
        return (
          vpLeft >= mRect.left - 15 &&
          vpRight <= mRect.right + 15 &&
          vpTop >= mRect.top - 15 &&
          vpBottom <= mRect.bottom + 15
        );
      });
      if (!insideAny) {
        return true; // outside all active modals
      }
    }
  }

  const vpLeft = (rect as any).left !== undefined ? (rect as any).left : (rect as any).x - window.scrollX;
  const vpTop = (rect as any).top !== undefined ? (rect as any).top : (rect as any).y - window.scrollY;
  const centerX = Math.round(vpLeft + rect.width / 2);
  const centerY = Math.round(vpTop + rect.height / 2);

  if (centerX < 0 || centerX > window.innerWidth || centerY < 0 || centerY > window.innerHeight) {
    return true;
  }

  try {
    const probe = document.elementFromPoint(centerX, centerY);
    if (!probe) return true;

    if (
      probe.id === '__privacy-agent-overlay__' ||
      probe.id === '__privsight-host__' ||
      probe.id === '__privsight-floating-panel__' ||
      probe.closest('#__privacy-agent-overlay__, #__privsight-host__, #__privsight-floating-panel__')
    ) {
      return false;
    }

    if (containerEl && (probe === containerEl || containerEl.contains(probe) || probe.contains(containerEl))) {
      return false;
    }

    const blocking = probe.closest(
      '.modal-backdrop, [class*="backdrop"], .swal2-backdrop, [class*="Backdrop"], div[class*="overlay"]:not([role])'
    );
    if (blocking) {
      if (!containerEl || !blocking.contains(containerEl)) {
        return true;
      }
    }
  } catch {}

  return false;
}

/**
 * Checks if a detected PIIEntity is occluded in the current visual state.
 */
export function isEntityOccluded(entity: PIIEntity): boolean {
  // CRITICAL SECURITY RULE: Card numbers, CVVs, Passwords, and OTPs must NEVER be dropped as occluded
  // if they are inside the visible viewport. If an active modal is open, financial PII inside the modal
  // MUST ALWAYS be redacted to prevent catastrophic data leakage to remote servers.
  if (['credit_card', 'cvv', 'password', 'otp', 'aadhaar', 'pan'].includes(entity.type)) {
    if (entity.bbox && entity.bbox.width > 0 && entity.bbox.height > 0) {
      const vpLeft = entity.bbox.x - window.scrollX;
      const vpTop = entity.bbox.y - window.scrollY;
      const inViewport = (
        vpLeft + entity.bbox.width > 0 &&
        vpLeft < window.innerWidth &&
        vpTop + entity.bbox.height > 0 &&
        vpTop < window.innerHeight
      );

      if (inViewport) {
        const activeModals = getActiveModals();
        if (activeModals.length > 0) {
          const insideAnyModal = activeModals.some(m => {
            if (entity.targetElement && (m === entity.targetElement || m.contains(entity.targetElement))) return true;
            const mRect = m.getBoundingClientRect();
            return (
              vpLeft >= mRect.left - 40 &&
              vpLeft + entity.bbox.width <= mRect.right + 40 &&
              vpTop >= mRect.top - 40 &&
              vpTop + entity.bbox.height <= mRect.bottom + 40
            );
          });
          // If inside active modal -> NEVER occlude! Must be redacted!
          if (insideAnyModal) return false;
          // If outside active modal (background payment form from previous step) -> occluded
          return true;
        }
        // No modal open -> visible on page -> NEVER occlude! Must be redacted!
        return false;
      }
    }
  }

  if (entity.targetElement) {
    return isElementOccluded(entity.targetElement, entity.bbox);
  }
  if (entity.bbox) {
    return isRectOccluded(entity.bbox);
  }
  return false;
}

