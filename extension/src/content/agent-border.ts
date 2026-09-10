/**
 * Antigravity-Style Agent Activity Border
 *
 * Injects an isolated Shadow DOM overlay that displays a luminous, breathing blue border
 * and floating status badge around the active browser viewport while the agent is controlling
 * the browser.
 *
 * Features:
 * - Strictly pointer-events: none (zero interference with clicks, typing, or scrolling)
 * - Isolated Shadow DOM (#antigravity-browser-border) to prevent CSS leaks from web pages
 * - Visual state indicators:
 *     Active (blue / electric cyan)   -> Scanning, Vision, Reasoning, Executing, Verifying
 *     Human In The Loop (warm amber)  -> Waiting for User Confirmation / User Input
 *     Idle / Finished / Error        -> Smooth fade-out and unmount
 */

let borderHost: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let activeTaskState = 'IDLE';

const BORDER_STYLES = `
  :host {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    pointer-events: none !important;
    z-index: 2147483646 !important;
    margin: 0 !important;
    padding: 0 !important;
    border: none !important;
    background: transparent !important;
    box-sizing: border-box !important;
  }

  * {
    box-sizing: border-box !important;
    user-select: none !important;
    -webkit-user-select: none !important;
  }

  .agent-viewport-frame {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    border-radius: 0;
    transition: box-shadow 0.3s ease, border-color 0.3s ease, opacity 0.3s ease;
    opacity: 1;
  }

  /* Active Agent State — Luminous Antigravity Electric Blue */
  .agent-viewport-frame.state-active {
    border: 3.5px solid #2563eb;
    box-shadow:
      inset 0 0 0 1px rgba(147, 197, 253, 0.4),
      inset 0 0 22px rgba(37, 99, 235, 0.45),
      0 0 12px rgba(37, 99, 235, 0.35);
    animation: antigravityPulse 2.4s ease-in-out infinite;
  }

  /* Human Attention State — Warm Amber Glow */
  .agent-viewport-frame.state-attention {
    border: 3.5px solid #f59e0b;
    box-shadow:
      inset 0 0 0 1px rgba(253, 230, 138, 0.4),
      inset 0 0 24px rgba(245, 158, 11, 0.45),
      0 0 14px rgba(245, 158, 11, 0.35);
    animation: amberAttentionPulse 2s ease-in-out infinite;
  }

  @keyframes antigravityPulse {
    0%, 100% {
      border-color: #2563eb;
      box-shadow:
        inset 0 0 0 1px rgba(147, 197, 253, 0.4),
        inset 0 0 18px rgba(37, 99, 235, 0.40),
        0 0 10px rgba(37, 99, 235, 0.30);
    }
    50% {
      border-color: #38bdf8;
      box-shadow:
        inset 0 0 0 1.5px rgba(255, 255, 255, 0.6),
        inset 0 0 30px rgba(56, 189, 248, 0.65),
        0 0 18px rgba(56, 189, 248, 0.50);
    }
  }

  @keyframes amberAttentionPulse {
    0%, 100% {
      border-color: #f59e0b;
      box-shadow:
        inset 0 0 0 1px rgba(253, 230, 138, 0.4),
        inset 0 0 20px rgba(245, 158, 11, 0.40),
        0 0 10px rgba(245, 158, 11, 0.25);
    }
    50% {
      border-color: #fbbf24;
      box-shadow:
        inset 0 0 0 1.5px rgba(255, 255, 255, 0.6),
        inset 0 0 32px rgba(251, 191, 36, 0.65),
        0 0 18px rgba(251, 191, 36, 0.45);
    }
  }

  /* Floating Status Badge at Top Center */
  .agent-status-badge {
    position: fixed;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 14px 5px 10px;
    background: rgba(9, 14, 26, 0.88);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid rgba(56, 189, 248, 0.35);
    border-radius: 9999px;
    color: #f8fafc;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.3px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5), 0 0 14px rgba(37, 99, 235, 0.25);
    pointer-events: none;
    transition: all 0.25s ease;
  }

  .agent-status-badge.badge-attention {
    background: rgba(28, 19, 6, 0.90);
    border-color: rgba(245, 158, 11, 0.5);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5), 0 0 14px rgba(245, 158, 11, 0.3);
  }

  .pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #38bdf8;
    box-shadow: 0 0 8px #38bdf8;
    animation: dotPulse 1.4s ease-in-out infinite;
  }

  .pulse-dot.dot-attention {
    background: #fbbf24;
    box-shadow: 0 0 8px #fbbf24;
    animation: dotPulseAmber 1.4s ease-in-out infinite;
  }

  @keyframes dotPulse {
    0%, 100% { opacity: 0.8; transform: scale(0.9); }
    50% { opacity: 1; transform: scale(1.25); box-shadow: 0 0 12px #38bdf8; }
  }

  @keyframes dotPulseAmber {
    0%, 100% { opacity: 0.8; transform: scale(0.9); }
    50% { opacity: 1; transform: scale(1.25); box-shadow: 0 0 12px #fbbf24; }
  }

  .badge-tag {
    color: #94a3b8;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: 700;
    margin-right: 2px;
  }

  .badge-separator {
    color: #475569;
    font-size: 9px;
  }

  .badge-text {
    color: #e2e8f0;
    font-weight: 500;
    white-space: nowrap;
  }
`;

