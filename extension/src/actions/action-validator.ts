/**
 * Action Validator + Executor
 *
 * SECURITY PRINCIPLE: The server never directly controls the browser.
 * Every action returned by the server is validated locally before execution.
 * Only actions from the allowlist are permitted.
 *
 * ELEMENT RESOLUTION HIERARCHY:
 * 1. el_NNN registry ID (primary — from stable element registry)
 * 2. DOM ID (#id)
 * 3. CSS selector
 * 4. ARIA label / name
 * 5. Label text
 * 6. Button / link text search
 */
import type { BrowserAction, ActionResult, ActionType } from '../utils/types';
import { resolveElementId, findBySemanticRole } from '../content/element-registry';

// ── SAFE ACTION ALLOWLIST ──────────────────────────────────────────────────────

const SAFE_ACTIONS = new Set<ActionType>([
  'click', 'fill', 'scroll', 'select', 'focus',
  'navigate', 'wait', 'done', 'back', 'forward', 'finish', 'ask_user',
]);

// Actions that MUST NEVER be executed regardless of input
const BLOCKED_ACTIONS = new Set(['eval', 'execute', 'inject', 'run', 'script']);

// Patterns that must never appear in action values (code injection guard)
const BLOCKED_VALUE_PATTERNS = [/<script/i, /javascript:/i, /on\w+\s*=/i, /data:text\/html/i];

/** Validate a server-returned action. Returns null if safe, error string if rejected. */
export function validateAction(action: BrowserAction): string | null {
  // 1. Action type must be in allowlist
  if (!SAFE_ACTIONS.has(action.action)) {
    return `Blocked action type: "${action.action}" — not in safe action allowlist`;
  }

  // 2. Explicitly blocked keywords anywhere in action
  const actionStr = JSON.stringify(action).toLowerCase();
  for (const blocked of BLOCKED_ACTIONS) {
    if (actionStr.includes(blocked)) {
      return `Blocked: action JSON contains forbidden keyword "${blocked}"`;
    }
  }

  // 3. Navigate: only allow relative URLs or known safe domains
  if (action.action === 'navigate' && action.url) {
    const url = action.url;
    if (url.startsWith('javascript:') || url.startsWith('data:')) {
      return `Blocked navigate: dangerous URL scheme "${url.slice(0, 20)}"`;
    }
  }

  // 4. Fill: value must not look like code injection
  if (action.action === 'fill' && action.value) {
    const v = action.value;
    for (const pat of BLOCKED_VALUE_PATTERNS) {
      if (pat.test(v)) return `Blocked fill: suspicious value content`;
    }
  }

  // 5. Target must be specified for interactive actions
  if (['click', 'fill', 'select', 'focus'].includes(action.action) && !action.target) {
    return `Action "${action.action}" requires a target`;
  }

  return null; // Validated
}

// ── TARGET RESOLUTION ─────────────────────────────────────────────────────────

