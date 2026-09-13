/**
 * Shared Type Definitions for Privacy-Preserving Browser Agent Extension
 */

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PIIType =
  | 'email'
  | 'phone'
  | 'name'
  | 'address'
  | 'credit_card'
  | 'cvv'
  | 'password'
  | 'aadhaar'
  | 'pan'
  | 'dob'
  | 'upi'
  | 'ifsc'
  | 'api_key'
  | 'auth_token'
  | 'face'
  | 'qr_code'
  | 'barcode'
  | 'signature'
  | 'account_number'
  | 'passport'
  | 'ssn';

export type SensitivityLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type RedactionMethod = 'remove' | 'mask' | 'replace' | 'blur';

export type PIISource = 'dom' | 'regex' | 'ocr' | 'vision';

export interface PIIEntity {
  id: string;
  type: PIIType;
  confidence: number;
  source: PIISource;
  sensitivity: SensitivityLevel;
  redactionMethod: RedactionMethod;
  bbox?: BoundingBox;
  domSelector?: string;
  targetElement?: HTMLElement | Element;
  isFixed?: boolean;
  rawValue?: string;
  placeholder: string;
  timestamp: number;
}

export type ActionType =
  | 'click'
  | 'fill'
  | 'scroll'
  | 'select'
  | 'focus'
  | 'navigate'
  | 'wait'
  | 'back'
  | 'forward'
  | 'finish'
  | 'ask_user'
  | 'done';

export interface ActionTarget {
  type?: string;
  value?: string;
  elementId?: string;
  friendlyName?: string;
  label?: string;
}

export interface BrowserAction {
  action: ActionType;
  target?: ActionTarget;
  value?: string;
  url?: string;
  amount?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  reason?: string;
  thought?: string;
  confidence?: number;
  requiresApproval?: boolean;
  prompt?: string; // For ask_user: question to show the user
}

export interface ActionResult {
  success: boolean;
  action: BrowserAction;
  error?: string;
  executedAt: number;
  latencyMs: number;
  isFileUploadTrigger?: boolean;
  isDownloadTrigger?: boolean;
}

export interface PrivacySettings {
  privacyLevel: 'STRICT' | 'BALANCED' | 'PERMISSIVE';
  enabledCategories: PIIType[];
  defaultRedactionMethod: RedactionMethod;
  requireApprovalFor: ActionType[];
  sendScreenshots: boolean;
  enableOCR: boolean;
  enableFaceDetection: boolean;
}

export interface UIElement {
  id: string;
  elementId?: string; // Stable el_NNN ID from ElementRegistry
  type: string;
  role: string;
  label?: string;
  placeholder?: string;
  value?: string;
  sensitive: boolean;
  sensitivityType?: PIIType;
  bbox: BoundingBox;
  domSelector: string;
  interactable: boolean;
  visible: boolean;
  tagName: string;
  attributes: Record<string, string>;
  // Accessibility fields
  ariaLabel?: string;
  ariaRole?: string;
  accessibleName?: string;
  text?: string;
}

export interface PiiSummary {
  totalDetected: number;
  totalRedacted: number;
  byType: Record<string, number>;
}

export interface SanitizedContext {
  pageUrl: string;
  pageTitle: string;
  pageType: string;
  timestamp: number;
  rawElements?: UIElement[];
  elements: UIElement[];
  sanitizedText: string;
  ocrTexts: string[];
  piiSummary: PiiSummary;
  screenshotIncluded: boolean;
  screenshot?: string;
  sanitizedScreenshot?: string;
  perceptionLevel?: 1 | 2 | 3 | 4;
  stateHash?: string;
  siteAdapter?: string;
  piiEntities?: any[];
}

export type AuditEventType = 'pii_detected' | 'action_blocked' | 'action_executed' | 'data_sent' | 'screenshot_redacted';

// ── CHAT SESSION ──────────────────────────────────────────────────────────────

/** Discriminated kind for each chat bubble in the Live Session feed */
export type ChatMessageKind = 'user' | 'assistant' | 'status' | 'screenshot' | 'confirmation' | 'error';

export interface ChatMessage {
  id: string;
  kind: ChatMessageKind;
  /** Message text (omitted for screenshot-only messages) */
  text?: string;
  timestamp: number;
  /**
   * Sanitized/redacted screenshot data URL.
   * The original sensitive screenshot is NEVER stored or transmitted.
   */
  screenshot?: string;
  /** Number of PII entities redacted before this screenshot was captured */
  piiCount?: number;
  totalPiiRedacted?: number;
  piiTypes?: string[];
  /** Structured action proposal for confirmation */
  action?: BrowserAction;
  actionId?: string;
  confidence?: number;
  confirmed?: 'yes' | 'no' | boolean | null; // null: waiting for user, 'yes'/true: user approved, 'no'/false: user cancelled
  actionPill?: string | {
    action: string;
    target?: string;
    confidence?: number;
  };
  visionStats?: {
    model?: string;
    backend?: string;
    inferenceMs?: number;
    detectionCount?: number;
  };
}

export interface AuditEvent {
  id: string;
  timestamp: number;
  type: AuditEventType;
  detail: string;
  rawDataTransmitted: boolean;
  piiType?: PIIType;
  confidence?: number;
  source?: PIISource;
  redactionMethod?: RedactionMethod;
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: BoundingBox;
}

// ── TRACE EVENT STREAM ─────────────────────────────────────────────────────────

