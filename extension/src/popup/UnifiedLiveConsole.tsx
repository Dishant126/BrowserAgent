/**
 * PrivSight — UnifiedLiveConsole
 *
 * Unified single-view interface combining:
 * 1. Live Session Chat (multi-turn conversation, action confirmation, bottom prompt bar)
 * 2. Live Inspector & Real-time Stats (Total redactions, steps, zero raw data guarantee, execution trace)
 * 3. Prominent in-chat Total Redaction summaries & Sanitized Screenshot preview cards
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type {
  TaskState,
  SiteStatus,
  BrowserAction,
  ChatMessage,
  TraceEvent,
} from '../utils/types';

export interface StepInfo {
  step: number;
  label: string;
  status: string;
  action?: BrowserAction;
  latencyMs?: number;
  model?: string;
  confidence?: number;
  timestamp?: number;
}

const TASK_STATE_LABELS: Record<TaskState, string> = {
  IDLE: 'Ready',
  SCANNING: '🔍 Scanning DOM…',
  VISION_PROCESSING: '🧠 Vision Model…',
  PRIVACY_PROCESSING: '🛡 Redacting Locally…',
  THINKING: '🤖 AI Reasoning…',
  WAITING_FOR_CONFIRMATION: '✋ Awaiting Confirm',
  EXECUTING: '▶ Executing…',
  VERIFYING: '⏳ Verifying…',
  COMPLETED: '✅ Completed',
  ERROR: '⚠ Task Error',
  UNDERSTANDING: '🧠 Understanding…',
  PERCEIVING: '🔵 Perceiving…',
  SANITIZING: '🟣 Sanitizing…',
  PLANNING: '🤖 Reasoning…',
  VALIDATING: '🔍 Validating…',
  WAITING_FOR_PAGE: '⏳ Waiting…',
  RE_PERCEIVING: '🔄 Re-perceiving…',
  PRIVACY_BLOCKED: '🛑 Privacy Blocked',
  ACTION_INVALID: '⚠ Action Invalid',
  LOW_CONFIDENCE: '🟡 Low Confidence',
  UNSUPPORTED_SITE: '⊘ Unsupported Site',
  USER_REQUIRED: '👤 User Input Required',
};

const TASK_STATE_COLORS: Record<TaskState, string> = {
  IDLE: '#10b981',
  SCANNING: '#22d3ee',
  VISION_PROCESSING: '#a78bfa',
  PRIVACY_PROCESSING: '#c084fc',
  THINKING: '#60a5fa',
  WAITING_FOR_CONFIRMATION: '#f59e0b',
  EXECUTING: '#3b82f6',
  VERIFYING: '#94a3b8',
  COMPLETED: '#10b981',
  ERROR: '#ef4444',
  UNDERSTANDING: '#a78bfa',
  PERCEIVING: '#22d3ee',
  SANITIZING: '#c084fc',
  PLANNING: '#60a5fa',
  VALIDATING: '#34d399',
  WAITING_FOR_PAGE: '#94a3b8',
  RE_PERCEIVING: '#22d3ee',
  PRIVACY_BLOCKED: '#dc2626',
  ACTION_INVALID: '#ef4444',
  LOW_CONFIDENCE: '#f59e0b',
  UNSUPPORTED_SITE: '#64748b',
  USER_REQUIRED: '#f59e0b',
};

function formatPill(pill?: string | { action: string; target?: string; confidence?: number }): string {
  if (!pill) return '';
  if (typeof pill === 'string') return pill;
  const conf = pill.confidence != null ? ` ${Math.round(pill.confidence * 100)}%` : '';
  return `${pill.action.toUpperCase()} ${pill.target || ''}${conf}`.trim();
}

/** Rich Screenshot & Redaction card displayed directly inside the chat feed */
function RedactedScreenshotBubble({
  msg,
  onImageClick,
}: {
  msg: ChatMessage;
  onImageClick: (src: string) => void;
}) {
  const piiCount = msg.piiCount ?? 0;
  const totalRedacted = msg.totalPiiRedacted ?? piiCount;
  const piiTypes = msg.piiTypes || [];

  return (
    <div style={{ padding: '4px 6px' }}>
      <div style={{
        borderRadius: 10,
        overflow: 'hidden',
        border: '1px solid #1e3a5f',
        background: 'linear-gradient(180deg, #0d1e38 0%, #081224 100%)',
        boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
      }}>
        {/* Header with Total Redaction badge */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 10px',
          background: 'linear-gradient(90deg, #091a35 0%, #0f274a 100%)',
          borderBottom: '1px solid #1e3a5f',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13 }}>🛡️</span>
            <span style={{ fontSize: 10, fontWeight: 800, color: '#38bdf8', letterSpacing: '0.3px' }}>
              SANITIZED SCREENSHOT
            </span>
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: totalRedacted > 0 ? '#f59e0b22' : '#10b98122',
            border: `1px solid ${totalRedacted > 0 ? '#f59e0b66' : '#10b98166'}`,
            borderRadius: 6,
            padding: '2px 7px',
          }}>
            <span style={{ fontSize: 9, fontWeight: 800, color: totalRedacted > 0 ? '#fbbf24' : '#34d399' }}>
              {totalRedacted > 0 ? `🛡️ ${totalRedacted} Redactions` : '✓ 0 Raw PII Sent'}
            </span>
          </div>
        </div>

        {/* Screenshot Image Preview with click-to-zoom */}
        <div
          onClick={() => msg.screenshot && onImageClick(msg.screenshot)}
          style={{
            position: 'relative',
            cursor: 'pointer',
            background: '#040914',
            overflow: 'hidden',
          }}
          title="Click to view enlarged screenshot"
        >
          <img
            src={msg.screenshot}
            alt="Sanitized page preview"
            style={{
              width: '100%',
              maxHeight: 115,
              objectFit: 'cover',
              display: 'block',
              transition: 'transform 0.2s ease',
            }}
          />
          <div style={{
            position: 'absolute',
            bottom: 6,
            right: 8,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(4px)',
            borderRadius: 4,
            padding: '2px 6px',
            fontSize: 8,
            color: '#94a3b8',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            border: '1px solid rgba(255,255,255,0.1)',
          }}>
            <span>🔍 Click to inspect</span>
          </div>
        </div>

        {/* Breakdown of detected/redacted categories */}
        {piiTypes.length > 0 && (
          <div style={{
            padding: '4px 8px',
            background: '#07101f',
            borderTop: '1px solid #14243b',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 8, color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>
              Redacted:
            </span>
            {piiTypes.map((type, idx) => (
              <span
                key={idx}
                style={{
                  fontSize: 8,
                  fontFamily: 'monospace',
                  background: '#f59e0b18',
                  color: '#fbbf24',
                  border: '1px solid #f59e0b33',
                  borderRadius: 3,
                  padding: '1px 5px',
                  textTransform: 'uppercase',
                }}
              >
                {type}
              </span>
            ))}
          </div>
        )}

        {/* Privacy Assurance Footer */}
        <div style={{
          padding: '4px 10px',
          fontSize: 8,
          color: '#64748b',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: '#050c18',
          borderTop: '1px solid #14243b',
        }}>
          <span style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>🔒</span> Sanitized on-device · raw pixels never transmitted
          </span>
          <span style={{ color: '#38bdf8', fontFamily: 'monospace' }}>YOLOS-Tiny WebGPU</span>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({
  msg,
  onApprove,
  onCancel,
  onRescan,
  onImageClick,
}: {
  msg: ChatMessage;
  onApprove: (actionId: string) => void;
  onCancel: (actionId: string) => void;
  onRescan: () => void;
  onImageClick: (src: string) => void;
}) {
  if (msg.kind === 'screenshot') {
    return <RedactedScreenshotBubble msg={msg} onImageClick={onImageClick} />;
  }

  if (msg.kind === 'user') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', padding: '3px 8px' }}>
        <span style={{ fontSize: 8, color: '#38bdf8', fontWeight: 700, textTransform: 'uppercase', marginBottom: 2 }}>
          USER
        </span>
        <div style={{
          background: 'linear-gradient(135deg, #0284c7, #0369a1)',
          color: '#ffffff',
          borderRadius: '12px 12px 2px 12px',
          padding: '7px 12px',
          maxWidth: '85%',
          fontSize: 11,
          lineHeight: 1.45,
          boxShadow: '0 2px 8px rgba(2,132,199,0.25)',
        }}>
          {msg.text}
        </div>
      </div>
    );
  }

  if (msg.kind === 'confirmation') {
    const actionId = msg.actionId || '';
    const isDecided = msg.confirmed === 'yes' || msg.confirmed === true || msg.confirmed === 'no' || msg.confirmed === false;
    const isApproved = msg.confirmed === 'yes' || msg.confirmed === true;
    const pillText = formatPill(msg.actionPill);
    return (
      <div style={{ padding: '4px 8px' }}>
        <div style={{
          background: 'linear-gradient(135deg, #1a2333, #0f172a)',
          border: '1px solid #f59e0b',
          borderRadius: 8,
          padding: '9px 12px',
          boxShadow: '0 4px 16px rgba(245,158,11,0.15)',
        }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', marginBottom: 3 }}>
            ✋ User Confirmation Required
          </div>
          <div style={{ fontSize: 11, color: '#e2e8f0', lineHeight: 1.4, marginBottom: 6 }}>
            {msg.text || 'Target action identified. Shall I proceed?'}
          </div>
          {pillText && (
            <div style={{
              display: 'inline-block',
              fontSize: 9,
              fontFamily: 'monospace',
              background: '#082f49',
              color: '#38bdf8',
              border: '1px solid #0369a1',
              padding: '2px 6px',
              borderRadius: 4,
              marginBottom: 6,
            }}>
              {pillText}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            {isDecided ? (
              <span style={{ fontSize: 10, fontWeight: 700, color: isApproved ? '#10b981' : '#f87171' }}>
                {isApproved ? '✓ Approved by you' : '✕ Cancelled by you'}
              </span>
            ) : (
              <>
                <button
                  onClick={() => onApprove(actionId)}
                  style={{
                    flex: 1.2,
                    background: '#10b981',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 5,
                    padding: '6px 0',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  ✓ Yes, execute
                </button>
                <button
                  onClick={() => onCancel(actionId)}
                  style={{
                    flex: 1,
                    background: '#334155',
                    color: '#cbd5e1',
                    border: 'none',
                    borderRadius: 5,
                    padding: '6px 0',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  ✕ Cancel
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (msg.kind === 'error') {
    return (
      <div style={{ padding: '4px 8px' }}>
        <div style={{
          background: '#1c1017',
          border: '1px solid #ef4444',
          borderRadius: 8,
          padding: '8px 10px',
          color: '#fca5a5',
          fontSize: 10,
          lineHeight: 1.4,
        }}>
          <strong>⚠ Notice:</strong> {msg.text}
          <div style={{ marginTop: 6 }}>
            <button
              onClick={onRescan}
              style={{
                background: '#7f1d1d',
                color: '#fee2e2',
                border: '1px solid #b91c1c',
                borderRadius: 4,
                padding: '3px 8px',
                fontSize: 9,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              🔄 Rescan Page
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (msg.kind === 'assistant') {
    const pillText = formatPill(msg.actionPill);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '3px 8px' }}>
        <span style={{ fontSize: 8, color: '#22d3ee', fontWeight: 700, textTransform: 'uppercase', marginBottom: 2 }}>
          🤖 PRIVSIGHT AGENT
        </span>
        <div style={{
          background: '#0f1e3a',
          color: '#e2e8f0',
          border: '1px solid #1e3a5f',
          borderRadius: '2px 12px 12px 12px',
          padding: '8px 12px',
          maxWidth: '88%',
          fontSize: 11,
          lineHeight: 1.45,
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        }}>
          {msg.text}
          {pillText && (
            <div style={{
              display: 'inline-block',
              marginTop: 5,
              fontSize: 9,
              fontFamily: 'monospace',
              background: '#082f49',
              color: '#38bdf8',
              border: '1px solid #0369a1',
              padding: '2px 6px',
              borderRadius: 4,
            }}>
              {pillText}
            </div>
          )}
        </div>
      </div>
    );
  }

  // status message
  return (
    <div style={{ padding: '2px 8px', display: 'flex', justifyContent: 'center' }}>
      <span style={{
        fontSize: 9,
        color: '#64748b',
        padding: '2px 8px',
        background: 'rgba(255,255,255,0.03)',
        borderRadius: 10,
      }}>
        {msg.text}
      </span>
    </div>
  );
}

export function UnifiedLiveConsole() {
  const [taskState, setTaskState] = useState<TaskState>('IDLE');
  const [promptText, setPromptText] = useState('');
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepInfo[]>([]);
  const [auditEvents, setAuditEvents] = useState<any[]>([]);
  const [siteStatus, setSiteStatus] = useState<SiteStatus | null>(null);
  const [currentTabUrl, setCurrentTabUrl] = useState('');
  const [autoShowPanel, setAutoShowPanel] = useState<boolean>(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [totalRedactions, setTotalRedactions] = useState<number>(0);
  const [showInspectorDrawer, setShowInspectorDrawer] = useState<boolean>(false);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);

  const chatScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
      if (!res) return;
      if (res.taskState) setTaskState(res.taskState);
      if (res.steps?.length) setSteps(res.steps);
      if (res.siteStatus) setSiteStatus(res.siteStatus);
      if (res.chatMessages?.length) setChatMessages(res.chatMessages);
      if (res.totalPiiRedacted != null) setTotalRedactions(res.totalPiiRedacted);
      if (res.traceEvents?.length) setAuditEvents(res.traceEvents.slice(-15).reverse());
      if (res.taskState && !['IDLE', 'COMPLETED', 'ERROR'].includes(res.taskState)) {
        setRunning(true);
      }
    });

    chrome.storage.local.get(['auditLog', 'autoShowFloatingPanel'], (r) => {
      if (r.auditLog && r.auditLog.length > 0) {
        setAuditEvents(r.auditLog.slice(-15).reverse());
      }
      setAutoShowPanel(!!r.autoShowFloatingPanel);
    });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.url) setCurrentTabUrl(tab.url);
    });

    const listener = (msg: any) => {
      if (!msg?.type) return;

      if (msg.type === 'STATUS_UPDATE' || msg.type === 'TASK_STATE_CHANGE') {
        const state: TaskState = msg.taskState ?? 'IDLE';
        setTaskState(state);
        setRunning(!['IDLE', 'COMPLETED', 'ERROR', 'PRIVACY_BLOCKED'].includes(state));
      }

      if (msg.type === 'CHAT_MESSAGE') {
        setChatMessages((prev) => [...prev, msg.message]);
        if (msg.message.totalPiiRedacted != null) {
          setTotalRedactions(msg.message.totalPiiRedacted);
        } else if (msg.message.piiCount != null) {
          setTotalRedactions((prev) => Math.max(prev, msg.message.piiCount));
        }
      }

      if (msg.type === 'CHAT_HISTORY') {
        setChatMessages(msg.messages || []);
        if (msg.messages?.length === 0) {
          setTotalRedactions(0);
        }
      }

      if (msg.type === 'STEP_UPDATE') {
        setSteps((prev) => {
          const idx = prev.findIndex((s) => s.step === msg.step);
          const entry: StepInfo = {
            step: msg.step,
            label: msg.label,
            status: msg.status,
            action: msg.action,
            latencyMs: msg.latencyMs,
            model: msg.model,
            confidence: msg.confidence,
            timestamp: Date.now(),
          };
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = entry;
            return next;
          }
          return [...prev, entry];
        });
      }

      if (msg.type === 'TRACE_EVENT') {
        setAuditEvents((prev) => [msg.event, ...prev].slice(0, 20));
      }

      if (msg.type === 'TASK_DONE') {
        setRunning(false);
        setTaskState('IDLE');
      }

      if (msg.type === 'SITE_STATUS') {
        setSiteStatus(msg.siteStatus);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chatMessages, showInspectorDrawer]);

  const sendPrompt = useCallback(async () => {
    const text = promptText.trim();
    if (!text || running) return;
    setPromptText('');
    setRunning(true);
    setTaskState('SCANNING');

    let tabId: number | undefined;
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tabId = tabs[0]?.id;
    } catch {}

    chrome.runtime.sendMessage(
      {
        type: 'START_TASK',
        instruction: text,
        tabId,
      },
      (res) => {
        if (!res?.ok) {
          setRunning(false);
          setTaskState('IDLE');
        }
      }
    );
  }, [promptText, running]);

  const stopTask = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'STOP_TASK' });
    setRunning(false);
    setTaskState('IDLE');
  }, []);

  const handleClearChat = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'CLEAR_CHAT' });
    setChatMessages([]);
    setTotalRedactions(0);
    setSteps([]);
  }, []);

  const handleApprove = useCallback((actionId: string) => {
    chrome.runtime.sendMessage({
      type: 'ACTION_APPROVAL_RESPONSE',
      actionId,
      approved: true,
    });
  }, []);

  const handleCancel = useCallback((actionId: string) => {
    chrome.runtime.sendMessage({
      type: 'ACTION_APPROVAL_RESPONSE',
      actionId,
      approved: false,
    });
  }, []);

  const handleRescan = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'RESCAN_PAGE' });
  }, []);

  const handleToggleOnPagePanel = useCallback(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_FLOATING_PANEL', show: true });
      }
    });
    window.close();
  }, []);

  const handleToggleAutoShow = useCallback((enabled: boolean) => {
    setAutoShowPanel(enabled);
    chrome.storage.local.set({ autoShowFloatingPanel: enabled });
  }, []);

  const stateColor = TASK_STATE_COLORS[taskState] ?? '#10b981';
  const stateLabel = TASK_STATE_LABELS[taskState] ?? 'Ready';
  const hostClean = currentTabUrl ? new URL(currentTabUrl).hostname.replace(/^www\./, '') : 'Active Tab';

  return (
    <div style={{
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      width: '100%',
      height: '100%',
      background: '#070d18',
      color: '#e2e8f0',
      display: 'flex',
      flexDirection: 'column',
      boxSizing: 'border-box',
      overflow: 'hidden',
      position: 'relative',
      minHeight: 0,
    }}>
      {/* 1. Header Bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '7px 10px',
        borderBottom: '1px solid #16253d',
        background: 'linear-gradient(135deg, #0d1b30 0%, #081120 100%)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: 'linear-gradient(135deg, #22d3ee, #2563eb)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            boxShadow: '0 2px 8px rgba(34,211,238,0.25)',
          }}>
            🛡️
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 12, color: '#ffffff', letterSpacing: '-0.2px' }}>
              PrivSight
            </div>
            <div style={{ fontSize: 8.5, color: '#64748b' }}>
              Live Session &amp; Privacy Console
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            fontSize: 8.5,
            color: stateColor,
            fontWeight: 700,
            background: `${stateColor}18`,
            padding: '2px 7px',
            borderRadius: 5,
            border: `1px solid ${stateColor}44`,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}>
            <span style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: stateColor,
              boxShadow: `0 0 5px ${stateColor}`,
            }} />
            {stateLabel}
          </div>
        </div>
      </div>

      {/* 2. Unified Navigation / Context Bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '5px 10px',
        background: '#091527',
        borderBottom: '1px solid #16253d',
        fontSize: 9.5,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#94a3b8' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#10b981' }} />
          <span>Site: <strong style={{ color: '#e2e8f0' }}>{hostClean}</strong></span>
          {siteStatus?.adapterName && (
            <span style={{
              fontSize: 7.5,
              color: '#38bdf8',
              background: '#0284c722',
              padding: '1px 4px',
              borderRadius: 3,
              border: '1px solid #0284c744',
            }}>
              {siteStatus.adapterName}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <button
            onClick={() => setShowInspectorDrawer(!showInspectorDrawer)}
            style={{
              background: showInspectorDrawer ? '#0284c7' : '#14233c',
              color: showInspectorDrawer ? '#ffffff' : '#94a3b8',
              border: '1px solid #1e3a5f',
              borderRadius: 4,
              padding: '2px 6px',
              fontSize: 8.5,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 3,
            }}
            title="Toggle execution steps & privacy trace"
          >
            <span>⚙ Inspector</span>
            <span style={{
              background: showInspectorDrawer ? '#0369a1' : '#1e3352',
              color: '#e2e8f0',
              borderRadius: 8,
              padding: '0 3px',
              fontSize: 7.5,
            }}>
              {steps.length}
            </span>
          </button>
          <button
            onClick={handleClearChat}
            style={{
              background: 'none',
              border: 'none',
              color: '#64748b',
              fontSize: 8.5,
              cursor: 'pointer',
              padding: '2px 4px',
            }}
          >
            Clear
          </button>
        </div>
      </div>

      {/* 3. Live Stats Bar — Always Visible Together with Chat */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr 1fr',
        gap: 4,
        padding: '5px 8px',
        background: '#050d1a',
        borderBottom: '1px solid #16253d',
        flexShrink: 0,
      }}>
        {/* Metric 1: Total Redacted */}
        <div style={{
          background: totalRedactions > 0 ? '#1b2317' : '#0a162b',
          border: `1px solid ${totalRedactions > 0 ? '#10b98155' : '#1e3a5f'}`,
          borderRadius: 5,
          padding: '3px 4px',
          textAlign: 'center',
          boxShadow: totalRedactions > 0 ? '0 0 8px rgba(16,185,129,0.1)' : 'none',
        }}>
          <div style={{
            fontSize: 12,
            fontWeight: 800,
            color: totalRedactions > 0 ? '#10b981' : '#f59e0b',
            fontFamily: 'monospace',
            lineHeight: 1.1,
          }}>
            {totalRedactions}
          </div>
          <div style={{ fontSize: 7, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>
            PII Redacted
          </div>
        </div>

        {/* Metric 2: Steps Run */}
        <div style={{
          background: '#0a162b',
          border: '1px solid #1e3a5f',
          borderRadius: 5,
          padding: '3px 4px',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: '#22d3ee', fontFamily: 'monospace', lineHeight: 1.1 }}>
            {steps.length}
          </div>
          <div style={{ fontSize: 7, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>
            Steps Run
          </div>
        </div>

        {/* Metric 3: Raw Sent (0 Bytes) */}
        <div style={{
          background: '#0a162b',
          border: '1px solid #1e3a5f',
          borderRadius: 5,
          padding: '3px 4px',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: '#10b981', fontFamily: 'monospace', lineHeight: 1.1 }}>
            0 B
          </div>
          <div style={{ fontSize: 7, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>
            Raw Sent
          </div>
        </div>

        {/* Metric 4: Vision Engine */}
        <div style={{
          background: '#0a162b',
          border: '1px solid #1e3a5f',
          borderRadius: 5,
          padding: '3px 4px',
          textAlign: 'center',
        }}>
          <div style={{
            fontSize: 9.5,
            fontWeight: 700,
            color: '#a78bfa',
            fontFamily: 'monospace',
            lineHeight: 1.3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            YOLOS-Tiny
          </div>
          <div style={{ fontSize: 7, color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>
            WebGPU
          </div>
        </div>
      </div>

      {/* 4. Docked / Collapsible Inspector Drawer (Shown in-line) */}
      {showInspectorDrawer && (
        <div style={{
          maxHeight: 170,
          background: '#040a16',
          borderBottom: '2px solid #0284c7',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          flexShrink: 0,
        }}>
          <div style={{
            padding: '5px 10px',
            background: '#081527',
            borderBottom: '1px solid #16253d',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 9,
            fontWeight: 700,
            color: '#38bdf8',
          }}>
            <span>⚙ EXECUTION TRACE &amp; AUDIT LOG</span>
            <span style={{ color: '#64748b' }}>{auditEvents.length} events logged</span>
          </div>

          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            {/* Steps Column */}
            <div style={{
              flex: 1,
              borderRight: '1px solid #16253d',
              overflowY: 'auto',
              maxHeight: 140,
            }}>
              <div style={{
                padding: '3px 8px',
                fontSize: 8,
                fontWeight: 700,
                color: '#64748b',
                textTransform: 'uppercase',
                background: '#070f1e',
              }}>
                Actions ({steps.length})
              </div>
              {steps.length === 0 ? (
                <div style={{ padding: '8px', fontSize: 9, color: '#475569', textAlign: 'center' }}>
                  No actions executed yet
                </div>
              ) : (
                steps.map((s, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: '4px 8px',
                      borderBottom: '1px solid #091324',
                      fontSize: 9,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span style={{
                      background: '#0284c722',
                      color: '#38bdf8',
                      border: '1px solid #0284c744',
                      borderRadius: 3,
                      padding: '0 4px',
                      fontSize: 7.5,
                      fontFamily: 'monospace',
                      fontWeight: 700,
                    }}>
                      #{s.step} {s.action?.action || 'step'}
                    </span>
                    <span style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: '#cbd5e1',
                    }}>
                      {s.label}
                    </span>
                    {s.latencyMs && (
                      <span style={{ fontSize: 7.5, color: '#64748b', fontFamily: 'monospace' }}>
                        {s.latencyMs}ms
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Trace Events Column */}
            <div style={{ flex: 1.2, overflowY: 'auto', maxHeight: 140 }}>
              <div style={{
                padding: '3px 8px',
                fontSize: 8,
                fontWeight: 700,
                color: '#64748b',
                textTransform: 'uppercase',
                background: '#070f1e',
              }}>
                Privacy &amp; Pipeline Events
              </div>
              {auditEvents.length === 0 ? (
                <div style={{ padding: '8px', fontSize: 9, color: '#475569', textAlign: 'center' }}>
                  Awaiting events…
                </div>
              ) : (
                auditEvents.slice(0, 15).map((ev, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: '3px 8px',
                      borderBottom: '1px solid #091324',
                      fontSize: 8.5,
                      display: 'flex',
                      gap: 4,
                      alignItems: 'flex-start',
                    }}
                  >
                    <span style={{ color: '#22d3ee', fontFamily: 'monospace', fontSize: 7.5 }}>
                      {ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : 'now'}
                    </span>
                    <span style={{
                      flex: 1,
                      color: ev.type?.includes('PII') ? '#fbbf24' : '#94a3b8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {ev.detail || ev.type}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 5. Live Session Chat Feed */}
      <div
        ref={chatScrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '6px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          background: 'radial-gradient(ellipse at top, #09152a 0%, #050b16 100%)',
        }}
      >
        {chatMessages.length === 0 ? (
          <div style={{
            margin: 'auto 0',
            padding: '8px 6px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}>
            <div style={{
              background: 'linear-gradient(135deg, #0d1e3a 0%, #071326 100%)',
              border: '1px solid #1e3a5f',
              borderRadius: 12,
              padding: '12px 12px 10px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
              textAlign: 'center',
            }}>
              <div style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                background: 'linear-gradient(135deg, #0284c7, #2563eb)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                boxShadow: '0 3px 12px rgba(2,132,199,0.3)',
                marginBottom: 6,
              }}>
                🛡️
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.2px', marginBottom: 2 }}>
                PrivSight Copilot
              </div>
              <div style={{ fontSize: 9, color: '#94a3b8', lineHeight: 1.35, marginBottom: 8 }}>
                On-device PII masking with local vision AI. Zero raw pixels leave your browser.
              </div>

              {/* 3 Privacy Pillars */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr',
                gap: 4,
                padding: '6px 0',
                borderTop: '1px solid #162a45',
                borderBottom: '1px solid #162a45',
                marginBottom: 8,
              }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 12 }}>🔒</div>
                  <div style={{ fontSize: 7.5, fontWeight: 700, color: '#38bdf8' }}>0 B Egress</div>
                  <div style={{ fontSize: 6.5, color: '#64748b' }}>PII Blocked</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 12 }}>⚡</div>
                  <div style={{ fontSize: 7.5, fontWeight: 700, color: '#a78bfa' }}>YOLOS-Tiny</div>
                  <div style={{ fontSize: 6.5, color: '#64748b' }}>WebGPU AI</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 12 }}>✋</div>
                  <div style={{ fontSize: 7.5, fontWeight: 700, color: '#34d399' }}>You Decide</div>
                  <div style={{ fontSize: 6.5, color: '#64748b' }}>Confirm Steps</div>
                </div>
              </div>

              {/* Quick Prompts */}
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontSize: 8, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', marginBottom: 5 }}>
                  Suggested Actions for {hostClean}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {[
                    hostClean.includes('pdf') ? 'Find Merge PDF button' : 'Inspect interactive elements',
                    hostClean.includes('pdf') ? 'Compress PDF file' : 'Search for login options',
                    'Click on navigation menu',
                  ].map((suggestion, i) => (
                    <button
                      key={i}
                      onClick={() => setPromptText(suggestion)}
                      style={{
                        background: '#0a172c',
                        border: '1px solid #1e3a5f',
                        borderRadius: 5,
                        padding: '5px 8px',
                        color: '#38bdf8',
                        fontSize: 9,
                        textAlign: 'left',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span>"{suggestion}"</span>
                      <span style={{ fontSize: 9, color: '#64748b' }}>→</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          chatMessages.map((msg) => (
            <ChatBubble
              key={msg.id}
              msg={msg}
              onApprove={handleApprove}
              onCancel={handleCancel}
              onRescan={handleRescan}
              onImageClick={(src) => setExpandedImage(src)}
            />
          ))
        )}
      </div>

      {/* 6. Prompt Input Bar */}
      <div style={{
        padding: '6px 8px',
        background: '#081324',
        borderTop: '1px solid #16253d',
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        flexShrink: 0,
      }}>
        <input
          type="text"
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendPrompt()}
          placeholder="Type instruction... (e.g. Find Merge PDF)"
          disabled={running}
          style={{
            flex: 1,
            background: '#050d1a',
            border: '1px solid #1e3a5f',
            borderRadius: 6,
            padding: '7px 10px',
            color: '#ffffff',
            fontSize: 10.5,
            outline: 'none',
            opacity: running ? 0.6 : 1,
          }}
        />
        {running ? (
          <button
            onClick={stopTask}
            style={{
              background: 'linear-gradient(135deg, #dc2626, #991b1b)',
              color: '#fecaca',
              border: 'none',
              borderRadius: 6,
              padding: '7px 10px',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            ■ Stop
          </button>
        ) : (
          <button
            onClick={sendPrompt}
            disabled={!promptText.trim()}
            style={{
              background: promptText.trim()
                ? 'linear-gradient(135deg, #0284c7, #0891b2)'
                : '#1e293b',
              color: '#ffffff',
              border: 'none',
              borderRadius: 6,
              padding: '7px 12px',
              fontSize: 10,
              fontWeight: 700,
              cursor: promptText.trim() ? 'pointer' : 'not-allowed',
              opacity: promptText.trim() ? 1 : 0.5,
              boxShadow: promptText.trim() ? '0 2px 8px rgba(2,132,199,0.3)' : 'none',
            }}
          >
            Send
          </button>
        )}
      </div>

      {/* 7. Bottom Utilities Bar */}
      <div style={{
        padding: '4px 10px',
        borderTop: '1px solid #142238',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: '#060d19',
        fontSize: 8.5,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <a
            href="http://localhost:5173"
            target="_blank"
            rel="noreferrer"
            style={{ color: '#22d3ee', textDecoration: 'none', fontWeight: 600 }}
          >
            Dashboard →
          </a>
          <button
            onClick={handleToggleOnPagePanel}
            style={{
              background: '#14233c',
              color: '#38bdf8',
              border: '1px solid #1e3a5f',
              borderRadius: 4,
              padding: '2px 7px',
              fontSize: 8.5,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Launch Floating Panel
          </button>
        </div>
        <div>
          <label style={{ fontSize: 9, color: '#64748b', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoShowPanel}
              onChange={(e) => handleToggleAutoShow(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            Auto-open
          </label>
        </div>
      </div>

      {/* 8. Lightbox Zoom Modal for Screenshot */}
      {expandedImage && (
        <div
          onClick={() => setExpandedImage(null)}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(6px)',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 12,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '95%',
              maxHeight: '90%',
              background: '#091528',
              border: '1px solid #1e3a5f',
              borderRadius: 10,
              overflow: 'hidden',
              boxShadow: '0 8px 30px rgba(0,0,0,0.8)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '8px 12px',
              background: '#0d1e38',
              borderBottom: '1px solid #1e3a5f',
            }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#38bdf8' }}>
                🛡️ Sanitized Preview Inspection
              </span>
              <button
                onClick={() => setExpandedImage(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#94a3b8',
                  fontSize: 14,
                  cursor: 'pointer',
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ overflow: 'auto', padding: 4 }}>
              <img
                src={expandedImage}
                alt="Enlarged sanitized preview"
                style={{ maxWidth: '100%', maxHeight: '420px', objectFit: 'contain', display: 'block' }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
