/**
 * Accessibility Tree Extractor
 *
 * Extracts the ARIA / accessibility tree from the current page.
 * Provides a richer, more semantic representation than raw DOM.
 *
 * The accessibility tree is often a better input for browser agents
 * than raw pixels or raw HTML.
 *
 * Perception Level 1: DOM + A11y (used when ARIA is rich enough)
 * Perception Level 2: DOM + OCR (used when ARIA is sparse)
 */

export interface A11yNode {
  role: string;
  name: string;
  description?: string;
  level?: number;          // For headings
  expanded?: boolean;      // For menus, accordions
  checked?: boolean;       // For checkboxes, radios
  selected?: boolean;      // For tabs, options
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  value?: string;
  href?: string;
  tag: string;
  selector: string;
  children?: A11yNode[];
}

export interface A11yTreeResult {
  nodes: A11yNode[];
  hasRichA11y: boolean;   // True if page has substantial ARIA usage
  ariaLandmarks: string[];
  interactiveCount: number;
  headingCount: number;
}

/**
 * Extract a flat list of meaningful accessibility nodes from the page.
 * Only extracts nodes relevant for agent navigation.
 */
export function extractA11yTree(): A11yTreeResult {
  const nodes: A11yNode[] = [];
  const landmarks: string[] = [];
  let interactiveCount = 0;
  let headingCount = 0;

  // ── ARIA Landmarks ─────────────────────────────────────────────────────────
  const landmarkRoles = ['navigation', 'main', 'search', 'banner', 'contentinfo', 'complementary', 'form'];
  landmarkRoles.forEach(role => {
    const el = document.querySelector(`[role="${role}"], ${mapRoleToTag(role)}`);
    if (el) landmarks.push(role);
  });

  // ── Headings (h1-h6) ──────────────────────────────────────────────────────
  document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6').forEach(el => {
    const text = el.textContent?.trim();
    if (!text) return;
    const level = parseInt(el.tagName[1]);
    nodes.push({
      role: 'heading',
      name: text.slice(0, 100),
      level,
      tag: el.tagName.toLowerCase(),
      selector: buildA11ySelector(el),
    });
    headingCount++;
  });

  // ── ARIA Roles (interactive) ───────────────────────────────────────────────
  const interactiveRoles = [
    'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox',
    'radio', 'checkbox', 'switch', 'tab', 'menuitem', 'option',
    'spinbutton', 'slider', 'progressbar',
  ];

  document.querySelectorAll<HTMLElement>(interactiveRoles.map(r => `[role="${r}"]`).join(', ')).forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    const role = el.getAttribute('role') ?? 'generic';
    const name = computeAccessibleName(el);
    if (!name) return;

    const node: A11yNode = {
      role,
      name: name.slice(0, 80),
      tag: el.tagName.toLowerCase(),
      selector: buildA11ySelector(el),
    };

    if (el.getAttribute('aria-expanded')) node.expanded = el.getAttribute('aria-expanded') === 'true';
    if (el.getAttribute('aria-checked')) node.checked = el.getAttribute('aria-checked') === 'true';
    if (el.getAttribute('aria-selected')) node.selected = el.getAttribute('aria-selected') === 'true';
    if (el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled) node.disabled = true;
    if (el.getAttribute('aria-required') === 'true') node.required = true;
    if (el.getAttribute('aria-describedby')) {
      const desc = document.getElementById(el.getAttribute('aria-describedby')!);
      if (desc) node.description = desc.textContent?.trim().slice(0, 100);
    }

    nodes.push(node);
    interactiveCount++;
  });

  // ── Native interactive elements with ARIA labels ───────────────────────────
  document.querySelectorAll<HTMLElement>('input, select, textarea, button, a[href]').forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    // Only include if it has explicit ARIA enhancement
    const hasAria = el.getAttribute('aria-label') ||
                    el.getAttribute('aria-labelledby') ||
                    el.getAttribute('aria-describedby') ||
                    el.getAttribute('role');
    if (!hasAria) return;

    const name = computeAccessibleName(el);
    if (!name) return;

    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const role = el.getAttribute('role') ?? getRoleFromNativeTag(tag, input.type);

    nodes.push({
      role,
      name: name.slice(0, 80),
      placeholder: input.placeholder || undefined,
      tag,
      selector: buildA11ySelector(el),
      disabled: input.disabled,
      required: input.required,
    });
    interactiveCount++;
  });

  // ── Determine if page has rich ARIA ────────────────────────────────────────
  // "Rich" = page has landmarks AND multiple interactive ARIA nodes
  const hasRichA11y = landmarks.length >= 2 || interactiveCount >= 3 || headingCount >= 3;

  return {
    nodes,
    hasRichA11y,
    ariaLandmarks: landmarks,
    interactiveCount,
    headingCount,
  };
}