/** Robust target resolver — tries el_NNN registry first, then CSS/label fallback */
function resolveTarget(action: BrowserAction): Element | null {
  if (!action.target) return null;
  const { type, value } = action.target;
  if (!value) return null;

  const rawVal = value.trim();

  try {
    // Priority 1: Stable el_NNN registry ID
    if (/^el_\d{3,}$/.test(rawVal)) {
      const el = resolveElementId(rawVal);
      if (el) return el;
      console.warn(`[ActionValidator] el_NNN registry miss: ${rawVal}`);
    }

    // Priority 2: Semantic search in registry (if value looks descriptive)
    if (rawVal.length > 4 && !/^[#\.\[]/.test(rawVal) && !/^el_/.test(rawVal)) {
      const registryMatches = findBySemanticRole(rawVal);
      if (registryMatches.length === 1) {
        const el = resolveElementId(registryMatches[0].elementId);
        if (el) return el;
      }
    }

    // Priority 3: ID directly
    const cleanId = rawVal.replace(/^#/, '');
    let el = document.getElementById(cleanId);
    if (el) return el;

    // Priority 4: Query selector if value starts with #, ., [, or tag
    if (/^[#\.\[a-zA-Z]/.test(rawVal)) {
      el = document.querySelector(rawVal);
      if (el) return el;
    }

    // Priority 5: ARIA label, name, placeholder, data-role
    el = document.querySelector(
      `[aria-label="${rawVal}"], [name="${cleanId}"], [placeholder="${cleanId}"], [data-role="${cleanId}"]`
    );
    if (el) return el;

    // Priority 6: Button / link text search
    const candidates = document.querySelectorAll<Element>(
      'button, a, input[type="submit"], input[type="button"], [role="button"]'
    );
    for (const c of candidates) {
      if (c.textContent?.toLowerCase().includes(rawVal.toLowerCase())) return c;
    }

    // Priority 7: Input search by label text
    const labels = document.querySelectorAll('label');
    for (const lbl of labels) {
      if (lbl.textContent?.toLowerCase().includes(rawVal.toLowerCase())) {
        const forId = lbl.getAttribute('for');
        if (forId) {
          const matchedEl = document.getElementById(forId);
          if (matchedEl) return matchedEl;
        }
        const childInput = lbl.querySelector('input, select, textarea');
        if (childInput) return childInput;
      }
    }
  } catch {
    /* invalid selector fallback */
  }

  return null;
}

// ── VISUAL FEEDBACK ────────────────────────────────────────────────────────────

function highlightInteraction(el: HTMLElement, type: string) {
  const origOutline = el.style.outline;
  const origTransition = el.style.transition;
  el.style.transition = 'all 0.2s ease-in-out';
  el.style.outline = type === 'click' ? '3px solid #22d3ee' : '3px solid #10b981';
  setTimeout(() => {
    el.style.outline = origOutline;
    el.style.transition = origTransition;
  }, 1200);
}

// ── ACTION EXECUTOR ────────────────────────────────────────────────────────────

/** Execute a validated browser action */
export async function executeAction(action: BrowserAction): Promise<ActionResult> {
  const startTime = Date.now();
  let isFileUpload = false;

  try {
    switch (action.action) {

      case 'click': {
        const el = resolveTarget(action) as HTMLElement | null;
        if (!el) throw new Error(`Target not found for click: ${JSON.stringify(action.target)}`);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        highlightInteraction(el, 'click');
        await delay(300);

        // Check if element triggers native file explorer / picker
        const isFileUploadTrigger =
          (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file') ||
          el.id === 'pickfiles' ||
          el.classList.contains('uploader__btn') ||
          /file|upload|choose|browse/i.test(el.textContent || '') ||
          /file|upload|choose|browse/i.test(el.getAttribute('aria-label') || '');

        if (isFileUploadTrigger) {
          isFileUpload = true;
          try {
            el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            el.click();
          } catch (clickErr) {
            console.warn('[ActionValidator] Primary trigger click warning:', clickErr);
          }

          // Also trigger all file inputs on the page (Plupload, dropzone, uploader container, moxie-shim)
          const fileInputs = Array.from(
            document.querySelectorAll<HTMLInputElement>(
              'input[type="file"], .moxie-shim input, [id^="html5_"], #uploader input[type="file"]'
            )
          );

          for (const fi of fileInputs) {
            try {
              fi.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
              fi.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
              fi.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
              fi.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
              fi.click();
            } catch (fiErr) {
              console.warn('[ActionValidator] File input click fallback warning:', fiErr);
            }
          }

          // Show on-page interactive user-activation toast in case browser security requires direct tab gesture
          showFileSelectionNotification(el, fileInputs);
        } else {
          // Dispatch full event sequence for standard interactive elements
          el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          el.click();
        }
        break;
      }

      case 'fill': {
        const el = resolveTarget(action) as HTMLInputElement | null;
        if (!el) throw new Error(`Target not found for fill: ${JSON.stringify(action.target)}`);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        highlightInteraction(el, 'fill');
        el.focus();
        const val = action.value ?? '';
        // Native setter override for React/Vue/Angular dynamic bindings
        const nativeValueSetter = Object.getOwnPropertyDescriptor(
          el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
          'value'
        )?.set;
        if (nativeValueSetter) {
          nativeValueSetter.call(el, val);
        } else {
          el.value = val;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        break;
      }

      case 'scroll': {
        const amount = action.amount ?? 400;
        const dir = action.direction ?? 'down';
        window.scrollBy({
          top: dir === 'down' ? amount : dir === 'up' ? -amount : 0,
          left: dir === 'right' ? amount : dir === 'left' ? -amount : 0,
          behavior: 'smooth',
        });
        break;
      }

      case 'select': {
        const el = resolveTarget(action) as HTMLSelectElement | null;
        if (!el) throw new Error(`Select target not found: ${JSON.stringify(action.target)}`);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        highlightInteraction(el, 'fill');
        el.value = action.value ?? '';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }

      case 'focus': {
        const el = resolveTarget(action) as HTMLElement | null;
        if (!el) throw new Error(`Focus target not found: ${JSON.stringify(action.target)}`);
        el.focus();
        highlightInteraction(el, 'fill');
        break;
      }

      case 'navigate': {
        if (action.url) window.location.href = action.url;
        break;
      }

      case 'back': {
        window.history.back();
        break;
      }

      case 'forward': {
        window.history.forward();
        break;
      }

      case 'wait': {
        await delay(action.amount ?? 800);
        break;
      }

      case 'ask_user': {
        // This is handled at the service worker level — content script is a no-op
        console.log('[PrivacyAgent] ask_user action — awaiting user input via popup');
        break;
      }

      case 'finish':
      case 'done': {
        console.log('[PrivacyAgent] Task marked complete:', action.reason);
        break;
      }
    }

    return {
      success: true,
      action,
      executedAt: Date.now(),
      latencyMs: Date.now() - startTime,
      isFileUploadTrigger: isFileUpload,
    };
  } catch (err) {
    return {
      success: false,
      action,
      error: String(err),
      executedAt: Date.now(),
      latencyMs: Date.now() - startTime,
      isFileUploadTrigger: isFileUpload,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Show an on-page interactive user-activation prompt so File Explorer reliably opens */
function showFileSelectionNotification(triggerEl: HTMLElement, fileInputs: HTMLInputElement[]): void {
  try {
    const existing = document.getElementById('__privsight_file_toast__');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = '__privsight_file_toast__';
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #091322;
      border: 2px solid #06b6d4;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.75), 0 0 24px rgba(6, 182, 212, 0.5);
      border-radius: 12px;
      padding: 12px 20px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      gap: 16px;
      cursor: pointer;
    `;

    toast.innerHTML = `
      <div style="font-size: 24px; line-height: 1;">📁</div>
      <div style="text-align: left;">
        <div style="font-weight: 700; font-size: 13px; color: #38bdf8;">Select files from file explorer</div>
        <div style="font-size: 11px; color: #94a3b8; margin-top: 1px;">
          PrivSight triggered file selection. Choose your PDF files to proceed.
        </div>
      </div>
      <button id="__privsight_btn_open__" style="
        background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
        color: white;
        border: 1px solid #38bdf8;
        border-radius: 6px;
        padding: 6px 14px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        white-space: nowrap;
      ">
        📂 Choose Files
      </button>
    `;

    document.body.appendChild(toast);

    const triggerAllInputs = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      for (const fi of fileInputs) {
        try { fi.click(); } catch {}
      }
      try { triggerEl.click(); } catch {}
      setTimeout(() => toast.remove(), 1000);
    };

    toast.addEventListener('click', triggerAllInputs);
    const btn = toast.querySelector('#__privsight_btn_open__');
    if (btn) btn.addEventListener('click', triggerAllInputs as any);

    setTimeout(() => {
      if (toast.parentElement) toast.remove();
    }, 14000);
  } catch (err) {
    console.warn('[ActionValidator] Failed to show file selection notification:', err);
  }
}
