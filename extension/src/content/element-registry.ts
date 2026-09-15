/**
 * Element Registry — stable session-scoped element ID system.
 *
 * PRIVACY & ROBUSTNESS PRINCIPLE:
 *   The LLM never sees raw CSS selectors. It reasons using stable semantic IDs
 *   like el_001, el_002, etc. The registry maps these IDs to actual DOM elements
 *   locally. This improves both privacy AND robustness.
 *
 * ID format: el_NNN (zero-padded 3 digits, resets per page navigation)
 * Registry resets on URL change (new page load).
 */

import type { ElementRecord, BoundingBox } from '../utils/types';
import { isElementOccluded } from '../utils/dom-visibility';

// ── REGISTRY STATE ────────────────────────────────────────────────────────────

let counter = 0;
let currentPageUrl = '';
const registry = new Map<string, { record: ElementRecord; element: Element }>();

// ── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * Reset the registry for a new page load.
 * Must be called when URL changes or page navigates.
 */
export function resetRegistry(pageUrl?: string): void {
  counter = 0;
  registry.clear();
  currentPageUrl = pageUrl ?? location.href;
  console.log('[ElementRegistry] Reset for:', currentPageUrl);
}

/**
 * Check if the registry needs resetting (URL changed).
 */
export function checkAndResetIfNeeded(): boolean {
  const url = location.href;
  if (url !== currentPageUrl) {
    resetRegistry(url);
    return true;
  }
  return false;
}

/**
 * Build or refresh the registry from the current DOM.
 * Returns the list of ElementRecords for transmission to the server.
 */
export function buildRegistry(): ElementRecord[] {
  checkAndResetIfNeeded();

  // Clear old entries and rebuild
  registry.clear();
  counter = 0;

  const INTERACTIVE_SELECTORS = [
    'input:not([type="hidden"])',
    'button',
    'select',
    'textarea',
    'a[href]',
    'label:has(input)',
    '[role="button"]',
    '[role="link"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="radio"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[role="option"]',
    '[contenteditable="true"]',
  ].join(', ');

  const seen = new Set<string>();
  const records: ElementRecord[] = [];

  document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTORS).forEach(el => {
    let rect = el.getBoundingClientRect();
    const isRadioOrCheckbox = el.tagName === 'INPUT' && ((el as HTMLInputElement).type === 'radio' || (el as HTMLInputElement).type === 'checkbox');

    // Skip elements that are not visible (allow custom styled radio/checkboxes if parent container/label is visible)
    if (rect.width === 0 && rect.height === 0) {
      if (isRadioOrCheckbox) {
        const parentContainer = el.closest('label') ||
          (el.id ? document.querySelector<HTMLElement>(`label[for="${CSS.escape(el.id)}"]`) : null) ||
          el.closest('[class*="radio"], [class*="option"], [class*="form-check"], div, span') ||
          el.parentElement;
        if (parentContainer) {
          const lRect = parentContainer.getBoundingClientRect();
          if (lRect.width === 0 && lRect.height === 0) return;
          rect = lRect; // Use container's bounding box for interaction
        } else {
          return;
        }
      } else {
        return;
      }
    }
    if (rect.top > window.innerHeight + 500) return; // far off-screen

    const isSensitive = detectSensitivity(el);
    // Never occlude sensitive financial or auth fields if they are in the viewport
    if (!isSensitive && isElementOccluded(el, rect)) return; // occluded or covered by modal/backdrop

    const elementId = `el_${String(++counter).padStart(3, '0')}`;
    // Tag element with persistent local data attribute for 100% reliable CSS selection & resolution
    try {
      el.setAttribute('data-ag-id', elementId);
    } catch {}

    const selector = `[data-ag-id="${elementId}"]`;
    const input = el as HTMLInputElement;
    const bbox: BoundingBox = {
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };

    const ariaLabel = el.getAttribute('aria-label') ||
                      el.getAttribute('aria-labelledby')
                        ? resolveAriaLabelledby(el)
                        : undefined;
    const ariaRole = el.getAttribute('role') ?? getRoleFromTag(el.tagName.toLowerCase());

    const record: ElementRecord = {
      elementId,
      domSelector: selector,
      tag: el.tagName.toLowerCase(),
      role: buildSemanticRole(el, ariaLabel, ariaRole),
      text: (el.textContent?.trim().slice(0, 80) || ''),
      ariaLabel: ariaLabel || undefined,
      ariaRole: ariaRole || undefined,
      placeholder: input.placeholder || undefined,
      inputType: el.tagName === 'INPUT' ? (input.type || 'text') : undefined,
      visible: isVisible(el),
      enabled: !input.disabled && !(input as any).readOnly,
      sensitive: isSensitive,
      bbox,
    };

    registry.set(elementId, { record, element: el });
    records.push(record);
  });



  console.log(`[ElementRegistry] Built ${records.length} elements`);
  return records;
}

