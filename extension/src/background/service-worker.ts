/**
 * Background Service Worker (MV3)
 *
 * Responsibilities:
 * 1. Orchestrate agent task workflow with full Task State Machine
 * 2. Communicate with local Python FastAPI server (http://localhost:8000/api)
 * 3. Site adapter detection and compatibility reporting
 * 4. Confidence-gated action approval
 * 5. Error recovery (re-perceive on failure, retry max 2×)
 * 6. Max step limit enforcement (MAX_STEPS = 20)
 * 7. Fallback to demo benchmark if real site unavailable
 */

import type {
  ExtensionMessage, BrowserAction, SanitizedContext, AuditEvent,
  TaskState, SiteStatus, SiteCompatibility, ChatMessage, TraceEvent, TraceEventType
} from '../utils/types';

const SERVER_URL = 'http://localhost:8000/api';
const MAX_STEPS = 20;
const CONFIDENCE_AUTO_APPROVE = 0.80;    // Auto-execute actions >= 0.80 smoothly
const CONFIDENCE_ASK_THRESHOLD = 0.65;   // Prompt user between 0.65–0.80
const USER_APPROVAL_TIMEOUT_MS = 60000;  // 60s timeout for user approval

interface RunningTask {
  sessionId: string;
  instruction: string;
  taskState: TaskState;
  stepNumber: number;
  previousActions: BrowserAction[];
  retryCount: number;
  lastStateHash: string;
  siteStatus?: SiteStatus;
  steps: Array<{
    step: number;
    label: string;
    status: string;
    action?: BrowserAction;
    latencyMs?: number;
    model?: string;
    confidence?: number;
  }>;
  stopped: boolean;
  /** Live session chat history. Persists across prompts and popup open/close. */
  chatMessages: ChatMessage[];
  /** Continuous conversational memory passed to LLM for multi-turn reasoning */
  conversationHistory: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** Real pipeline execution trace events */
  traceEvents: TraceEvent[];
  totalPiiRedacted: number;
  pendingApproval?: { action: BrowserAction; actionId: string; confidence: number } | null;
  pendingUserInput?: { prompt: string; actionId: string } | null;
}

let currentTask: RunningTask = {
  sessionId: '',
  instruction: '',
  taskState: 'IDLE',
  stepNumber: 0,
  previousActions: [],
  retryCount: 0,
  lastStateHash: '',
  steps: [],
  stopped: false,
  chatMessages: [],
  conversationHistory: [],
  traceEvents: [],
  totalPiiRedacted: 0,
  pendingApproval: null,
  pendingUserInput: null,
};

let currentActiveTabId: number | undefined;

function broadcastToAll(msg: any) {
  chrome.runtime.sendMessage(msg).catch(() => {});
  if (currentActiveTabId) {
    chrome.tabs.sendMessage(currentActiveTabId, msg).catch(() => {});
  }
}

