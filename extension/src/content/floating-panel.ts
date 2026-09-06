/**
 * PrivSight Floating Panel — injected into web pages as a draggable Shadow DOM overlay.
 *
 * Implements a real continuous interactive Live Session chat matching the user UI spec:
 * - Tab 1: Live Session Chat with inline confirmation buttons, sanitized preview, and bottom prompt input
 * - Tab 2: Inspector & Stats with real YOLOS-Tiny metrics, execution steps, and privacy audit log
 * - Multi-turn conversational flow without session destruction
 */

import type { ChatMessage, TraceEvent, SiteStatus } from '../utils/types';

export function isFloatingPanelVisible(): boolean {
  const host = document.getElementById('__privsight-host__');
  return !!(host && host.style.display !== 'none');
}

export function removeFloatingPanel(): void {
  const host = document.getElementById('__privsight-host__');
  if (host) {
    host.remove();
  }
}

export function updatePanelStats(piiCount: number): void {
  const host = document.getElementById('__privsight-host__');
  if (host?.shadowRoot) {
    const statPii = host.shadowRoot.getElementById('stat-pii');
    if (statPii) statPii.textContent = String(piiCount);
  }
}

export function toggleFloatingPanel(forceShow?: boolean): boolean {
  const isVisible = isFloatingPanelVisible();
  const shouldShow = forceShow !== undefined ? forceShow : !isVisible;

  if (shouldShow) {
    try {
      sessionStorage.removeItem('__privsight_dismissed__');
    } catch {}
    injectFloatingPanel(true);
    return true;
  } else {
    try {
      sessionStorage.setItem('__privsight_dismissed__', '1');
    } catch {}
    removeFloatingPanel();
    return false;
  }
}