/**
 * Resolve an el_NNN ID back to a live DOM element.
 * If the element was removed from the DOM, returns null.
 */
export function resolveElementId(elementId: string): Element | null {
  const entry = registry.get(elementId);
  if (entry && document.body.contains(entry.element)) {
    return entry.element;
  }
  // Fast attribute fallback
  const direct = document.querySelector(`[data-ag-id="${elementId}"]`);
  if (direct) return direct;
  return null;
}

/**
 * Get the current registry snapshot (all visible records).
 */
export function getRegistrySnapshot(): ElementRecord[] {
  return Array.from(registry.values()).map(e => e.record);
}

/**
 * Find records matching a semantic description (for fallback resolution).
 */
export function findBySemanticRole(description: string): ElementRecord[] {
  const desc = description.toLowerCase();
  return Array.from(registry.values())
    .map(e => e.record)
    .filter(r =>
      r.role.toLowerCase().includes(desc) ||
      r.ariaLabel?.toLowerCase().includes(desc) ||
      r.text.toLowerCase().includes(desc) ||
      r.placeholder?.toLowerCase().includes(desc)
    );
}

// ── PRIVATE HELPERS ───────────────────────────────────────────────────────────

function buildStableSelector(el: HTMLElement): string {
  // Priority 1: stable id
  if (el.id && !el.id.match(/^\d/) && el.id.length < 60) {
    return `#${CSS.escape(el.id)}`;
  }

  // Priority 2: name attribute for form elements
  const name = (el as HTMLInputElement).name;
  if (name && el.tagName.match(/INPUT|SELECT|TEXTAREA/)) {
    return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
  }

  // Priority 2.5: Unique href for anchor tags
  if (el.tagName === 'A') {
    const href = el.getAttribute('href');
    if (href && href.length < 100 && !href.startsWith('javascript:')) {
      return `a[href="${href.replace(/"/g, '\\"')}"]`;
    }
  }

  // Priority 3: data-testid or data-qa
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-qa') || el.getAttribute('data-cy');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

  // Priority 4: aria-label (if short and stable)
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.length < 40) {
    return `${el.tagName.toLowerCase()}[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
  }

  // Priority 5: Build from class + tag + position
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList)
    .filter(c => !c.match(/^(active|selected|hover|focus|disabled|loading|open|closed|visible|hidden)$/i))
    .slice(0, 2);

  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
    const idx = siblings.indexOf(el);
    if (siblings.length > 1 && idx >= 0) {
      const clsStr = classes.length ? `.${classes.map(c => CSS.escape(c)).join('.')}` : '';
      return `${tag}${clsStr}:nth-of-type(${idx + 1})`;
    }
    // Disambiguate list item wrappers (e.g. <ul><li><a /></li></ul>)
    if (parent.tagName === 'LI' && parent.parentElement) {
      const parentSiblings = Array.from(parent.parentElement.children).filter(c => c.tagName === 'LI');
      const pIdx = parentSiblings.indexOf(parent);
      if (parentSiblings.length > 1 && pIdx >= 0) {
        return `li:nth-of-type(${pIdx + 1}) > ${tag}`;
      }
    }
  }

  const clsStr = classes.length ? `.${classes.map(c => CSS.escape(c)).join('.')}` : '';
  return `${tag}${clsStr}`;
}

function buildSemanticRole(el: HTMLElement, ariaLabel?: string | null, ariaRole?: string | null): string {
  if (ariaLabel) return ariaLabel;

  const tag = el.tagName.toLowerCase();
  const input = el as HTMLInputElement;

  // Button-like elements
  if (tag === 'button' || ariaRole === 'button' || input.type === 'submit' || input.type === 'button') {
    const txt = el.textContent?.trim() || el.getAttribute('value') || '';
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const isCloseBtn =
      txt === '✕' || txt === '×' || txt === 'X' || txt.toLowerCase() === 'close' ||
      aria === 'close' || aria.includes('close') || aria.includes('dismiss') ||
      el.classList.contains('close') || el.classList.contains('btn-close') ||
      (el.querySelector('svg, [class*="close"], [class*="times"]') !== null && txt.length <= 2);

    if (isCloseBtn) {
      return 'Close dialog button (✕) - DO NOT CLICK TO SUBMIT';
    }
    return (txt || 'button').slice(0, 60);
  }

  // Links
  if (tag === 'a') {
    const txt = el.textContent?.trim() || el.getAttribute('title') || 'link';
    return txt.slice(0, 60);
  }

  // Inputs
  if (tag === 'input') {
    const label = findAssociatedLabel(el);
    const ph = input.placeholder;
    if (input.type === 'radio' || input.type === 'checkbox') {
      const state = input.checked ? ' (checked)' : ' (unchecked)';
      if (label) return `${label} ${input.type}${state}`;
      return `${input.type} input${state}`;
    }
    if (label) return label;
    if (ph) return ph.slice(0, 60);
    return `${input.type || 'text'} input`;
  }

  // Select
  if (tag === 'select') {
    const label = findAssociatedLabel(el);
    return label ? label : 'dropdown';
  }

  // Textarea
  if (tag === 'textarea') {
    const label = findAssociatedLabel(el);
    return label ? label : 'text area';
  }

  return el.textContent?.trim().slice(0, 60) || tag;
}

function findAssociatedLabel(el: HTMLElement): string | null {
  if (el.id) {
    const lbl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
    if (lbl && lbl.textContent?.trim()) return lbl.textContent.trim();
  }
  const parentLabel = el.closest('label');
  if (parentLabel && parentLabel.textContent?.trim()) {
    return parentLabel.textContent.trim();
  }
  const parent = el.closest('.form-group, .field-group, [class*="radio"], [class*="checkbox"]');
  if (parent) {
    const lbl = parent.querySelector('label');
    if (lbl && lbl !== el && lbl.textContent?.trim()) return lbl.textContent.trim();
    const span = parent.querySelector('span, p');
    if (span && span.textContent?.trim()) return span.textContent.trim();
  }
  // Direct parent text for radio / checkbox items
  if (el.tagName === 'INPUT' && ((el as HTMLInputElement).type === 'radio' || (el as HTMLInputElement).type === 'checkbox')) {
    const parentText = el.parentElement?.textContent?.trim();
    if (parentText && parentText.length < 50 && !parentText.includes('\n')) {
      return parentText;
    }
  }
  if (el.nextElementSibling && el.nextElementSibling.textContent?.trim()) {
    return el.nextElementSibling.textContent.trim();
  }
  if (el.previousElementSibling && el.previousElementSibling.textContent?.trim()) {
    return el.previousElementSibling.textContent.trim();
  }
  const val = (el as HTMLInputElement).value;
  if (val && val !== 'on' && val !== 'true' && val.length < 40) {
    return val;
  }
  return null;
}

function resolveAriaLabelledby(el: HTMLElement): string | undefined {
  const labelledby = el.getAttribute('aria-labelledby');
  if (!labelledby) return undefined;
  const labels = labelledby.split(/\s+/).map(id => {
    const ref = document.getElementById(id);
    return ref?.textContent?.trim() ?? '';
  });
  return labels.filter(Boolean).join(' ') || undefined;
}

function getRoleFromTag(tag: string): string {
  const MAP: Record<string, string> = {
    button: 'button', a: 'link', input: 'textbox', select: 'combobox',
    textarea: 'textbox', nav: 'navigation', main: 'main', header: 'banner',
  };
  return MAP[tag] ?? tag;
}

function detectSensitivity(el: HTMLElement): boolean {
  const input = el as HTMLInputElement;
  if (input.type === 'password') return true;
  const ac = input.autocomplete?.toLowerCase() ?? '';
  if (ac.startsWith('cc-') || ac === 'email' || ac === 'tel') return true;
  const name = input.name?.toLowerCase() ?? '';
  const id = input.id?.toLowerCase() ?? '';
  const ph = input.placeholder?.toLowerCase() ?? '';
  const sensitivePatterns = /password|email|phone|mobile|card|cvv|aadhaar|pan\b|otp|ssn|pin/i;
  return sensitivePatterns.test(name) || sensitivePatterns.test(id) || sensitivePatterns.test(ph);
}

function isVisible(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (parseFloat(style.opacity || '1') === 0) {
    if (el.tagName === 'INPUT') {
      const input = el as HTMLInputElement;
      if (input.type === 'radio' || input.type === 'checkbox') {
        const parentLabel = el.closest('label') || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
        if (parentLabel) {
          const lStyle = window.getComputedStyle(parentLabel);
          return lStyle.display !== 'none' && lStyle.visibility !== 'hidden' && parseFloat(lStyle.opacity || '1') > 0;
        }
      }
    }
    return false;
  }
  return true;
}
