"""
Pydantic schemas for the Privacy-Preserving Browser Agent server.

These define the ONLY data structures the server is permitted to receive and return.
The server NEVER receives raw PII — only sanitized context.
"""
from __future__ import annotations
from typing import Literal, Optional, Any
from pydantic import BaseModel, Field


# ── INCOMING: Sanitized UI Context ────────────────────────────────────────────

class BoundingBox(BaseModel):
    x: float
    y: float
    width: float
    height: float


class UIElement(BaseModel):
    id: str = ""
    elementId: Optional[str] = None          # Stable el_NNN ID from ElementRegistry
    type: str = "element"
    role: Optional[str] = None
    label: Optional[str] = None
    placeholder: Optional[str] = None
    value: Optional[str] = None       # Only non-sensitive values
    sensitive: bool = False
    sensitivityType: Optional[str] = None
    bbox: Optional[BoundingBox] = None
    domSelector: str = ""
    interactable: bool = True
    visible: bool = True
    tagName: str = "div"
    attributes: dict[str, str] = {}
    # Accessibility enrichment
    ariaLabel: Optional[str] = None
    ariaRole: Optional[str] = None
    accessibleName: Optional[str] = None


class PIISummary(BaseModel):
    totalDetected: int = 0
    totalRedacted: int = 0
    byType: dict[str, int] = {}


class SanitizedContext(BaseModel):
    """
    The sanitized representation of the current page state.
    INVARIANT: This model MUST NOT contain any raw PII.
    """
    pageUrl: str = ""
    pageTitle: str = ""
    pageType: str = "generic"
    timestamp: Optional[float | int] = None
    elements: list[UIElement] = []
    sanitizedText: str = ""
    ocrTexts: list[str] = []
    piiSummary: PIISummary = Field(default_factory=PIISummary)
    screenshotIncluded: bool = False
    sanitizedScreenshot: Optional[str] = None   # Base64 only if all PII redacted
    rawScreenshot: Optional[str] = None         # Client-side raw screenshot for judges demonstration
    rawElements: Optional[list[Any]] = None     # Client-side raw elements before masking
    perceptionLevel: Optional[int] = None        # 1=A11y, 2=DOM, 3=OCR, 4=Screenshot
    stateHash: Optional[str] = None              # Lightweight page state hash
    siteAdapter: Optional[str] = None            # Active site adapter name
    piiEntities: Optional[list[dict[str, Any]]] = None  # Redacted PII metadata (no raw values)


class ActionRequest(BaseModel):
    task: str                          # User's natural language instruction
    sessionId: str
    context: SanitizedContext
    rawScreenshot: Optional[str] = None
    rawElements: Optional[list[Any]] = None
    stepNumber: int = 1
    previousActions: list[dict] = []   # History of prior steps sent to LLM for memory
    conversationHistory: list[dict[str, Any]] = Field(default_factory=list) # Multi-turn conversational memory
    clientMetrics: Optional[dict[str, Any]] = None
    piiEntities: Optional[list[dict[str, Any]]] = None

# ── OUTGOING: Structured Browser Actions ──────────────────────────────────────

ActionType = Literal["click", "fill", "scroll", "select", "focus", "navigate", "wait", "back", "forward", "finish", "ask_user", "done"]

class ActionTarget(BaseModel):
    type: Optional[str] = "element-id"
    value: Optional[str] = None
    elementId: Optional[str] = None
    friendlyName: Optional[str] = None
    label: Optional[str] = None

    def get_element_id(self) -> str:
        return self.elementId or self.value or ""


class BrowserAction(BaseModel):
    action: ActionType
    target: Optional[ActionTarget] = None
    value: Optional[str] = None
    direction: Optional[Literal["up", "down", "left", "right"]] = None
    amount: Optional[int] = None
    url: Optional[str] = None
    reason: str = "LLM decision"
    confidence: float = Field(default=0.9, ge=0.0, le=1.0)
    requiresApproval: bool = False
    prompt: Optional[str] = None   # For ask_user: question to show the user


class ActionResponse(BaseModel):
    action: BrowserAction
    sessionId: str
    stepNumber: int
    serverLatencyMs: int
    llmProvider: str
    modelUsed: str
    promptSentToLLM: Optional[str] = None   # Full prompt for transparency/debugging
    rawLLMResponse: Optional[str] = None    # Raw LLM output before parsing
    trace: Optional[dict[str, Any]] = None


# ── SESSION & METRICS ─────────────────────────────────────────────────────────

class SessionCreate(BaseModel):
    sessionId: str
    taskInstruction: str


class MetricsUpdate(BaseModel):
    sessionId: str
    stepNumber: int
    metrics: dict[str, Any]


class PrivacyEvent(BaseModel):
    sessionId: str
    piiType: str
    confidence: float
    source: str
    redactionMethod: str
    timestamp: int


class TraceEventCreate(BaseModel):
    sessionId: str
    type: str
    detail: Optional[str] = None
    step: Optional[int] = None
    timestamp: Optional[float] = None
    metadata: Optional[dict[str, Any]] = None