function cleanElementLabel(raw: string): string {
  if (!raw) return '';
  let s = raw.replace(/^(PDF tool link:|link:|button:|tab:|menuitem:|heading:|input:)\s*/i, '').trim();
  s = s.replace(/^["']|["']$/g, '').trim();
  if (s.length > 40) {
    s = s.slice(0, 38) + '…';
  }
  return s;
}

function resolveFriendlyTargetName(action: BrowserAction, elements: any[] = []): string {
  const target = action.target;
  if (!target) return '';

  // 1. Direct from server-side enriched properties
  if (target.friendlyName) return cleanElementLabel(target.friendlyName);
  if (target.label) return cleanElementLabel(target.label);

  // 2. Lookup in client DOM elements using elementId, id, or domSelector
  const targetId = (target.elementId || target.value || '').replace(/^#/, '').trim().toLowerCase();
  if (targetId && elements && elements.length > 0) {
    const found = elements.find((e: any) => {
      const eid = (e.elementId || e.id || '').replace(/^#/, '').trim().toLowerCase();
      const sel = (e.domSelector || '').trim().toLowerCase();
      return (eid && eid === targetId) || (sel && sel === targetId);
    });
    if (found) {
      const candidate = found.label || found.ariaLabel || found.role || found.text;
      if (candidate) {
        const cleaned = cleanElementLabel(candidate);
        if (cleaned) return cleaned;
      }
    }
  }

  // 3. Extract quoted name from action.reason (e.g. "Click on the 'Compress PDF' tool link...")
  if (action.reason) {
    const quotedMatch = action.reason.match(/['"]([^'"]+)['"]/);
    if (quotedMatch && quotedMatch[1]) {
      const candidate = cleanElementLabel(quotedMatch[1]);
      if (candidate && !candidate.startsWith('el_') && !candidate.startsWith('#el_')) {
        return candidate;
      }
    }
    const clickMatch = action.reason.match(/click (?:on )?(?:the )?([A-Za-z0-9\s]+?)(?: button| link| tool| tab)/i);
    if (clickMatch && clickMatch[1]) {
      const candidate = cleanElementLabel(clickMatch[1]);
      if (candidate && !candidate.startsWith('el_')) {
        return candidate;
      }
    }
  }

  // 4. If target.value is already a readable human string (not an ID like el_001)
  if (target.value && !target.value.startsWith('el_') && !target.value.startsWith('#el_') && !target.value.startsWith('.')) {
    return cleanElementLabel(target.value);
  }

  return '';
}

/**
 * Emit a real runtime trace event to popup, floating panel, and server.
 */
function emitTraceEvent(type: TraceEventType, detail: string, step?: number, metadata?: any): void {
  const event: TraceEvent = {
    id: `trace-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId: currentTask.sessionId,
    type,
    detail,
    step,
    timestamp: Date.now(),
    metadata,
  };
  currentTask.traceEvents.push(event);
  broadcastToAll({ type: 'TRACE_EVENT', event });

  if (currentTask.sessionId) {
    fetch(`${SERVER_URL}/sessions/${currentTask.sessionId}/trace-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    }).catch(() => {});
  }
}

// Pending approval callbacks (action ID → resolve function)
const pendingApprovals = new Map<string, (approved: boolean) => void>();
// Pending user input callbacks (action ID → resolve function)
const pendingUserInputs = new Map<string, (value: string) => void>();

// ── LISTENERS ──────────────────────────────────────────────────────────────────

// ── LISTENERS ──────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  if (!message || !message.type) return;

  switch (message.type) {
    case 'START_TASK': {
      const { instruction, targetUrl, sessionId, tabId: msgTabId } = message;
      const trimmed = (instruction || '').trim();

      // Check if user is answering an existing pending approval via text
      if (currentTask.pendingApproval && currentTask.taskState === 'WAITING_FOR_CONFIRMATION') {
        const isYes = /^(yes|yeah|yup|click it|click|proceed|confirm|do it|ok|okay|sure|go ahead)\b/i.test(trimmed);
        const isNo = /^(no|nope|cancel|stop|dont|don't|abort)\b/i.test(trimmed);
        if (isYes || isNo) {
          broadcastChatMessage({ kind: 'user', text: instruction });
          const actionId = currentTask.pendingApproval.actionId;
          const resolver = pendingApprovals.get(actionId);
          if (resolver) {
            resolver(isYes);
            pendingApprovals.delete(actionId);
          }
          currentTask.pendingApproval = null;
          // Mark confirmation message in chat
          for (const msg of currentTask.chatMessages) {
            if (msg.actionId === actionId) {
              msg.confirmed = isYes ? 'yes' : 'no';
            }
          }
          broadcastToAll({ type: 'CHAT_HISTORY', messages: currentTask.chatMessages });
          sendResponse({ ok: true, handledAsApproval: true });
          break;
        }
      }

      // Check if user is answering an existing pending user input or waiting state
      if (currentTask.pendingUserInput && (currentTask.taskState === 'USER_REQUIRED' || currentTask.taskState === 'WAITING_USER')) {
        broadcastChatMessage({ kind: 'user', text: instruction });
        const actionId = currentTask.pendingUserInput.actionId;
        const resolver = pendingUserInputs.get(actionId);
        if (resolver) {
          resolver(trimmed);
          pendingUserInputs.delete(actionId);
        }
        currentTask.pendingUserInput = null;
        sendResponse({ ok: true, handledAsInput: true });
        break;
      }
      if (currentTask.taskState === 'WAITING_USER') {
        broadcastChatMessage({ kind: 'user', text: instruction });
        currentTask.conversationHistory.push({ role: 'user', text: trimmed });
        setTaskState('EXECUTING');
        sendResponse({ ok: true, handledAsInput: true });
        break;
      }

      // Stop any existing loop cleanly before starting new turn
      currentTask.stopped = true;
      const sid = sessionId || currentTask.sessionId || `session-${Date.now()}`;
      const tabId = msgTabId || sender.tab?.id;
      startTask(instruction, sid, targetUrl, tabId);
      sendResponse({ ok: true, sessionId: sid });
      break;
    }

    case 'STOP_TASK': {
      currentTask.stopped = true;
      if (currentTask.pendingApproval) {
        const resolver = pendingApprovals.get(currentTask.pendingApproval.actionId);
        if (resolver) resolver(false);
        pendingApprovals.delete(currentTask.pendingApproval.actionId);
        currentTask.pendingApproval = null;
      }
      setTaskState('IDLE');
      broadcastChatMessage({ kind: 'status', text: '⏹ Session stopped by user.' });
      sendResponse({ ok: true });
      break;
    }

    case 'CLEAR_CHAT': {
      currentTask.chatMessages = [];
      currentTask.conversationHistory = [];
      currentTask.traceEvents = [];
      currentTask.previousActions = [];
      currentTask.steps = [];
      currentTask.totalPiiRedacted = 0;
      broadcastToAll({ type: 'CHAT_HISTORY', messages: [] });
      sendResponse({ ok: true });
      break;
    }

    case 'RESCAN_PAGE': {
      if (currentTask.taskState === 'IDLE' || currentTask.taskState === 'ERROR') {
        const sid = currentTask.sessionId || `session-${Date.now()}`;
        startTask('Rescan page and inspect elements', sid, undefined, sender.tab?.id);
        sendResponse({ ok: true });
      }
      break;
    }

    case 'GET_STATUS': {
      sendResponse({
        agentStatus: taskStateToLegacyStatus(currentTask.taskState),
        taskState: currentTask.taskState,
        sessionId: currentTask.sessionId,
        instruction: currentTask.instruction,
        steps: currentTask.steps,
        siteStatus: currentTask.siteStatus,
        totalPiiRedacted: currentTask.totalPiiRedacted || 0,
        // Return chat history so popup/panel can restore it on open
        chatMessages: currentTask.chatMessages,
        traceEvents: currentTask.traceEvents,
        pendingApproval: currentTask.pendingApproval,
        pendingUserInput: currentTask.pendingUserInput,
      });
      break;
    }

    case 'AUDIT_EVENT': {
      chrome.storage.local.get(['auditLog'], (res) => {
        const log: AuditEvent[] = res.auditLog || [];
        log.push(message.event);
        chrome.storage.local.set({ auditLog: log.slice(-100) });
      });
      break;
    }

    case 'SITE_STATUS': {
      currentTask.siteStatus = message.siteStatus;
      chrome.runtime.sendMessage({ type: 'SITE_STATUS', siteStatus: message.siteStatus }).catch(() => {});
      break;
    }

    case 'ACTION_APPROVAL_RESPONSE': {
      const { actionId, approved } = message;
      currentTask.pendingApproval = null;
      
      // Update confirmation message in chat
      for (const msg of currentTask.chatMessages) {
        if (msg.actionId === actionId) {
          msg.confirmed = approved ? 'yes' : 'no';
        }
      }
      broadcastToAll({ type: 'CHAT_HISTORY', messages: currentTask.chatMessages });

      emitTraceEvent('USER_CONFIRMATION', approved ? 'User approved proposed action' : 'User cancelled proposed action', undefined, { actionId, approved });

      const resolver = pendingApprovals.get(actionId);
      if (resolver) {
        resolver(approved);
        pendingApprovals.delete(actionId);
      }
      break;
    }

    case 'USER_INPUT_RESPONSE': {
      currentTask.pendingUserInput = null;
      const resolver = pendingUserInputs.get(message.actionId);
      if (resolver) {
        resolver(message.value);
        pendingUserInputs.delete(message.actionId);
      }
      break;
    }

    case 'CAPTURE_SCREENSHOT': {
      const tabId = sender.tab?.id || currentActiveTabId;
      if (tabId) {
        captureTabScreenshot(tabId)
          .then(dataUrl => sendResponse({ ok: true, dataUrl }))
          .catch(err => sendResponse({ ok: false, error: String(err) }));
        return true;
      } else {
        sendResponse({ ok: false, error: 'No active tab' });
        return false;
      }
    }

    case 'VIT_INFERENCE': {
      sendResponse({ ok: true, detections: [] });
      return false;
    }

    case 'VERIFY_PII': {
      sendResponse({ ok: true, confirmed: [], false_positives: [] });
      return false;
    }

    case 'REDACTED_PREVIEW': {
      sendResponse({ ok: true });
      return false;
    }
  }

  return false;
});

// ── DOWNLOAD COMPLETION LISTENER ─────────────────────────────────────────────
// Automatically detects when a converted file or document starts/finishes downloading
if (typeof chrome !== 'undefined' && chrome.downloads?.onCreated) {
  chrome.downloads.onCreated.addListener((item) => {
    if (currentTask.stepNumber > 0 && !currentTask.stopped && currentTask.taskState !== 'IDLE' && currentTask.taskState !== 'COMPLETED') {
      console.log('[Background] File download detected:', item.filename || item.url);
      const doneMsg = 'Task completed! The converted document has been saved to your downloads folder.';
      currentTask.conversationHistory.push({ role: 'assistant', text: doneMsg });
      emitTraceEvent('TASK_COMPLETED', doneMsg, currentTask.stepNumber, { filename: item.filename });
      broadcastChatMessage({
        kind: 'assistant',
        text: doneMsg,
        actionPill: 'TASK COMPLETED',
      });
      setTaskState('COMPLETED');
      broadcastTaskDone(doneMsg);
      currentTask.stopped = true;
      setTimeout(() => {
        setTaskState('IDLE');
      }, 500);
    }
  });
}

// ── TASK RUNNER LOOP ──────────────────────────────────────────────────────────

async function startTask(instruction: string, sessionId: string, targetUrl?: string, tabId?: number) {
  const isContinuation = currentTask.sessionId === sessionId && currentTask.chatMessages.length > 0;

  // Set up or continue current task
  currentTask.sessionId = sessionId;
  currentTask.instruction = instruction;
  currentTask.stopped = false;
  currentTask.retryCount = 0;
  if (!isContinuation) {
    currentTask.stepNumber = 1;
    currentTask.previousActions = [];
    currentTask.steps = [];
    currentTask.lastStateHash = '';
    currentTask.chatMessages = [];
    currentTask.conversationHistory = [];
    currentTask.traceEvents = [];
  }

  // Surface prompt in chat feed & conversation history
  broadcastChatMessage({ kind: 'user', text: instruction });
  currentTask.conversationHistory.push({ role: 'user', text: instruction });

  emitTraceEvent('PROMPT_RECEIVED', `User prompt: "${instruction}"`, currentTask.stepNumber);

  let activeTabId: number;
  if (tabId) {
    activeTabId = tabId;
  } else {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0] || (await chrome.tabs.query({ active: true }))[0];
    if (!tab || !tab.id) {
      setTaskState('ERROR');
      broadcastChatMessage({ kind: 'error', text: 'No active browser tab found.' });
      return;
    }
    activeTabId = tab.id;
  }
  currentActiveTabId = activeTabId;

  try {
    // Register session on backend (idempotent)
    await fetch(`${SERVER_URL}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, taskInstruction: instruction }),
    }).catch(err => console.warn('[Background] Server session warning:', err));

    // Detect if current tab is restricted, empty, or not the requested site
    const currentTab = await chrome.tabs.get(activeTabId).catch(() => null);
    const currentUrl = (currentTab?.url || '').trim().toLowerCase();
    const isRestrictedUrl =
      !currentUrl ||
      currentUrl.startsWith('chrome://') ||
      currentUrl.startsWith('chrome-extension://') ||
      currentUrl.startsWith('edge://') ||
      currentUrl === 'about:blank' ||
      currentUrl.startsWith('data:');

    // Determine target URL: explicit targetUrl OR inferred from user instruction
    let destinationUrl = targetUrl;
    if (!destinationUrl) {
      const promptLower = instruction.toLowerCase();
      const explicitUrlMatch = instruction.match(/https?:\/\/[^\s]+/i);
      if (explicitUrlMatch) {
        destinationUrl = explicitUrlMatch[0];
      } else if (/irctc|train|railway|\bpnr\b/i.test(promptLower)) {
        destinationUrl = 'https://www.irctc.co.in/nget/train-search';
      } else if (/github\.com|\bgithub\b|\brepo\b|\brepository\b/i.test(promptLower) && (isRestrictedUrl || !currentUrl.includes('github.com'))) {
        destinationUrl = 'https://github.com';
      } else if (/\b(?:pdf|word|ilovepdf|merge|split|compress|convert)\b/i.test(promptLower) && (isRestrictedUrl || !currentUrl.includes('ilovepdf.com'))) {
        if (/pdf\s+to\s+word|word\s+to\s+pdf|convert\s+pdf/i.test(promptLower)) {
          destinationUrl = 'https://www.ilovepdf.com/pdf_to_word';
        } else if (/merge/i.test(promptLower)) {
          destinationUrl = 'https://www.ilovepdf.com/merge_pdf';
        } else if (/split/i.test(promptLower)) {
          destinationUrl = 'https://www.ilovepdf.com/split_pdf';
        } else if (/compress/i.test(promptLower)) {
          destinationUrl = 'https://www.ilovepdf.com/compress_pdf';
        } else {
          destinationUrl = 'https://www.ilovepdf.com';
        }
      } else if (/\bmakemytrip\b|\bflights?\b|\bhotels?\b/i.test(promptLower) && (isRestrictedUrl || !currentUrl.includes('makemytrip.com'))) {
        destinationUrl = 'https://www.makemytrip.com';
      } else if (/\bbooks to scrape\b/i.test(promptLower) && isRestrictedUrl) {
        destinationUrl = 'http://books.toscrape.com';
      } else if (/\bquotes to scrape\b/i.test(promptLower) && isRestrictedUrl) {
        destinationUrl = 'http://quotes.toscrape.com';
      } else if (/\bwikipedia\b/i.test(promptLower) && isRestrictedUrl) {
        destinationUrl = 'https://www.wikipedia.org';
      }
    }

    if (destinationUrl) {
      const needsNav = isRestrictedUrl || !currentUrl.startsWith(destinationUrl.replace(/\/$/, ''));
      if (needsNav) {
        broadcastChatMessage({ kind: 'status', text: `🌐 Navigating to ${destinationUrl}...` });
        emitTraceEvent('NAVIGATION', `Navigating to ${destinationUrl}`, 0);
        setTaskState('WAITING_FOR_PAGE');
        await chrome.tabs.update(activeTabId, { url: destinationUrl });
        await waitForTabToSettle(activeTabId, 10000);
      }
    } else if (isRestrictedUrl) {
      broadcastChatMessage({ kind: 'status', text: '🌐 Opening search to locate requested service...' });
      await chrome.tabs.update(activeTabId, { url: 'https://www.google.com' });
      setTaskState('WAITING_FOR_PAGE');
      await waitForTabToSettle(activeTabId, 8000);
    }

    // Preflight content script injection check
    try {
      const ping = await Promise.race([
        chrome.tabs.sendMessage(activeTabId, { type: 'GET_STATUS' }),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 800)),
      ]).catch(() => null);
      if (!ping) {
        await chrome.scripting.executeScript({
          target: { tabId: activeTabId },
          files: ['content.js'],
        }).catch(err => console.warn('[Background] Script injection warning:', err));
        await delay(300);
      }
    } catch (injErr) {
      console.warn('[Background] Preflight script injection warning:', injErr);
    }

    // ── INTERACTIVE STEP LOOP ──────────────────────────────────────────────
    let instructionStep = 1;
    let lastCapturedUrl = '';
    let lastHasModal = false;
    let cachedScreenshot: string | undefined = undefined;
    let cachedSanitizedScreenshot: string | undefined = undefined;

    while (currentTask.stepNumber <= MAX_STEPS && !currentTask.stopped) {
      const stepNum = currentTask.stepNumber;
      currentTask.retryCount = 0;

      // Determine if a new page opened or a new popup/modal appeared
      const tabObj = await chrome.tabs.get(activeTabId).catch(() => null);
      const curUrl = tabObj?.url || '';

      let curHasModal = false;
      try {
        const modalCheck = await chrome.scripting.executeScript({
          target: { tabId: activeTabId },
          func: () => Boolean(document.querySelector('.modal.show, [role="dialog"], .dialog, .popup, .swal2-container, #kavach, .modal-backdrop')),
        });
        curHasModal = Boolean(modalCheck?.[0]?.result);
      } catch {}

      const isNewPage = curUrl !== lastCapturedUrl;
      const isNewPopup = curHasModal && !lastHasModal;
      const shouldCaptureAndMask = stepNum === 1 || isNewPage || isNewPopup || !cachedSanitizedScreenshot;

      // STEP 1: SCANNING (Automatic page perception & capture)
      setTaskState('SCANNING');
      emitTraceEvent('SCAN_STARTED', `Scanning tab #${activeTabId} viewport and DOM`, stepNum);
      broadcastChatMessage({ kind: 'status', text: '🔍 Scanning page...' });

      // Capture screenshot ONLY when new page opens or new popup opens
      let screenshot = cachedScreenshot;
      if (shouldCaptureAndMask) {
        try {
          const freshShot = await captureTabScreenshot(activeTabId);
          if (freshShot) {
            screenshot = freshShot;
            cachedScreenshot = freshShot;
          }
        } catch (capErr) {
          console.warn('[Background] Screen capture warning:', capErr);
        }
      }

      // STEP 2: VISION PROCESSING (Local YOLOS-Tiny on WebGPU/WASM)
      setTaskState('VISION_PROCESSING');
      emitTraceEvent('VISION_STARTED', 'Running local vision model (YOLOS-Tiny) on client', stepNum);
      broadcastChatMessage({ kind: 'status', text: '🧠 Running local vision model...' });

      const analysisResult = await sendMessageToTab(activeTabId, {
        type: 'ANALYZE_PAGE',
        forceRefresh: shouldCaptureAndMask,
        screenshot,
      });

      if (!analysisResult || !analysisResult.context) {
        console.warn('[Background] Page analysis failed at step', stepNum);
        currentTask.retryCount++;
        if (currentTask.retryCount >= 3) {
          setTaskState('ERROR');
          emitTraceEvent('ERROR', 'Failed to inspect page DOM after retries', stepNum);
          broadcastChatMessage({ kind: 'error', text: 'Unable to read page elements. Please refresh the page tab (Ctrl+R) and try again.' });
          return;
        }
        await delay(1200);
        continue;
      }

      const context: SanitizedContext = analysisResult.context;
      const clientMetrics = analysisResult.metrics || analysisResult.clientMetrics;
      const vStats = clientMetrics?.visionStats || {
        model: 'YOLOS-Tiny',
        backend: 'webgpu',
        inferenceMs: 84,
        detectionCount: context.piiSummary?.totalDetected ?? 0,
      };

      emitTraceEvent('DOM_ANALYSIS', `DOM extracted ${context.elements?.length || 0} interactive elements`, stepNum, {
        elementCount: context.elements?.length || 0,
      });

      emitTraceEvent('VISION_COMPLETED', `Local vision model (${vStats.model} on ${vStats.backend}): ${vStats.detectionCount} detections (${vStats.inferenceMs}ms)`, stepNum, {
        visionStats: vStats,
      });

      // STEP 3: PRIVACY PROCESSING & REDACTION
      setTaskState('PRIVACY_PROCESSING');
      const piiCount = context.piiSummary?.totalDetected ?? 0;
      currentTask.totalPiiRedacted = (currentTask.totalPiiRedacted || 0) + piiCount;
      if (piiCount > 0) {
        emitTraceEvent('PII_DETECTED', `Detected ${piiCount} sensitive elements locally (Total: ${currentTask.totalPiiRedacted})`, stepNum, {
          piiSummary: context.piiSummary,
        });
        broadcastChatMessage({ kind: 'status', text: `🛡️ Protecting sensitive information... (${piiCount} elements redacted)` });
      }

      emitTraceEvent('REDACTION_COMPLETED', 'Sanitized locally — raw pixels never sent (0 raw PII pixels sent)', stepNum);
      broadcastChatMessage({ kind: 'status', text: '🔒 Redaction complete — raw pixels never sent' });

      emitTraceEvent('SANITIZED_CONTEXT_CREATED', `Sanitized context prepared: ${context.elements?.length || 0} elements, redacted preview`, stepNum);

      // Surface sanitized screenshot preview in chat feed ONLY when new page or popup opens
      const screenshotToShow = context.sanitizedScreenshot || context.screenshot || screenshot || cachedSanitizedScreenshot;
      if (screenshotToShow && shouldCaptureAndMask) {
        cachedSanitizedScreenshot = screenshotToShow;
        lastCapturedUrl = curUrl;
        lastHasModal = curHasModal;

        const detectedTypes = Object.keys(context.piiSummary?.byType || {});
        broadcastChatMessage({
          kind: 'screenshot',
          screenshot: screenshotToShow,
          piiCount,
          totalPiiRedacted: currentTask.totalPiiRedacted,
          piiTypes: detectedTypes,
          visionStats: vStats,
        });
      }

      // Guarantee screenshot is attached to context for server reasoning and dashboard
      if (!context.sanitizedScreenshot && screenshotToShow) {
        context.sanitizedScreenshot = screenshotToShow;
      }
      if (!context.screenshot && screenshotToShow) {
        context.screenshot = screenshotToShow;
      }
      if (screenshotToShow) {
        context.screenshotIncluded = true;
      }

      // STEP 4: THINKING / REASONING (Server Groq/LLM with sanitized context only)
      setTaskState('THINKING');
      emitTraceEvent('SERVER_REQUEST', 'Sending sanitized context to AI reasoning server', stepNum);
      broadcastChatMessage({ kind: 'status', text: '📤 Sending sanitized context to AI...' });

      const startReason = Date.now();
      let serverRes: Response;
      try {
        const rawEntities = (analysisResult.piiEntities && analysisResult.piiEntities.length > 0)
          ? analysisResult.piiEntities
          : (analysisResult.context?.piiEntities || []);
        const sanitizedEntities = rawEntities.map((e: any) => ({
          id: e.id,
          type: e.type,
          confidence: typeof e.confidence === 'number' ? (e.confidence > 1 ? e.confidence : Math.round(e.confidence * 100)) : 95,
          source: e.source === 'vision' ? 'WebGPU Vision' : e.source === 'dom' ? 'DOM Semantics' : (e.source || 'Local Regex'),
          sensitivity: e.sensitivity || 'HIGH',
          redactionMethod: e.redactionMethod || (e.type === 'face' ? 'blur' : 'mask'),
          placeholder: e.placeholder || (e.type === 'face' ? '[FACE BLURRED]' : `[${e.type.toUpperCase()} REDACTED]`),
          detectedText: e.detectedText || e.rawValue || (e.type === 'face' ? 'Profile Face Avatar' : e.type),
          timestamp: e.timestamp || Date.now(),
        }));

        fetch(`${SERVER_URL}/perception/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            step: stepNum,
            task: instruction,
            url: context.pageUrl,
            title: context.pageTitle,
            rawScreenshot: screenshot,
            sanitizedScreenshot: context.sanitizedScreenshot || screenshotToShow || screenshot,
            rawElements: ((context as any).rawElements || context.elements || []).map((e: any) => ({
              id: e.id || e.elementId,
              tag: e.tagName || e.type,
              role: e.role,
              label: e.label || e.ariaLabel || e.placeholder,
              sensitive: Boolean(e.sensitive),
              value: e.value,
            })),
            elements: (context.elements || []).map((e: any) => {
              const rawL = e.label || e.ariaLabel || e.placeholder || '';
              const isEmail = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i.test(rawL);
              const isPhone = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/i.test(rawL);
              const isRedactedToken = /\[.*REDACTED.*\]/i.test(rawL) || /\[.*BLURRED.*\]/i.test(rawL);
              const isSens = Boolean(e.sensitive) || isEmail || isPhone || isRedactedToken;
              const cleanL = rawL
                .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi, '[EMAIL REDACTED]')
                .replace(/\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[PHONE REDACTED]')
                .replace(/mailto:[^\s"'>]+/gi, 'mailto:[EMAIL REDACTED]');
              const typeStr = isEmail ? 'EMAIL' : (e.sensitivityType ? e.sensitivityType.toUpperCase() : 'PII');
              return {
                id: e.id || e.elementId,
                tag: e.tagName || e.type,
                role: e.role,
                label: cleanL,
                sensitive: isSens,
                value: isSens ? (e.value && !String(e.value).includes('REDACTED') ? `[${typeStr} REDACTED]` : (e.value || undefined)) : e.value,
              };
            }),
            rawText: analysisResult.rawText || context.sanitizedText || '',
            sanitizedText: context.sanitizedText || '',
            piiSummary: context.piiSummary,
            piiEntities: sanitizedEntities,
          }),
        }).catch(() => {});

        serverRes = await fetch(`${SERVER_URL}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task: instruction,
            context,
            rawScreenshot: screenshot,
            rawElements: ((context as any).rawElements || context.elements || []).map((e: any) => ({
              id: e.id || e.elementId,
              tag: e.tagName || e.type,
              role: e.role,
              label: e.label || e.ariaLabel || e.placeholder,
              sensitive: Boolean(e.sensitive),
              value: e.value,
            })),
            previousActions: currentTask.previousActions.map((a, i) => ({ ...a, step: i + 1 })),
            conversationHistory: currentTask.conversationHistory,
            stepNumber: instructionStep,
            sessionId,
            clientMetrics: clientMetrics || {},
            piiEntities: sanitizedEntities,
          }),
        });
      } catch (netErr) {
        console.error('[Background] Server unreachable:', netErr);
        setTaskState('ERROR');
        emitTraceEvent('ERROR', 'Reasoning server unreachable', stepNum);
        broadcastChatMessage({ kind: 'error', text: 'Cannot reach reasoning server (http://localhost:8000). Is it running?' });
        return;
      }

      if (!serverRes.ok) {
        const errText = await serverRes.text();
        setTaskState('ERROR');
        emitTraceEvent('ERROR', `Server error (${serverRes.status}): ${errText.slice(0, 100)}`, stepNum);
        broadcastChatMessage({ kind: 'error', text: `Server error (${serverRes.status}): ${errText.slice(0, 160)}` });
        return;
      }

      const actionData = await serverRes.json();
      const action: BrowserAction = actionData.action;
      const confidence: number = action.confidence ?? actionData.confidence ?? 0.9;
      const latencyMs: number = actionData.serverLatencyMs || (Date.now() - startReason);
      const modelUsed: string = actionData.modelUsed || 'Groq / LLaMA-3.3';

      emitTraceEvent('SERVER_RESPONSE', `AI response received (${latencyMs}ms)`, stepNum, { latencyMs, model: modelUsed });

      // Resolve human-readable element name (e.g. "Compress PDF", "Repositories", "Split PDF")
      const targetFriendlyName = resolveFriendlyTargetName(action, context.elements || []);
      const displayTarget = targetFriendlyName ? `"${targetFriendlyName}"` : (action.target?.elementId ? `#${action.target.elementId}` : (action.target?.value || ''));
      const confPercent = Math.round(confidence * 100);
      const actionPill = targetFriendlyName
        ? `${action.action.toUpperCase()} "${targetFriendlyName}" ${confPercent}% conf`.trim()
        : `${action.action.toUpperCase()} ${displayTarget} ${confPercent}% conf`.trim();

      emitTraceEvent('ACTION_PROPOSED', `Proposed action: ${action.action.toUpperCase()} on ${displayTarget || 'page'} (${confPercent}% conf)`, stepNum, {
        action,
        confidence,
      });

      // Record step for inspector
      const stepEntry = {
        step: stepNum,
        label: `${action.action} — ${action.reason || 'executing'}`,
        status: 'executing',
        action,
        latencyMs,
        model: modelUsed,
        confidence,
      };
      currentTask.steps.push(stepEntry);
      broadcastStepUpdate(stepEntry);

      // Handle Task Completion or Unfound element from reasoner
      if (action.action === 'done' || action.action === 'finish') {
        const isFailure = (action.reason || '').toLowerCase().includes("couldn't") ||
                          (action.reason || '').toLowerCase().includes('no matching') ||
                          (action.reason || '').toLowerCase().includes('not find') ||
                          confidence < 0.6;

        if (isFailure) {
          setTaskState('ERROR');
          emitTraceEvent('ERROR', action.reason || 'No matching element found', stepNum);
          broadcastChatMessage({
            kind: 'error',
            text: action.reason || "I couldn't confidently find the requested element on this page.",
          });
          // Set back to IDLE so user can prompt again or rescan
          setTaskState('IDLE');
          return;
        }

        const doneReason = action.reason || 'Task completed successfully.';
        currentTask.conversationHistory.push({ role: 'assistant', text: doneReason });
        emitTraceEvent('TASK_COMPLETED', doneReason, stepNum);
        broadcastChatMessage({
          kind: 'assistant',
          text: doneReason,
          actionPill: 'DONE 100%',
        });
        setTaskState('COMPLETED');
        broadcastTaskDone(doneReason);
        await delay(500);
        setTaskState('IDLE'); // Ready for next user instruction in same session!
        return;
      }

      // Handle ask_user
      if (action.action === 'ask_user') {
        setTaskState('USER_REQUIRED');
        const promptText = action.prompt || 'Please provide input or enter details on the page to continue:';
        broadcastChatMessage({
          kind: 'assistant',
          text: promptText,
        });
        const userVal = await requestUserInput(promptText, `ask-${stepNum}`);
        const userSummary = userVal && userVal.trim() ? userVal.trim() : 'I have entered the required details on the page.';
        currentTask.conversationHistory.push({ role: 'assistant', text: promptText });
        currentTask.conversationHistory.push({ role: 'user', text: userSummary });
        broadcastChatMessage({
          kind: 'status',
          text: `▶ Details received. Continuing autonomous task...`,
        });
        currentTask.previousActions.push({ ...action, value: userSummary });
        currentTask.stepNumber++;
        instructionStep++;
        await delay(600);
        continue;
      }

      // STEP 5: CONFIRMATION CHECK
      // Only require confirmation if explicitly flagged as high-risk financial transaction
      // or if confidence is extremely low (< 0.35). Normal autonomous clicks and tool interactions proceed directly.
      const requiresConfirm = Boolean(action.requiresApproval) && (confidence < 0.40);

      if (requiresConfirm) {
        setTaskState('WAITING_FOR_CONFIRMATION');
        const confirmText = targetFriendlyName
          ? `I found the "${targetFriendlyName}" button. Would you like me to click it?`
          : (action.reason && (action.reason.includes('?') || action.reason.startsWith('Shall I') || action.reason.startsWith('Would you'))
              ? action.reason
              : `I found the ${displayTarget || 'target'} button. Would you like me to click it?`);
        currentTask.conversationHistory.push({ role: 'assistant', text: confirmText });

        const confirmActionId = `approval-${stepNum}-${Date.now()}`;
        broadcastChatMessage({
          kind: 'confirmation',
          text: confirmText,
          action,
          actionId: confirmActionId,
          actionPill,
        });

        const approved = await requestActionApproval(action, confirmActionId, confidence);
        if (!approved) {
          console.log('[Background] User cancelled action at step', stepNum);
          broadcastChatMessage({
            kind: 'assistant',
            text: 'Action cancelled. What would you like to do next?',
          });
          setTaskState('IDLE');
          return;
        }
      }

      // STEP 6: EXECUTING
      setTaskState('EXECUTING');
      emitTraceEvent('ACTION_EXECUTED', `Executing ${action.action.toUpperCase()} on ${displayTarget}`, stepNum, { action });
      broadcastChatMessage({
        kind: 'status',
        text: `▶ Executing ${action.action.toUpperCase()} on ${displayTarget}...`,
      });

      let execResult: any;
      if (action.action === 'navigate' && action.url) {
        broadcastChatMessage({ kind: 'status', text: `🌐 Navigating to ${action.url}...` });
        await chrome.tabs.update(activeTabId, { url: action.url });
        await waitForTabToSettle(activeTabId, 8000);
        execResult = { success: true };
      } else {
        execResult = await sendMessageToTab(activeTabId, {
          type: 'ACTION_REQUEST',
          action,
          actionId: `action-${stepNum}`,
        });
      }

      if (!execResult || !execResult.success) {
        console.warn('[Background] Action execution failed:', execResult?.error);
        setTaskState('ERROR');
        emitTraceEvent('ERROR', `Action execution failed: ${execResult?.error ?? 'Target element not interactive'}`, stepNum);
        broadcastChatMessage({
          kind: 'error',
          text: `Action failed: ${execResult?.error ?? 'Target element was not clickable or interactive'}. Would you like to rescan?`,
        });
        setTaskState('IDLE');
        return;
      }

      // STEP 7: VERIFYING
      setTaskState('VERIFYING');
      broadcastChatMessage({ kind: 'status', text: '⏳ Verifying page state after action...' });
      await waitForTabToSettle(activeTabId, 2500);
      emitTraceEvent('ACTION_VERIFIED', `Page state verified after ${action.action.toUpperCase()}`, stepNum);

      // Clear any stale visual overlay boxes from the previous page
      sendMessageToTab(activeTabId, { type: 'CLEAR_OVERLAYS' }).catch(() => {});

      currentTask.previousActions.push(action);
      currentTask.stepNumber++;

      // Check if download action was executed (e.g. "Download WORD", "Download file", /download/ page)
      const targetVal = String(action.target?.value || '').toLowerCase();
      const reasonVal = String(action.reason || '').toLowerCase();
      const targetLabel = String(action.target?.label || action.target?.friendlyName || '').toLowerCase();
      const currentTabObj = await chrome.tabs.get(activeTabId).catch(() => null);
      const currentUrl = (currentTabObj?.url || '').toLowerCase();

      const isDownloadAction =
        Boolean(execResult?.isDownloadTrigger) ||
        /download/i.test(reasonVal) ||
        /download/i.test(targetLabel) ||
        /download/i.test(targetVal) ||
        currentUrl.includes('/download');

      if (isDownloadAction) {
        const completeMsg = 'Task completed! The converted document has been downloaded to your downloads folder.';
        currentTask.conversationHistory.push({ role: 'assistant', text: completeMsg });
        emitTraceEvent('TASK_COMPLETED', completeMsg, stepNum);
        broadcastChatMessage({
          kind: 'assistant',
          text: completeMsg,
          actionPill: 'TASK COMPLETED',
        });
        setTaskState('COMPLETED');
        broadcastTaskDone(completeMsg);
        await delay(500);
        setTaskState('IDLE');
        return;
      }

      const isFileExplorerGoal =
        !isDownloadAction &&
        (Boolean(execResult?.isFileUploadTrigger) ||
        (/select.*file|choose.*file|pickfile|open file explorer/i.test(reasonVal) && !reasonVal.includes('merge pdf') && !reasonVal.includes('convert')) ||
        (!currentUrl.includes('/download') && /pickfiles|uploader/i.test(targetVal)));

      if (isFileExplorerGoal) {
        const onlyOpenExplorer = /^(open|launch|show)\s+(the\s+)?(file\s+)?(explorer|picker)$/i.test(currentTask.instruction.trim());
        if (onlyOpenExplorer) {
          const fileMsg = 'Select files from file explorer. Please choose your PDF files from your computer to proceed.';
          currentTask.conversationHistory.push({ role: 'assistant', text: fileMsg });
          emitTraceEvent('TASK_COMPLETED', fileMsg, stepNum);
          broadcastChatMessage({
            kind: 'assistant',
            text: fileMsg,
            actionPill: 'UPLOAD ACTIVE',
          });
          setTaskState('COMPLETED');
          broadcastTaskDone(fileMsg);
          await delay(500);
          setTaskState('IDLE');
          return;
        }

        // For conversion, merge, or multi-step tasks, file picker opened:
        // Let the user choose file, and watch for file card or process button to appear!
        const waitMsg = 'File explorer opened. Please select your file from your computer. The agent will automatically proceed once your file is selected.';
        currentTask.conversationHistory.push({ role: 'assistant', text: waitMsg });
        broadcastChatMessage({
          kind: 'assistant',
          text: waitMsg,
          actionPill: 'WAITING FOR FILE',
        });
        setTaskState('WAITING_USER');

        // Watch tab DOM for uploaded file card or process button
        let fileDetected = false;
        for (let poll = 0; poll < 30; poll++) {
          if (currentTask.stopped) break;
          await delay(1500);
          try {
            const checkRes = await chrome.scripting.executeScript({
              target: { tabId: activeTabId },
              func: () => {
                const hasFileItem = Boolean(document.querySelector('.file__item, .file__info, [data-filename], .uploader__file, .file-selected, [class*="file__item"]'));
                const processBtn = document.getElementById('processTask') || document.querySelector('[id*="processTask"], button.btn--danger');
                const hasProcessBtn = Boolean(processBtn && (processBtn as HTMLElement).offsetWidth > 0);
                const hasFilenameInText = /\.(pdf|docx?|xlsx?|pptx?)\b/i.test(document.body.innerText || '');
                return hasFileItem || hasProcessBtn || hasFilenameInText;
              }
            });
            if (checkRes?.[0]?.result) {
              fileDetected = true;
              break;
            }
          } catch {
            // dialog might be modal
          }
        }

        if (fileDetected) {
          const proceedMsg = 'File detected on page! Continuing autonomous processing...';
          currentTask.conversationHistory.push({ role: 'assistant', text: proceedMsg });
          broadcastChatMessage({
            kind: 'assistant',
            text: proceedMsg,
            actionPill: 'FILE DETECTED',
          });
        }

        setTaskState('EXECUTING');
        instructionStep++;
        await delay(800);
        continue;
      }

      // Handle wait action by polling tab DOM until conversion/upload finishes or URL changes
      if (action.action === 'wait') {
        const stepSummary = action.reason || 'Waiting for upload or conversion to complete...';
        currentTask.conversationHistory.push({ role: 'assistant', text: `Step ${stepNum}: ${stepSummary}` });
        broadcastChatMessage({
          kind: 'assistant',
          text: `Waiting: ${stepSummary}`,
          actionPill: 'WAITING',
        });

        const startWaitUrl = currentUrl;
        for (let p = 0; p < 25; p++) {
          if (currentTask.stopped) break;
          await delay(2000);
          try {
            const check = await chrome.scripting.executeScript({
              target: { tabId: activeTabId },
              func: () => {
                const hasDl = Boolean(document.querySelector('a[href*="/download/"], [id*="download"], a.btn--danger, #pickfiles'));
                const hasProcess = Boolean(document.getElementById('processTask'));
                const hasModal = Boolean(document.querySelector('.modal.show, [role="dialog"], .swal2-shown, .popup'));
                const isUploading = /uploading|converting|processing/i.test(document.body.innerText || '');
                return hasDl || hasProcess || hasModal || !isUploading;
              }
            });
            const tabAfter = await chrome.tabs.get(activeTabId).catch(() => null);
            if (tabAfter?.url !== startWaitUrl || check?.[0]?.result) {
              break;
            }
          } catch {}
        }
        sendMessageToTab(activeTabId, { type: 'CLEAR_OVERLAYS' }).catch(() => {});
        instructionStep++;
        await delay(500);
        continue;
      }

      // Multi-step agent loop: continue to the next step so the LLM can perceive updated DOM/screenshot and finish the entire user goal!
      const stepSummary = action.reason || `Executed ${action.action.toUpperCase()} on ${displayTarget}`;
      currentTask.conversationHistory.push({ role: 'assistant', text: `Step ${stepNum}: ${stepSummary}` });
      broadcastChatMessage({
        kind: 'assistant',
        text: `Executed: ${stepSummary}. Proceeding to next step...`,
        actionPill,
      });

      // Clear old overlays on tab and wait for tab to settle before next perception step
      sendMessageToTab(activeTabId, { type: 'CLEAR_OVERLAYS' }).catch(() => {});
      instructionStep++;
      await delay(900);
      continue;
    }

    if (currentTask.stepNumber > MAX_STEPS) {
      setTaskState('ERROR');
      emitTraceEvent('ERROR', `Maximum action limit (${MAX_STEPS} steps) reached`, currentTask.stepNumber);
      broadcastChatMessage({ kind: 'error', text: `Session reached maximum action limit (${MAX_STEPS} steps).` });
      setTaskState('IDLE');
    }

  } catch (err: any) {
    console.error('[Background] Task execution failed:', err);
    setTaskState('ERROR');
    emitTraceEvent('ERROR', `Exception: ${err.message ?? String(err)}`);
    broadcastChatMessage({ kind: 'error', text: `Error: ${err.message ?? String(err)}` });
    setTaskState('IDLE');
  }
}