function getFriendlyStateLabel(taskState: string, detail?: string): { label: string; isAttention: boolean } {
  const s = (taskState || '').toUpperCase();

  if (s === 'WAITING_FOR_CONFIRMATION') {
    return { label: detail || 'Waiting for confirmation...', isAttention: true };
  }
  if (s === 'USER_REQUIRED') {
    return { label: detail || 'Human input required...', isAttention: true };
  }
  if (s === 'SCANNING') {
    return { label: 'Perceiving page & viewport...', isAttention: false };
  }
  if (s === 'VISION_PROCESSING') {
    return { label: 'Running on-device vision model...', isAttention: false };
  }
  if (s === 'PRIVACY_PROCESSING') {
    return { label: 'Redacting sensitive information...', isAttention: false };
  }
  if (s === 'THINKING') {
    return { label: 'AI reasoning next action...', isAttention: false };
  }
  if (s === 'EXECUTING') {
    return { label: detail || 'Executing action on page...', isAttention: false };
  }
  if (s === 'VERIFYING') {
    return { label: 'Verifying page changes...', isAttention: false };
  }
  if (s === 'WAITING_FOR_PAGE') {
    return { label: 'Waiting for page to load...', isAttention: false };
  }

  return { label: detail || 'Autonomous agent active', isAttention: false };
}

function ensureBorderHost(): ShadowRoot {
  if (borderHost && shadowRoot && document.documentElement.contains(borderHost)) {
    return shadowRoot;
  }

  // Remove stale host if any
  const existing = document.getElementById('__antigravity_agent_border__');
  if (existing) existing.remove();

  borderHost = document.createElement('div');
  borderHost.id = '__antigravity_agent_border__';
  document.documentElement.appendChild(borderHost);

  shadowRoot = borderHost.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = BORDER_STYLES;
  shadowRoot.appendChild(style);

  const frame = document.createElement('div');
  frame.className = 'agent-viewport-frame state-active';
  frame.id = 'frame';

  const badge = document.createElement('div');
  badge.className = 'agent-status-badge';
  badge.id = 'badge';
  badge.innerHTML = `
    <span class="pulse-dot" id="dot"></span>
    <span class="badge-tag">Antigravity Agent</span>
    <span class="badge-separator">•</span>
    <span class="badge-text" id="text">Active</span>
  `;

  shadowRoot.appendChild(frame);
  shadowRoot.appendChild(badge);

  return shadowRoot;
}

/**
 * Update or show the Antigravity agent border with the given task state.
 */
export function updateAgentBorder(taskState: string, detail?: string): void {
  activeTaskState = (taskState || '').toUpperCase();

  // If agent is idle, finished, or error, remove the border
  if (activeTaskState === 'IDLE' || activeTaskState === 'COMPLETED' || activeTaskState === 'DONE' || activeTaskState === 'ERROR') {
    removeAgentBorder();
    return;
  }

  const root = ensureBorderHost();
  const frame = root.getElementById('frame') as HTMLDivElement | null;
  const badge = root.getElementById('badge') as HTMLDivElement | null;
  const dot = root.getElementById('dot') as HTMLSpanElement | null;
  const text = root.getElementById('text') as HTMLSpanElement | null;

  if (!frame || !badge || !dot || !text) return;

  const { label, isAttention } = getFriendlyStateLabel(activeTaskState, detail);

  if (isAttention) {
    frame.className = 'agent-viewport-frame state-attention';
    badge.className = 'agent-status-badge badge-attention';
    dot.className = 'pulse-dot dot-attention';
  } else {
    frame.className = 'agent-viewport-frame state-active';
    badge.className = 'agent-status-badge';
    dot.className = 'pulse-dot';
  }

  text.textContent = label;
}

/**
 * Remove the agent border completely from the DOM.
 */
export function removeAgentBorder(): void {
  if (borderHost) {
    const frame = shadowRoot?.getElementById('frame');
    if (frame) {
      frame.style.opacity = '0';
      frame.style.transition = 'opacity 0.25s ease';
    }
    setTimeout(() => {
      if (borderHost) {
        borderHost.remove();
        borderHost = null;
        shadowRoot = null;
      }
    }, 250);
  }
}
