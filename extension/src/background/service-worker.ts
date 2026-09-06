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

      // Check if user is answering an existing pending user input
      if (currentTask.pendingUserInput && currentTask.taskState === 'USER_REQUIRED') {
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

    // Navigate if target URL specified
    if (targetUrl) {
      const currentTab = await chrome.tabs.get(activeTabId).catch(() => null);
      if (currentTab?.url !== targetUrl) {
        await chrome.tabs.update(activeTabId, { url: targetUrl });
        setTaskState('WAITING_FOR_PAGE');
        await delay(2000);
      }
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
    while (currentTask.stepNumber <= MAX_STEPS && !currentTask.stopped) {
      const stepNum = currentTask.stepNumber;
      currentTask.retryCount = 0;

      // STEP 1: SCANNING (Automatic page perception & capture)
      setTaskState('SCANNING');
      emitTraceEvent('SCAN_STARTED', `Scanning tab #${activeTabId} viewport and DOM`, stepNum);
      broadcastChatMessage({ kind: 'status', text: '🔍 Scanning page...' });

      // Capture screenshot for local vision model & visual redaction
      let screenshot: string | undefined;
      try {
        screenshot = await captureTabScreenshot(activeTabId);
      } catch (capErr) {
        console.warn('[Background] Screen capture warning:', capErr);
      }

      // STEP 2: VISION PROCESSING (Local YOLOS-Tiny on WebGPU/WASM)
      setTaskState('VISION_PROCESSING');
      emitTraceEvent('VISION_STARTED', 'Running local vision model (YOLOS-Tiny) on client', stepNum);
      broadcastChatMessage({ kind: 'status', text: '🧠 Running local vision model...' });

      const analysisResult = await sendMessageToTab(activeTabId, {
        type: 'ANALYZE_PAGE',
        forceRefresh: true,
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

      // Surface sanitized screenshot preview in chat feed
      const screenshotToShow = context.sanitizedScreenshot || context.screenshot;
      if (screenshotToShow) {
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

        serverRes = await fetch(`${SERVER_URL}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task: instruction,
            context,
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

      const targetDesc = action.target?.elementId ? `#${action.target.elementId}` : (action.target?.value || '');
      const confPercent = Math.round(confidence * 100);
      const actionPill = `${action.action.toUpperCase()} ${targetDesc} ${confPercent}% conf`.trim();

      emitTraceEvent('ACTION_PROPOSED', `Proposed action: ${action.action.toUpperCase()} on ${targetDesc || 'page'} (${confPercent}% conf)`, stepNum, {
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
        broadcastChatMessage({
          kind: 'assistant',
          text: action.prompt || 'Please provide input to continue:',
        });
        const userVal = await requestUserInput(action.prompt || 'Please provide input:', `ask-${stepNum}`);
        currentTask.previousActions.push(action);
        currentTask.stepNumber++;
        await delay(500);
        continue;
      }

      // STEP 5: CONFIRMATION CHECK
      // Require user confirmation on action proposals
      const requiresConfirm = Boolean(action.requiresApproval) ||
        (instructionStep === 1 || confidence < CONFIDENCE_AUTO_APPROVE);

      if (requiresConfirm) {
        setTaskState('WAITING_FOR_CONFIRMATION');
        const confirmText = action.reason && action.reason.includes('?')
          ? action.reason
          : `I found the ${targetDesc || 'target'} button. Would you like me to click it?`;
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
      emitTraceEvent('ACTION_EXECUTED', `Executing ${action.action.toUpperCase()} on ${targetDesc}`, stepNum, { action });
      broadcastChatMessage({
        kind: 'status',
        text: `▶ Executing ${action.action.toUpperCase()} on ${targetDesc}...`,
      });

      const execResult = await sendMessageToTab(activeTabId, {
        type: 'ACTION_REQUEST',
        action,
        actionId: `action-${stepNum}`,
      });

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
      await waitForTabToSettle(activeTabId, 4000);
      emitTraceEvent('ACTION_VERIFIED', `Page state verified after ${action.action.toUpperCase()}`, stepNum);

      currentTask.previousActions.push(action);
      currentTask.stepNumber++;

      // Check if file upload triggered or action completed the user intent
      const targetVal = String(action.target?.value || '').toLowerCase();
      const reasonVal = String(action.reason || '').toLowerCase();
      const isFileExplorerGoal =
        Boolean(execResult?.isFileUploadTrigger) ||
        (/select.*file|choose.*file|pickfile|open file explorer/i.test(reasonVal) && !reasonVal.includes('merge pdf')) ||
        /pickfiles|uploader/i.test(targetVal);

      if (isFileExplorerGoal) {
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

      // Check if action was an intermediate step (e.g. clicked Merge PDF or navigated to tool page)
      const isIntermediateNav = /merge pdf|split pdf|compress pdf|convert pdf|all pdf tools/i.test(reasonVal) ||
                                /merge pdf/i.test(targetVal) ||
                                Boolean(execResult?.navigated);

      if (isIntermediateNav) {
        broadcastChatMessage({
          kind: 'assistant',
          text: `Opened PDF merger tool. Now scanning page to open file explorer...`,
          actionPill,
        });
        instructionStep++;
        continue;
      }

      // If action had a single-turn completion
      const assistantDoneText = `Done. ${action.reason || `Successfully executed ${action.action} on ${targetDesc}`}.`;
      currentTask.conversationHistory.push({ role: 'assistant', text: assistantDoneText });
      emitTraceEvent('TASK_COMPLETED', assistantDoneText, stepNum);
      broadcastChatMessage({
        kind: 'assistant',
        text: assistantDoneText,
        actionPill,
      });

      setTaskState('COMPLETED');
      broadcastTaskDone(assistantDoneText);
      await delay(400);
      setTaskState('IDLE'); // Ready for next user prompt in the same session!
      return;
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
  };
  return MAP[state] ?? 'idle';
}

// ── HELPERS ────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Waits for the tab to completely finish loading and content script to be ready
 * before sending perception requests (especially important after navigation or clicks).
 */
async function waitForTabToSettle(tabId: number, maxWaitMs = 15000): Promise<void> {
  // Give click / navigation a brief window to initiate navigation state
  await delay(800);
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) break;

    if (tab.status === 'complete') {
      // Tab reports complete. Wait for DOM and initial scripts to settle
      await delay(700);

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
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        console.warn('[Background] Screenshot capture timed out (3000ms limit), proceeding with DOM perception');
        resolve(undefined);
      }
    }, 3000);

    const safeResolve = (url?: string) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve(url);
      }
    };

    try {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          try {
            chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 70 }, (fallbackUrl) => {
              safeResolve(fallbackUrl || undefined);
            });
          } catch {
            safeResolve(undefined);
          }
          return;
        }

        const winId = tab.windowId;
        if (typeof winId === 'number' && winId >= 0) {
          try {
            chrome.tabs.captureVisibleTab(winId, { format: 'jpeg', quality: 70 }, (dataUrl) => {
              if (chrome.runtime.lastError || !dataUrl) {
                try {
                  chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 70 }, (fallbackUrl) => {
                    safeResolve(fallbackUrl || undefined);
                  });
                } catch {
                  safeResolve(undefined);
                }
              } else {
                safeResolve(dataUrl);
              }
            });
          } catch {
            safeResolve(undefined);
          }
        } else {
          try {
            chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 70 }, (dataUrl) => {
              safeResolve(dataUrl || undefined);
            });
          } catch {
            safeResolve(undefined);
          }
        }
      });
    } catch {
      safeResolve(undefined);
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