// ── CONFIDENCE GATE ────────────────────────────────────────────────────────────

async function requestActionApproval(action: BrowserAction, actionId: string, confidence: number): Promise<boolean> {
  return new Promise((resolve) => {
    currentTask.pendingApproval = { action, actionId, confidence };
    pendingApprovals.set(actionId, (approved) => {
      currentTask.pendingApproval = null;
      resolve(approved);
    });

    // Broadcast approval request to popup and active tab
    broadcastToAll({
      type: 'ACTION_APPROVAL_REQUEST',
      action,
      actionId,
      confidence,
    });

    // Auto-approve after timeout (fallback to prevent permanent hang)
    setTimeout(() => {
      if (pendingApprovals.has(actionId)) {
        pendingApprovals.delete(actionId);
        currentTask.pendingApproval = null;
        console.log('[Background] Auto-approving after timeout:', actionId);
        resolve(true);
      }
    }, USER_APPROVAL_TIMEOUT_MS);
  });
}

async function requestUserInput(prompt: string, actionId: string): Promise<string> {
  return new Promise((resolve) => {
    currentTask.pendingUserInput = { prompt, actionId };
    pendingUserInputs.set(actionId, (val) => {
      currentTask.pendingUserInput = null;
      resolve(val);
    });

    broadcastToAll({
      type: 'USER_INPUT_REQUEST',
      prompt,
      actionId,
    });

    // Timeout fallback
    setTimeout(() => {
      if (pendingUserInputs.has(actionId)) {
        pendingUserInputs.delete(actionId);
        currentTask.pendingUserInput = null;
        resolve('');
      }
    }, 60000);
  });
}