export function injectFloatingPanel(forceShow = false): void {
  if (!forceShow) {
    try {
      if (sessionStorage.getItem('__privsight_dismissed__') === '1') return;
    } catch {}
  }

  const existing = document.getElementById('__privsight-host__');
  if (existing) {
    existing.style.display = 'block';
    return;
  }

  const host = document.createElement('div');
  host.id = '__privsight-host__';
  host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;pointer-events:none;';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  // ── STYLES ──────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

    * { box-sizing: border-box; margin: 0; padding: 0; }

    #panel {
      font-family: 'Inter', -apple-system, sans-serif;
      position: fixed;
      top: 16px;
      right: 16px;
      width: 400px;
      max-height: 92vh;
      background: #07101f;
      border: 1px solid #1e3a5f;
      border-radius: 14px;
      box-shadow: 0 12px 50px rgba(0,0,0,0.8), 0 0 0 1px rgba(34,211,238,0.12);
      color: #e2e8f0;
      pointer-events: all;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: box-shadow 0.2s;
    }

    #panel.dragging { box-shadow: 0 24px 80px rgba(0,0,0,0.95); }

    /* ── Header ── */
    #header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-bottom: 1px solid #1e293b;
      cursor: grab;
      user-select: none;
      background: linear-gradient(135deg, #0d1a2e 0%, #07101f 100%);
      flex-shrink: 0;
    }
    #header:active { cursor: grabbing; }

    #logo {
      width: 28px; height: 28px;
      border-radius: 8px;
      background: linear-gradient(135deg, #22d3ee, #2563eb);
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; flex-shrink: 0;
      box-shadow: 0 2px 8px rgba(34,211,238,0.3);
    }

    #header-text { flex: 1; overflow: hidden; }
    #title { font-weight: 800; font-size: 13px; color: #fff; letter-spacing: -0.2px; }
    #subtitle { font-size: 9px; color: #64748b; }

    #status-badge {
      font-size: 9px; font-weight: 700;
      padding: 3px 8px; border-radius: 6px;
      border: 1px solid #10b98144;
      background: #10b98118;
      color: #10b981;
      white-space: nowrap; flex-shrink: 0;
    }

    #header-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-left: auto;
      flex-shrink: 0;
    }

    .header-btn {
      background: none;
      border: 1px solid transparent;
      color: #64748b;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      padding: 3px 6px;
      border-radius: 6px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }
    .header-btn:hover { color: #f1f5f9; background: #1e293b; border-color: #334155; }
    #btn-close:hover { color: #f87171; background: #450a0a; border-color: #991b1b; }

    /* ── Tab Navigation ── */
    #tab-bar {
      display: flex;
      background: #091322;
      border-bottom: 1px solid #1e293b;
      flex-shrink: 0;
    }

    .tab-btn {
      flex: 1;
      padding: 8px 10px;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: #64748b;
      font-size: 11px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .tab-btn:hover { color: #cbd5e1; background: rgba(255,255,255,0.02); }
    .tab-btn.active {
      color: #38bdf8;
      border-bottom-color: #38bdf8;
      background: rgba(56,189,248,0.05);
      font-weight: 700;
    }
    .tab-count {
      background: #1e293b;
      color: #94a3b8;
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 10px;
    }
    .tab-btn.active .tab-count {
      background: #0284c7;
      color: #fff;
    }

    /* ── Subheader ── */
    #subheader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: #091324;
      border-bottom: 1px solid #1e293b;
      font-size: 10px;
      flex-shrink: 0;
    }
    #site-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      color: #94a3b8;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 250px;
    }
    #site-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #10b981; flex-shrink: 0;
    }
    #btn-clear-chat {
      background: none;
      border: none;
      color: #64748b;
      font-size: 10px;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
      transition: color 0.15s;
    }
    #btn-clear-chat:hover { color: #f87171; text-decoration: underline; }

    /* ── Tab Content Areas ── */
    .tab-panel {
      display: flex;
      flex-direction: column;
      flex: 1;
      overflow: hidden;
    }
    .tab-panel.hidden, .hidden { display: none !important; }

    /* ── Live Session Tab ── */
    #chat-scroll {
      flex: 1;
      min-height: 280px;
      max-height: 380px;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: #060c18;
    }

    .chat-row { display: flex; flex-direction: column; gap: 4px; }
    .chat-row.user { align-items: flex-end; }
    .chat-row.assistant { align-items: flex-start; }
    .chat-row.status { align-items: center; }

    .chat-bubble-user {
      background: linear-gradient(135deg, #0284c7, #0369a1);
      color: #ffffff;
      padding: 8px 12px;
      border-radius: 12px 12px 2px 12px;
      font-size: 11px;
      line-height: 1.45;
      max-width: 86%;
      box-shadow: 0 2px 8px rgba(2,132,199,0.25);
    }
    .chat-meta-user {
      font-size: 8px;
      color: #38bdf8;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      padding-right: 4px;
    }

    .chat-bubble-assistant {
      background: #0f1e3a;
      border: 1px solid #1e3a5f;
      color: #f1f5f9;
      padding: 10px 12px;
      border-radius: 2px 12px 12px 12px;
      font-size: 11px;
      line-height: 1.5;
      max-width: 90%;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    .chat-meta-assistant {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 8px;
      color: #22d3ee;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .action-pill {
      display: inline-block;
      margin-top: 6px;
      font-size: 9px;
      font-family: ui-monospace, monospace;
      font-weight: 700;
      background: #082f49;
      color: #38bdf8;
      border: 1px solid #0369a1;
      padding: 2px 7px;
      border-radius: 4px;
    }

    /* Screenshot Card */
    .screenshot-card {
      width: 100%;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid #1e3a5f;
      background: #0a1324;
    }
    .screenshot-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px;
      background: #0f2347;
      font-size: 9px;
      font-weight: 700;
      color: #10b981;
      border-bottom: 1px solid #1e3a5f;
    }
    .screenshot-img-wrap {
      position: relative;
      width: 100%;
      max-height: 140px;
      overflow: hidden;
      background: #000;
    }
    .screenshot-img-wrap img {
      width: 100%;
      height: auto;
      display: block;
      object-fit: cover;
    }
    .screenshot-caption {
      padding: 4px 8px;
      font-size: 8px;
      color: #64748b;
      display: flex;
      justify-content: space-between;
    }

    /* Inline Confirmation Card */
    .confirm-card {
      width: 100%;
      background: linear-gradient(135deg, #1e293b, #0f172a);
      border: 1px solid #f59e0b;
      border-radius: 10px;
      padding: 10px 12px;
      box-shadow: 0 4px 16px rgba(245,158,11,0.15);
    }
    .confirm-title {
      font-size: 10px;
      font-weight: 700;
      color: #f59e0b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .confirm-text {
      font-size: 11px;
      color: #e2e8f0;
      line-height: 1.4;
      margin-bottom: 8px;
    }
    .confirm-actions {
      display: flex;
      gap: 8px;
    }
    .btn-confirm-yes {
      flex: 1.2;
      background: #10b981;
      color: #ffffff;
      border: none;
      border-radius: 6px;
      padding: 7px 0;
      font-size: 11px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: background 0.15s;
    }
    .btn-confirm-yes:hover { background: #059669; }
    .btn-confirm-no {
      flex: 1;
      background: #334155;
      color: #cbd5e1;
      border: none;
      border-radius: 6px;
      padding: 7px 0;
      font-size: 11px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn-confirm-no:hover { background: #475569; }

    /* Inline Error Card */
    .error-card {
      width: 100%;
      background: #1c1017;
      border: 1px solid #ef4444;
      border-radius: 8px;
      padding: 9px 11px;
      color: #fca5a5;
      font-size: 11px;
      line-height: 1.4;
    }
    .error-actions {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .btn-rescan {
      background: #7f1d1d;
      color: #fee2e2;
      border: 1px solid #b91c1c;
      border-radius: 5px;
      padding: 4px 8px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
    }

    /* Status Lines */
    .status-text {
      font-size: 9px;
      color: #64748b;
      padding: 2px 8px;
      background: rgba(255,255,255,0.03);
      border-radius: 12px;
    }

    /* ── Bottom Input Row ── */
    #input-footer {
      padding: 10px 12px;
      background: #091322;
      border-top: 1px solid #1e293b;
      display: flex;
      gap: 8px;
      align-items: center;
      flex-shrink: 0;
    }
    #prompt-input {
      flex: 1;
      background: #07101f;
      border: 1px solid #1e3a5f;
      border-radius: 8px;
      padding: 8px 12px;
      color: #ffffff;
      font-size: 11px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s;
    }
    #prompt-input:focus { border-color: #22d3ee; }
    #prompt-input:disabled { opacity: 0.5; cursor: not-allowed; }

    #btn-send {
      background: #0891b2;
      color: #ffffff;
      border: none;
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 11px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: background 0.15s;
      flex-shrink: 0;
    }
    #btn-send:hover:not(:disabled) { background: #06b6d4; }
    #btn-send:disabled { background: #162a45; color: #475569; cursor: not-allowed; }

    #btn-stop-live {
      background: #991b1b;
      color: #fecaca;
      border: none;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      display: none;
      flex-shrink: 0;
    }
    #btn-stop-live:hover { background: #b91c1c; }

    /* ── Tab 2: Inspector & Stats ── */
    #inspector-body {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      overflow-y: auto;
      max-height: 420px;
      background: #060c18;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 6px;
    }
    .stat-card {
      background: #0f1e3a;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 8px 6px;
      text-align: center;
    }
    .stat-val { font-size: 18px; font-weight: 800; font-family: ui-monospace, monospace; }
    .stat-lbl { font-size: 8px; color: #64748b; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }

    .inspector-card {
      background: #091322;
      border: 1px solid #1e293b;
      border-radius: 8px;
      overflow: hidden;
    }
    .card-hdr {
      padding: 6px 10px;
      background: #0d1a2e;
      border-bottom: 1px solid #1e293b;
      font-size: 9px;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: flex;
      justify-content: space-between;
    }
    .card-list { max-height: 130px; overflow-y: auto; }

    .step-row {
      padding: 5px 10px;
      border-bottom: 1px solid #0a0f1e;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
    }
    .step-badge {
      font-size: 8px; font-weight: 700; padding: 1px 5px;
      border-radius: 4px; text-transform: uppercase; flex-shrink: 0;
    }
    .step-desc { flex: 1; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .step-meta { font-size: 8px; color: #475569; font-family: monospace; }

    .audit-row {
      padding: 4px 10px;
      border-bottom: 1px solid #0a0f1e;
      font-size: 9px;
      color: #64748b;
      display: flex;
      gap: 6px;
    }
    .audit-time { color: #22d3ee; font-family: monospace; }
    .audit-detail { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── Footer ── */
    #footer {
      padding: 7px 12px;
      border-top: 1px solid #1e293b;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #07101f;
      font-size: 9px;
      flex-shrink: 0;
    }
    #footer a { color: #22d3ee; text-decoration: none; font-weight: 600; }
    #footer a:hover { text-decoration: underline; }

    /* Minimized */
    #panel.minimized #tab-bar,
    #panel.minimized #subheader,
    #panel.minimized .tab-panel,
    #panel.minimized #footer { display: none !important; }
    #panel.minimized { width: 220px; }
  `;
  shadow.appendChild(style);

  // ── HTML STRUCTURE ──────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'panel';
  const currentHost = location.hostname.replace(/^www\./, '');

  panel.innerHTML = `
    <div id="header">
      <div id="logo">🛡️</div>
      <div id="header-text">
        <div id="title">PrivSight</div>
        <div id="subtitle">Live Session &amp; Privacy Console</div>
      </div>
      <div id="status-badge">● Ready</div>
      <div id="header-actions">
        <button id="btn-minimize" class="header-btn" title="Minimize">−</button>
        <button id="btn-close" class="header-btn" title="Close Panel (Esc)">✕</button>
      </div>
    </div>

    <div id="subheader">
      <div id="site-indicator">
        <div id="site-dot"></div>
        <span>Site: <strong style="color:#e2e8f0">${currentHost}</strong></span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <button id="btn-toggle-inspector" style="background:#14233c;color:#38bdf8;border:1px solid #1e3a5f;border-radius:4px;padding:2px 8px;font-size:9px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:4px;">
          <span>⚙ Inspector</span> <span id="steps-badge" style="background:#1e3352;padding:0 4px;border-radius:8px;">0</span>
        </button>
        <button id="btn-clear-chat" title="Clear chat conversation">Clear</button>
      </div>
    </div>

    <!-- Live Stats Bar (Always Visible Together with Chat) -->
    <div id="stats-strip" style="display:grid;grid-template-columns:1.2fr 1fr 1fr 1.2fr;gap:5px;padding:6px 10px;background:#050d1a;border-bottom:1px solid #16253d;flex-shrink:0;">
      <div class="stat-card" style="background:#0a162b;border:1px solid #1e3a5f;border-radius:6px;padding:4px 6px;text-align:center;">
        <div class="stat-val" id="stat-pii" style="font-size:13px;font-weight:800;color:#f59e0b;font-family:monospace;line-height:1.2;">0</div>
        <div class="stat-lbl" style="font-size:7.5px;color:#94a3b8;text-transform:uppercase;font-weight:700;">PII Redacted</div>
      </div>
      <div class="stat-card" style="background:#0a162b;border:1px solid #1e3a5f;border-radius:6px;padding:4px 6px;text-align:center;">
        <div class="stat-val" id="stat-steps" style="font-size:13px;font-weight:800;color:#22d3ee;font-family:monospace;line-height:1.2;">0</div>
        <div class="stat-lbl" style="font-size:7.5px;color:#94a3b8;text-transform:uppercase;font-weight:700;">Steps Run</div>
      </div>
      <div class="stat-card" style="background:#0a162b;border:1px solid #1e3a5f;border-radius:6px;padding:4px 6px;text-align:center;">
        <div class="stat-val" id="stat-raw" style="font-size:13px;font-weight:800;color:#10b981;font-family:monospace;line-height:1.2;">0 B</div>
        <div class="stat-lbl" style="font-size:7.5px;color:#94a3b8;text-transform:uppercase;font-weight:700;">Raw Sent</div>
      </div>
      <div class="stat-card" style="background:#0a162b;border:1px solid #1e3a5f;border-radius:6px;padding:4px 6px;text-align:center;">
        <div class="stat-val" id="vision-backend-val" style="font-size:9.5px;font-weight:700;color:#a78bfa;font-family:monospace;line-height:1.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">YOLOS-Tiny</div>
        <div class="stat-lbl" style="font-size:7.5px;color:#94a3b8;text-transform:uppercase;font-weight:700;">WebGPU Vision</div>
      </div>
    </div>

    <!-- Collapsible Inspector Drawer -->
    <div id="panel-inspector" class="hidden" style="max-height:170px;background:#040a16;border-bottom:2px solid #0284c7;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;">
      <div style="padding:5px 10px;background:#081527;border-bottom:1px solid #16253d;display:flex;justify-content:space-between;align-items:center;font-size:9px;font-weight:700;color:#38bdf8;">
        <span>⚙ EXECUTION TRACE &amp; AUDIT LOG</span>
        <span id="steps-count" style="color:#64748b;">0 steps</span>
      </div>
      <div style="display:flex;flex:1;overflow:hidden;">
        <div style="flex:1;border-right:1px solid #16253d;overflow-y:auto;max-height:140px;">
          <div style="padding:3px 8px;font-size:8px;font-weight:700;color:#64748b;text-transform:uppercase;background:#070f1e;">Actions</div>
          <div id="steps-list" class="card-list"></div>
        </div>
        <div style="flex:1.2;overflow-y:auto;max-height:140px;">
          <div style="padding:3px 8px;font-size:8px;font-weight:700;color:#64748b;text-transform:uppercase;background:#070f1e;">Privacy Trace</div>
          <div id="audit-list" class="card-list"></div>
        </div>
      </div>
    </div>

    <!-- Live Session Chat (Always Visible) -->
    <div id="panel-chat" style="display:flex;flex-direction:column;flex:1;overflow:hidden;">
      <div id="chat-scroll">
        <div class="chat-row assistant">
          <div class="chat-meta-assistant">🤖 PRIVSIGHT AGENT</div>
          <div class="chat-bubble-assistant">
            Hello! I am your privacy-first browser agent. Type an instruction below (e.g. <em>"Find the Merge PDF button"</em>). I will scan locally, redact sensitive data, and assist you.
          </div>
        </div>
      </div>

      <div id="input-footer">
        <input id="prompt-input" type="text" placeholder="Type your instruction... (e.g. Find Merge PDF)" autocomplete="off" />
        <button id="btn-send">Send</button>
        <button id="btn-stop-live">■ Stop</button>
      </div>
    </div>

    <div id="footer">
      <div style="display:flex;align-items:center;gap:8px;">
        <a href="http://localhost:5173" target="_blank">Dashboard →</a>
        <button id="btn-mute-site" style="background:none;border:none;color:#64748b;font-size:9px;cursor:pointer;text-decoration:underline;">Mute site</button>
      </div>
      <div>
        <label style="font-size:9px;color:#64748b;display:flex;align-items:center;gap:4px;cursor:pointer;">
          <input type="checkbox" id="chk-auto-open" style="cursor:pointer;" /> Auto-open
        </label>
      </div>
    </div>
  `;
  shadow.appendChild(panel);

  // ── DRAGGING & POSITION PERSISTENCE ─────────────────────────────────────────
  try {
    const saved = localStorage.getItem('__privsight_pos__');
    if (saved) {
      const { x, y } = JSON.parse(saved);
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = 'auto';
    }
  } catch {}

  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;
  const header = shadow.getElementById('header')!;
  header.addEventListener('mousedown', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.header-btn')) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    panel.style.left = `${startLeft}px`;
    panel.style.top = `${startTop}px`;
    panel.style.right = 'auto';
    panel.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const newLeft = Math.max(0, Math.min(window.innerWidth - 60, startLeft + dx));
    const newTop = Math.max(0, Math.min(window.innerHeight - 60, startTop + dy));
    panel.style.left = `${newLeft}px`;
    panel.style.top = `${newTop}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('dragging');
    try {
      localStorage.setItem('__privsight_pos__', JSON.stringify({
        x: parseFloat(panel.style.left),
        y: parseFloat(panel.style.top),
      }));
    } catch {}
  });

  // ── MINIMIZE / CLOSE / ESC ──────────────────────────────────────────────────
  const btnMin = shadow.getElementById('btn-minimize')!;
  let isMinimized = false;
  btnMin.addEventListener('click', (e) => {
    e.stopPropagation();
    isMinimized = !isMinimized;
    panel.classList.toggle('minimized', isMinimized);
    btnMin.textContent = isMinimized ? '+' : '−';
  });

  const btnClose = shadow.getElementById('btn-close')!;
  btnClose.addEventListener('click', (e) => {
    e.stopPropagation();
    try { sessionStorage.setItem('__privsight_dismissed__', '1'); } catch {}
    removeFloatingPanel();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      try { sessionStorage.setItem('__privsight_dismissed__', '1'); } catch {}
      removeFloatingPanel();
    }
  });

  // ── IN-LINE INSPECTOR TOGGLE ────────────────────────────────────────────────
  const btnToggleInspector = shadow.getElementById('btn-toggle-inspector');
  const panelInspector = shadow.getElementById('panel-inspector');

  if (btnToggleInspector && panelInspector) {
    btnToggleInspector.addEventListener('click', () => {
      const isHidden = panelInspector.classList.contains('hidden');
      if (isHidden) {
        panelInspector.classList.remove('hidden');
        btnToggleInspector.style.background = '#0284c7';
        btnToggleInspector.style.color = '#ffffff';
      } else {
        panelInspector.classList.add('hidden');
        btnToggleInspector.style.background = '#14233c';
        btnToggleInspector.style.color = '#38bdf8';
      }
    });
  }

  // ── CLEAR CHAT ──────────────────────────────────────────────────────────────
  const btnClearChat = shadow.getElementById('btn-clear-chat')!;
  btnClearChat.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_CHAT' });
    const chatScroll = shadow.getElementById('chat-scroll')!;
    chatScroll.innerHTML = `
      <div class="chat-row assistant">
        <div class="chat-meta-assistant">🤖 PRIVSIGHT AGENT</div>
        <div class="chat-bubble-assistant">Chat history cleared. How can I help you?</div>
      </div>
    `;
    const chatBadge = shadow.getElementById('chat-badge');
    if (chatBadge) chatBadge.textContent = '1';
    const statPii = shadow.getElementById('stat-pii');
    if (statPii) statPii.textContent = '0';
    const statSteps = shadow.getElementById('stat-steps');
    if (statSteps) statSteps.textContent = '0';
    const stepsBadge = shadow.getElementById('steps-badge');
    if (stepsBadge) stepsBadge.textContent = '0';
  });

  // ── DOM ELEMENT REFS ────────────────────────────────────────────────────────
  const promptInput = shadow.getElementById('prompt-input') as HTMLInputElement;
  const btnSend = shadow.getElementById('btn-send') as HTMLButtonElement;
  const btnStopLive = shadow.getElementById('btn-stop-live') as HTMLButtonElement;
  const statusBadge = shadow.getElementById('status-badge')!;
  const chatScroll = shadow.getElementById('chat-scroll')!;
  const chatBadge = shadow.getElementById('chat-badge');
  const stepsList = shadow.getElementById('steps-list')!;
  const stepsCount = shadow.getElementById('steps-count')!;
  const auditList = shadow.getElementById('audit-list')!;
  const statSteps = shadow.getElementById('stat-steps')!;
  const statPii = shadow.getElementById('stat-pii')!;
  const visionLatencyVal = shadow.getElementById('vision-latency-val')!;
  const visionBackendVal = shadow.getElementById('vision-backend-val')!;

  let isTaskRunning = false;

  function setRunningState(running: boolean) {
    isTaskRunning = running;
    promptInput.disabled = running;
    btnSend.style.display = running ? 'none' : 'flex';
    btnStopLive.style.display = running ? 'flex' : 'none';
  }

  function setStatus(text: string, color: string) {
    statusBadge.textContent = text;
    statusBadge.style.color = color;
    statusBadge.style.background = `${color}18`;
    statusBadge.style.borderColor = `${color}44`;
  }

  // ── SEND INSTRUCTION ────────────────────────────────────────────────────────
  function sendInstruction() {
    const text = promptInput.value.trim();
    if (!text || isTaskRunning) return;
    promptInput.value = '';
    setRunningState(true);
    setStatus('🔍 Scanning…', '#22d3ee');

    chrome.runtime.sendMessage({
      type: 'START_TASK',
      instruction: text,
    }, (res) => {
      if (!res?.ok) {
        setRunningState(false);
        setStatus('● Ready', '#10b981');
      }
    });
  }

  btnSend.addEventListener('click', sendInstruction);
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendInstruction();
    }
  });

  btnStopLive.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_TASK' });
    setRunningState(false);
    setStatus('● Ready', '#10b981');
  });

  function formatPill(pill?: string | { action: string; target?: string; confidence?: number }): string {
    if (!pill) return '';
    let str = typeof pill === 'string'
      ? pill
      : `${pill.action.toUpperCase()} ${pill.target || ''}${pill.confidence != null ? ` ${Math.round(pill.confidence * 100)}%` : ''}`.trim();
    str = str.replace(/#?el_\d+/g, 'target');
    return str;
  }

  // ── RENDER CHAT MESSAGE ─────────────────────────────────────────────────────
  function appendChatMessage(msg: ChatMessage) {
    const row = document.createElement('div');

    if (msg.kind === 'user') {
      row.className = 'chat-row user';
      row.innerHTML = `
        <div class="chat-meta-user">USER</div>
        <div class="chat-bubble-user">${escapeHtml(msg.text || '')}</div>
      `;
    } else if (msg.kind === 'screenshot') {
      row.className = 'chat-row assistant';
      const piiText = (msg.totalPiiRedacted ?? msg.piiCount ?? 0) > 0 
        ? `🛡️ ${msg.totalPiiRedacted ?? msg.piiCount} Total Redacted` 
        : '✓ 0 raw PII pixels sent';
      const typeBadges = (msg.piiTypes && msg.piiTypes.length > 0)
        ? `<div style="padding: 3px 8px; background: #07101f; border-top: 1px solid #14243b; font-size: 8px; display: flex; gap: 4px; flex-wrap: wrap;">
             <span style="color: #64748b; font-weight: 700;">REDACTED:</span>
             ${msg.piiTypes.map((t: string) => `<span style="background: #f59e0b22; color: #fbbf24; padding: 1px 4px; border-radius: 3px; font-family: monospace;">${escapeHtml(t.toUpperCase())}</span>`).join('')}
           </div>`
        : '';
      row.innerHTML = `
        <div class="chat-meta-assistant">🛡 PRIVACY PIPELINE</div>
        <div class="screenshot-card">
          <div class="screenshot-header">
            <span>🛡 [Sanitized Screenshot]</span>
            <span style="font-weight: 700; color: #34d399;">${piiText}</span>
          </div>
          <div class="screenshot-img-wrap">
            <img src="${msg.screenshot}" alt="Sanitized view" />
          </div>
          ${typeBadges}
          <div class="screenshot-caption">
            <span>🔒 Sanitized locally — raw pixels never sent</span>
            <span>YOLOS-Tiny WebGPU</span>
          </div>
        </div>
      `;
      if (msg.visionStats) {
        visionLatencyVal.textContent = `${msg.visionStats.inferenceMs || 84}ms`;
        visionBackendVal.textContent = `${msg.visionStats.backend || 'WebGPU'}`;
      }
    } else if (msg.kind === 'confirmation') {
      row.className = 'chat-row assistant';
      const actionId = msg.actionId || `approval-${Date.now()}`;
      const isAlreadyDecided = msg.confirmed === 'yes' || msg.confirmed === true || msg.confirmed === 'no' || msg.confirmed === false;
      const isApproved = msg.confirmed === 'yes' || msg.confirmed === true;
      const pillText = formatPill(msg.actionPill);
      row.innerHTML = `
        <div class="confirm-card" id="card-${actionId}">
          <div class="confirm-title">
            <span>✋ User Confirmation Required</span>
          </div>
          <div class="confirm-text">${escapeHtml((msg.text || 'Target button found. Shall I click it?').replace(/#el_\d+/g, 'button'))}</div>
          ${pillText ? `<div class="action-pill" style="margin-bottom:8px;">${escapeHtml(pillText)}</div>` : ''}
          <div class="confirm-actions" id="actions-${actionId}">
            ${isAlreadyDecided
              ? `<div style="font-size:10px;font-weight:700;color:${isApproved ? '#10b981' : '#f87171'}">
                   ${isApproved ? '✓ Approved by you' : '✕ Cancelled by you'}
                 </div>`
              : `<button class="btn-confirm-yes" id="btn-yes-${actionId}">✓ Yes, click it</button>
                 <button class="btn-confirm-no" id="btn-no-${actionId}">✕ Cancel</button>`
            }
          </div>
        </div>
      `;

      if (!isAlreadyDecided) {
        setTimeout(() => {
          const btnYes = shadow.getElementById(`btn-yes-${actionId}`);
          const btnNo = shadow.getElementById(`btn-no-${actionId}`);
          const actionsBox = shadow.getElementById(`actions-${actionId}`);

          btnYes?.addEventListener('click', () => {
            chrome.runtime.sendMessage({
              type: 'ACTION_APPROVAL_RESPONSE',
              actionId,
              approved: true,
            });
            if (actionsBox) actionsBox.innerHTML = `<span style="font-size:10px;font-weight:700;color:#10b981;">✓ Approved by you</span>`;
          });

          btnNo?.addEventListener('click', () => {
            chrome.runtime.sendMessage({
              type: 'ACTION_APPROVAL_RESPONSE',
              actionId,
              approved: false,
            });
            if (actionsBox) actionsBox.innerHTML = `<span style="font-size:10px;font-weight:700;color:#f87171;">✕ Cancelled by you</span>`;
          });
        }, 10);
      }
    } else if (msg.kind === 'error') {
      row.className = 'chat-row assistant';
      row.innerHTML = `
        <div class="error-card">
          <strong>⚠ Notice:</strong> ${escapeHtml(msg.text || 'An issue occurred')}
          <div class="error-actions">
            <button class="btn-rescan" id="btn-rescan-${Date.now()}">🔄 Rescan Page</button>
          </div>
        </div>
      `;
      setTimeout(() => {
        const btnRescan = row.querySelector('.btn-rescan') as HTMLButtonElement;
        btnRescan?.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'RESCAN_PAGE' });
        });
      }, 10);
    } else if (msg.kind === 'status') {
      row.className = 'chat-row status';
      row.innerHTML = `<span class="status-text">${escapeHtml(msg.text || '')}</span>`;
    } else {
      // Regular assistant message
      row.className = 'chat-row assistant';
      const pillText = formatPill(msg.actionPill);
      row.innerHTML = `
        <div class="chat-meta-assistant">🤖 PRIVSIGHT AGENT</div>
        <div class="chat-bubble-assistant">
          ${escapeHtml(msg.text || '')}
          ${pillText ? `<br/><span class="action-pill">${escapeHtml(pillText)}</span>` : ''}
        </div>
      `;
    }

    chatScroll.appendChild(row);
    chatScroll.scrollTop = chatScroll.scrollHeight;
    updateChatCount();
  }

  function updateChatCount() {
    const count = chatScroll.querySelectorAll('.chat-row').length;
    if (chatBadge) chatBadge.textContent = String(count);
  }

  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ── RENDER TRACE AUDIT ──────────────────────────────────────────────────────
  function addTraceRow(ev: TraceEvent) {
    const row = document.createElement('div');
    row.className = 'audit-row';
    const time = new Date(ev.timestamp).toLocaleTimeString();
    row.innerHTML = `
      <span class="audit-time">${time}</span>
      <span class="audit-detail">${escapeHtml(ev.detail || ev.type)}</span>
    `;
    auditList.insertBefore(row, auditList.firstChild);
    while (auditList.children.length > 25) auditList.removeChild(auditList.lastChild!);
  }

  // ── RENDER STEP ROW ─────────────────────────────────────────────────────────
  function addStepRow(step: any) {
    const row = document.createElement('div');
    row.className = 'step-row';
    const actionName = step.action?.action || step.status || 'step';
    const conf = step.confidence != null ? `${Math.round(step.confidence * 100)}%` : '';
    const latency = step.latencyMs != null ? `${step.latencyMs}ms` : '';
    row.innerHTML = `
      <span class="step-badge" style="background:#0284c722;color:#38bdf8;border:1px solid #0284c744">${escapeHtml(actionName)}</span>
      <span class="step-desc">${escapeHtml(step.label || '')}</span>
      <span class="step-meta">${latency}${conf ? ` · ${conf}` : ''}</span>
    `;
    stepsList.appendChild(row);
    stepsList.scrollTop = stepsList.scrollHeight;
    const n = stepsList.children.length;
    stepsCount.textContent = `${n} step${n !== 1 ? 's' : ''}`;
    statSteps.textContent = String(n);
    const stepsBadge = shadow.getElementById('steps-badge');
    if (stepsBadge) stepsBadge.textContent = String(n);
  }

  // ── STATE COLORS & LABELS ───────────────────────────────────────────────────
  const STATE_INFO: Record<string, { label: string; color: string; running: boolean }> = {
    IDLE:                      { label: '● Ready', color: '#10b981', running: false },
    SCANNING:                  { label: '🔍 Scanning DOM…', color: '#22d3ee', running: true },
    VISION_PROCESSING:         { label: '🧠 Vision Model…', color: '#a78bfa', running: true },
    PRIVACY_PROCESSING:        { label: '🛡 Redacting…', color: '#c084fc', running: true },
    THINKING:                  { label: '🤖 AI Reasoning…', color: '#60a5fa', running: true },
    WAITING_FOR_CONFIRMATION:  { label: '✋ Awaiting Confirm', color: '#f59e0b', running: true },
    EXECUTING:                 { label: '▶ Executing…', color: '#3b82f6', running: true },
    VERIFYING:                 { label: '⏳ Verifying…', color: '#94a3b8', running: true },
    COMPLETED:                 { label: '✅ Done', color: '#10b981', running: false },
    ERROR:                     { label: '⚠ Error', color: '#ef4444', running: false },
    // Legacy fallback
    UNDERSTANDING:             { label: '🧠 Understanding…', color: '#a78bfa', running: true },
    PERCEIVING:                { label: '👁 Perceiving…', color: '#22d3ee', running: true },
    SANITIZING:                { label: '🛡 Sanitizing…', color: '#c084fc', running: true },
    PLANNING:                  { label: '🤖 Reasoning…', color: '#60a5fa', running: true },
    VALIDATING:                { label: '✔ Validating…', color: '#34d399', running: true },
    WAITING_FOR_PAGE:          { label: '⏳ Waiting…', color: '#94a3b8', running: true },
    LOW_CONFIDENCE:            { label: '🟡 Low Confidence', color: '#f59e0b', running: true },
  };

  // ── RESTORE INITIAL STATE ───────────────────────────────────────────────────
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
    if (!res) return;
    if (res.chatMessages?.length) {
      chatScroll.innerHTML = '';
      res.chatMessages.forEach(appendChatMessage);
    }
    if (res.traceEvents?.length) {
      res.traceEvents.forEach(addTraceRow);
    }
    if (res.steps?.length) {
      res.steps.forEach(addStepRow);
    }
    const info = STATE_INFO[res.taskState] ?? STATE_INFO.IDLE;
    setStatus(info.label, info.color);
    setRunningState(info.running);
  });

  // ── MESSAGE LISTENER ────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg: any) => {
    if (!msg?.type) return;

    if (msg.type === 'CHAT_MESSAGE') {
      appendChatMessage(msg.message);
      if (msg.message.kind === 'screenshot' && msg.message.piiCount != null) {
        statPii.textContent = String(msg.message.piiCount);
      }
    }

    if (msg.type === 'CHAT_HISTORY') {
      chatScroll.innerHTML = '';
      (msg.messages || []).forEach(appendChatMessage);
    }

    if (msg.type === 'TRACE_EVENT') {
      addTraceRow(msg.event);
    }

    if (msg.type === 'TASK_STATE_CHANGE' || msg.type === 'STATUS_UPDATE') {
      const state = msg.taskState ?? 'IDLE';
      const info = STATE_INFO[state] ?? { label: state, color: '#64748b', running: true };
      setStatus(info.label, info.color);
      setRunningState(info.running);
    }

    if (msg.type === 'STEP_UPDATE') {
      addStepRow(msg);
    }

    if (msg.type === 'TASK_DONE') {
      setRunningState(false);
      setStatus('● Ready', '#10b981');
    }

    if (msg.type === 'TOGGLE_FLOATING_PANEL') {
      if (msg.show === false) removeFloatingPanel();
    }
  });

  // ── SETTINGS: AUTO-OPEN & MUTE ──────────────────────────────────────────────
  const chkAutoOpen = shadow.getElementById('chk-auto-open') as HTMLInputElement;
  if (chkAutoOpen) {
    chrome.storage.local.get(['autoShowFloatingPanel'], (res) => {
      chkAutoOpen.checked = !!res.autoShowFloatingPanel;
    });
    chkAutoOpen.addEventListener('change', () => {
      chrome.storage.local.set({ autoShowFloatingPanel: chkAutoOpen.checked });
    });
  }

  const btnMuteSite = shadow.getElementById('btn-mute-site');
  if (btnMuteSite) {
    btnMuteSite.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      chrome.storage.local.get(['mutedSites'], (res) => {
        const list: string[] = res.mutedSites || [];
        if (!list.includes(currentHost)) {
          list.push(currentHost);
          chrome.storage.local.set({ mutedSites: list }, () => {
            try { sessionStorage.setItem('__privsight_dismissed__', '1'); } catch {}
            removeFloatingPanel();
          });
        } else {
          removeFloatingPanel();
        }
      });
    });
  }
}