/**
 * Format the A11y tree as a compact string for the LLM context.
 */
export function formatA11yForLLM(result: A11yTreeResult): string {
  const lines: string[] = [`ACCESSIBILITY TREE (${result.nodes.length} nodes, rich_a11y=${result.hasRichA11y})`];
  if (result.ariaLandmarks.length > 0) {
    lines.push(`LANDMARKS: ${result.ariaLandmarks.join(', ')}`);
  }
  result.nodes.slice(0, 30).forEach(node => {
    const level = node.level ? ` [h${node.level}]` : '';
    const disabled = node.disabled ? ' [disabled]' : '';
    const required = node.required ? ' [required]' : '';
    lines.push(`  ${node.role}${level}${disabled}${required}: "${node.name}" selector="${node.selector}"`);
  });
  return lines.join('\n');
}

// ── PRIVATE HELPERS ────────────────────────────────────────────────────────────

function computeAccessibleName(el: HTMLElement): string {
  // 1. aria-label (highest priority)
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();

  // 2. aria-labelledby
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const labels = labelledby.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean);
    if (labels.length) return labels.join(' ');
  }

  // 3. For inputs: associated label element
  const input = el as HTMLInputElement;
  if (el.id) {
    const lbl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
    if (lbl?.textContent?.trim()) return lbl.textContent.trim();
  }
  const parentLabel = el.closest('label');
  if (parentLabel?.textContent?.trim()) {
    return parentLabel.textContent.trim();
  }
  if (el.nextElementSibling?.textContent?.trim()) {
    return el.nextElementSibling.textContent.trim();
  }
  if (input.value && input.value !== 'on' && input.value !== 'true' && input.value.length < 40) {
    return input.value;
  }

  // 4. Text content (for buttons, links)
  const text = el.textContent?.trim();
  if (text && text.length < 100) return text;

  // 5. Placeholder
  if (input.placeholder) return input.placeholder;

  // 6. title
  const title = el.getAttribute('title');
  if (title) return title;

  // 7. alt (for images inside buttons)
  const img = el.querySelector('img');
  if (img?.alt) return img.alt;

  return '';
}

function buildA11ySelector(el: HTMLElement): string {
  if (el.id && !el.id.match(/^\d/)) return `#${CSS.escape(el.id)}`;
  const name = (el as HTMLInputElement).name;
  if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return `[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
  // Fallback to role
  const role = el.getAttribute('role');
  if (role) {
    const roleEls = document.querySelectorAll(`[role="${role}"]`);
    const idx = Array.from(roleEls).indexOf(el);
    return idx >= 0 ? `[role="${role}"]:nth-of-type(${idx + 1})` : `[role="${role}"]`;
  }
  return el.tagName.toLowerCase();
}

function getRoleFromNativeTag(tag: string, inputType?: string): string {
  if (tag === 'button' || inputType === 'submit' || inputType === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'input') {
    if (inputType === 'checkbox') return 'checkbox';
    if (inputType === 'radio') return 'radio';
    if (inputType === 'range') return 'slider';
    return 'textbox';
  }
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  return 'generic';
}

function mapRoleToTag(role: string): string {
  const MAP: Record<string, string> = {
    navigation: 'nav', main: 'main', search: 'search',
    banner: 'header', contentinfo: 'footer', form: 'form',
  };
  return MAP[role] ?? `[role="${role}"]`;
}