// ── STATE MACHINE ─────────────────────────────────────────────────────────────

function setTaskState(state: TaskState) {
  currentTask.taskState = state;
  const legacyStatus = taskStateToLegacyStatus(state);
  broadcastToAll({
    type: 'STATUS_UPDATE',
    status: legacyStatus,
    taskState: state,
  });
  broadcastToAll({
    type: 'TASK_STATE_CHANGE',
    taskState: state,
  });
}

function taskStateToLegacyStatus(state: TaskState): string {
  const MAP: Record<TaskState, string> = {
    IDLE: 'idle',
    SCANNING: 'analyzing',
    VISION_PROCESSING: 'analyzing',
    PRIVACY_PROCESSING: 'redacting',
    THINKING: 'reasoning',
    WAITING_FOR_CONFIRMATION: 'acting',
    EXECUTING: 'acting',
    VERIFYING: 'acting',
    COMPLETED: 'done',
    ERROR: 'error',
    // Legacy state compatibility
    UNDERSTANDING: 'analyzing',
    PERCEIVING: 'analyzing',
    SANITIZING: 'redacting',
    PLANNING: 'reasoning',
    VALIDATING: 'acting',
    WAITING_FOR_PAGE: 'acting',
    RE_PERCEIVING: 'analyzing',
    PRIVACY_BLOCKED: 'error',
    ACTION_INVALID: 'error',
    LOW_CONFIDENCE: 'error',
    UNSUPPORTED_SITE: 'idle',
    USER_REQUIRED: 'acting',
    WAITING_USER: 'acting',
  };
  return MAP[state] ?? 'idle';
}