export type TraceEventType =
  | 'PROMPT_RECEIVED'
  | 'SCAN_STARTED'
  | 'DOM_ANALYSIS'
  | 'VISION_STARTED'
  | 'VISION_COMPLETED'
  | 'PII_DETECTED'
  | 'REDACTION_COMPLETED'
  | 'SANITIZED_CONTEXT_CREATED'
  | 'SERVER_REQUEST'
  | 'SERVER_RESPONSE'
  | 'ACTION_PROPOSED'
  | 'USER_CONFIRMATION'
  | 'ACTION_EXECUTED'
  | 'ACTION_VERIFIED'
  | 'NAVIGATION'
  | 'TASK_COMPLETED'
  | 'ERROR';

export interface TraceEvent {
  id: string;
  sessionId: string;
  type: TraceEventType;
  detail: string;
  step?: number;
  timestamp: number;
  metadata?: Record<string, any>;
}

// ── ELEMENT REGISTRY ───────────────────────────────────────────────────────────

/** A single entry in the stable element registry */
export interface ElementRecord {
  elementId: string;        // Stable ID: el_001, el_002, ...
  domSelector: string;      // Local-only CSS selector for action resolution
  tag: string;
  role: string;
  text: string;
  ariaLabel?: string;
  ariaRole?: string;
  placeholder?: string;
  inputType?: string;
  visible: boolean;
  enabled: boolean;
  sensitive: boolean;
  bbox: BoundingBox;
}

// ── TASK STATE MACHINE ─────────────────────────────────────────────────────────

export type TaskState =
  | 'IDLE'
  | 'SCANNING'
  | 'VISION_PROCESSING'
  | 'PRIVACY_PROCESSING'
  | 'THINKING'
  | 'WAITING_FOR_CONFIRMATION'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'ERROR'
  | 'UNDERSTANDING'
  | 'PERCEIVING'
  | 'SANITIZING'
  | 'PLANNING'
  | 'VALIDATING'
  | 'WAITING_FOR_PAGE'
  | 'RE_PERCEIVING'
  | 'PRIVACY_BLOCKED'
  | 'ACTION_INVALID'
  | 'LOW_CONFIDENCE'
  | 'UNSUPPORTED_SITE'
  | 'USER_REQUIRED'
  | 'WAITING_USER';

// ── SITE COMPATIBILITY ─────────────────────────────────────────────────────────

export type SiteCompatibility = 'full' | 'partial' | 'experimental' | 'unsupported';

export interface SiteStatus {
  url: string;
  domain: string;
  compatibility: SiteCompatibility;
  adapterName?: string;
  workflows?: string[];
}

// ── EXTENSION MESSAGES ─────────────────────────────────────────────────────────

export type ExtensionMessage =
  | { type: 'ANALYZE_PAGE'; forceRefresh?: boolean; screenshot?: string; stepId?: number; taskId?: string }
  | { type: 'ACTION_REQUEST'; action: BrowserAction; actionId?: string }
  | { type: 'SETTINGS_UPDATE'; settings: PrivacySettings }
  | { type: 'GET_STATUS' }
  | { type: 'START_TASK'; instruction: string; targetUrl?: string; sessionId?: string; tabId?: number }
  | { type: 'STOP_TASK' }
  | { type: 'CLEAR_CHAT' }
  | { type: 'RESCAN_PAGE' }
  | { type: 'OCR_REQUEST'; imageData: string }
  | { type: 'AUDIT_EVENT'; event: AuditEvent }
  | { type: 'STATUS_UPDATE'; status: string; taskState?: TaskState }
  | { type: 'TASK_STATE_CHANGE'; taskState: TaskState; detail?: string }
  | { type: 'STEP_UPDATE'; step: number; label: string; status: string; action?: BrowserAction; latencyMs?: number; model?: string; confidence?: number }
  | { type: 'TASK_DONE'; reason?: string; steps?: any[] }
  | { type: 'SITE_STATUS'; siteStatus: SiteStatus }
  | { type: 'USER_INPUT_REQUEST'; prompt: string; actionId: string }
  | { type: 'USER_INPUT_RESPONSE'; value: string; actionId: string }
  | { type: 'ACTION_APPROVAL_REQUEST'; action: BrowserAction; actionId: string; confidence: number }
  | { type: 'ACTION_APPROVAL_RESPONSE'; approved: boolean; actionId: string }
  | { type: 'TOGGLE_FLOATING_PANEL'; show?: boolean }
  | { type: 'FALLBACK_MODE'; reason: string }
  | { type: 'CHAT_MESSAGE'; message: ChatMessage }
  | { type: 'TRACE_EVENT'; event: TraceEvent }
  | { type: 'CAPTURE_SCREENSHOT' }
  | { type: 'CLEAR_OVERLAYS'; stepId?: number; reason?: string }
  | { type: 'VIT_INFERENCE'; imageData?: string; requestId?: string; threshold?: number }
  | { type: 'VERIFY_PII'; candidates?: string[]; url?: string }
  | { type: 'REDACTED_PREVIEW'; dataUrl?: string; entitiesApplied?: number; piiTypes?: string[] }
  | { type: 'START_VOICE_INPUT' }
  | { type: 'STOP_VOICE_INPUT' }
  | { type: 'VOICE_STATE_CHANGE'; isListening: boolean }
  | { type: 'VOICE_TRANSCRIPT'; transcript: string; isFinal?: boolean }
  | { type: 'VOICE_ERROR'; errorMsg: string; errorCode?: string }
  | { type: 'SPEAK_ACTION_STATUS'; text: string; actionType?: string }
  | { type: 'VOICE_OUTPUT_TOGGLED'; enabled: boolean };