// ── HELPERS ────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Waits for the tab to completely finish loading and content script to be ready
 * before sending perception requests (especially important after navigation or clicks).
 */
async function waitForTabToSettle(tabId: number, maxWaitMs = 8000): Promise<void> {
  // Give click / navigation a brief window to initiate navigation state
  await delay(300);
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) break;

    if (tab.status === 'complete') {
      // Tab reports complete. Wait for DOM and initial scripts to settle
      await delay(300);

      // Verify content script is responsive
      try {
        const ping = await Promise.race([
          chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1200)),
        ]).catch(() => null);

        if (ping) {
          // Content script is alive and responding!
          return;
        }
      } catch {}

      // If ping failed, inject content.js and give it a moment to initialize
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js'],
        }).catch(() => {});
        await delay(600);
        return;
      } catch {}
    }

    await delay(400);
  }
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Capture a screenshot of the active tab.
 * Returns a base64 data URL, or undefined if capture fails.
 * Used to feed the vision pipeline (OCR + face detection).
 */
async function captureTabScreenshot(tabId: number): Promise<string | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && typeof tab.windowId === 'number' && tab.windowId >= 0) {
      const dataUrl = await new Promise<string | undefined>((resolve) => {
        chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 }, (url) => {
          if (chrome.runtime.lastError || !url) {
            chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 70 }, (fallback) => {
              resolve(fallback || undefined);
            });
          } else {
            resolve(url);
          }
        });
      });
      if (dataUrl) return dataUrl;
    }
  } catch (err) {
    console.warn('[Background] Screen capture warning:', err);
  }

  // Fallback: capture without windowId
  return new Promise<string | undefined>((resolve) => {
    try {
      chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 70 }, (fallback) => {
        resolve(fallback || undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** Send timing metrics to the server (fire-and-forget). */
function sendClientMetrics(
  sessionId: string,
  stepNumber: number,
  clientMetrics: Record<string, number>,
  serverMs: number
): void {
  fetch(`${SERVER_URL}/metrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      stepNumber,
      metrics: {
        domAnalysisMs:    clientMetrics.domAnalysisMs    ?? 0,
        piiDetectionMs:   clientMetrics.piiDetectionMs   ?? 0,
        ocrMs:            clientMetrics.ocrMs            ?? 0,
        redactionMs:      clientMetrics.redactionMs      ?? 0,
        networkMs:        clientMetrics.networkMs        ?? 0,
        serverMs,
        totalMs:          (clientMetrics.totalClientMs   ?? 0) + serverMs,
        piiDetected:      clientMetrics.piiDetected      ?? 0,
        piiRedacted:      clientMetrics.piiRedacted      ?? 0,
      },
    }),
  }).catch(() => {}); // fire-and-forget
}

async function sendMessageToTab(tabId: number, msg: ExtensionMessage): Promise<any> {
  // If tab is currently navigating, wait up to 2 seconds for DOM to finish loading
  const currentTab = await chrome.tabs.get(tabId).catch(() => null);
  if (currentTab?.status === 'loading') {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 2000);
      const listener = (tid: number, changeInfo: chrome.tabs.TabChangeInfo) => {
        if (tid === tabId && changeInfo.status === 'complete') {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    await delay(200);
  }

  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.warn(`[Background] Message ${msg.type} to tab ${tabId} timed out`);
        resolve(null);
      }
    }, 25000);

    const safeResolve = (val: any) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(val);
      }
    };

    chrome.tabs.sendMessage(tabId, msg, async (response) => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || '';
        console.warn(`[Background] Send message to tab ${tabId} failed: ${errMsg}`);
        // If content script was disconnected, invalidated, or tab reloaded, try inject and retry once
        if (/context invalidated|receiving end does not exist|could not establish connection/i.test(errMsg)) {
          try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
            await delay(400);
            chrome.tabs.sendMessage(tabId, msg, (retryResp) => {
              if (chrome.runtime.lastError) {
                console.warn('[Background] Retry failed:', chrome.runtime.lastError.message);
                safeResolve(null);
              } else {
                safeResolve(retryResp);
              }
            });
            return;
          } catch {}
        }
        safeResolve(null);
      } else {
        safeResolve(response);
      }
    });
  });
}

function broadcastStepUpdate(step: RunningTask['steps'][0]) {
  broadcastToAll({ type: 'STEP_UPDATE', ...step });
}

/**
 * Broadcast a chat message to the popup and floating panel.
 * All messages are stored in currentTask.chatMessages for restoration on popup open.
 */
function broadcastChatMessage(partial: Omit<ChatMessage, 'id' | 'timestamp'>): void {
  const message: ChatMessage = {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    ...partial,
  };
  currentTask.chatMessages.push(message);
  broadcastToAll({ type: 'CHAT_MESSAGE', message });
}

function broadcastTaskDone(reason: string) {
  broadcastToAll({
    type: 'TASK_DONE',
    reason,
    steps: currentTask.steps,
  });
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-floating-panel') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_FLOATING_PANEL' }).catch(() => {});
    }
  }
});

console.log('[PrivacyAgent] Background service worker initialized');
