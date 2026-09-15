/**
 * Content Script — runs in the context of every web page.
 *
 * Responsibilities:
 * 1. Adaptive DOM analysis (Level 1–4 perception hierarchy)
 * 2. Element registry (stable el_NNN IDs)
 * 3. Accessibility tree extraction (Level 1)
 * 4. PII detection (DOM + regex + OCR + vision layers)
 * 5. Visual overlay rendering
 * 6. Action execution (validated actions from background SW)
 * 7. Page context extraction (sanitized, no raw PII)
 * 8. Site adapter integration
 * 9. Per-stage timing metrics reported back to service worker
 */

import { detectPIIFromDOM, detectPIIFromDOMText, detectPIIFromText, detectPIIFromOCRWords, createFaceEntity, PLACEHOLDER_MAP } from '../privacy/pii-detector';
import { buildOverlayBoxes, redactText, sanitizeElements, redactScreenshot, loadAndRedactScreenshot } from '../privacy/redaction-engine';
import { processScreenshot } from '../vision/screenshot-redactor';
import { detectFaces, isElementFixedOrSticky } from '../vision/face-detector';
import { runYOLOSDetection, VisionInferenceStats } from '../vision/yolos-detector';
import { validateAction, executeAction } from '../actions/action-validator';
import { buildRegistry, checkAndResetIfNeeded, resolveElementId } from './element-registry';
import { extractA11yTree, formatA11yForLLM } from './accessibility';
import { DEFAULT_SETTINGS, applyPolicy } from '../privacy/policy-engine';
import { getAdapter, getSiteStatus } from '../adapters/adapter-registry';
import { injectFloatingPanel, toggleFloatingPanel, removeFloatingPanel, isFloatingPanelVisible, updatePanelStats } from './floating-panel';
import { updateAgentBorder, removeAgentBorder } from './agent-border';
import { maskLifecycleManager } from './mask-lifecycle';
import { getActiveModal, isEntityOccluded } from '../utils/dom-visibility';
import { SpeechRecognitionManager } from '../utils/speech-recognition';
import { voiceOutputManager } from '../utils/speech-synthesis';
import type {
  ExtensionMessage, PIIEntity, UIElement, SanitizedContext,
  BoundingBox, PrivacySettings, AuditEvent, ElementRecord
} from '../utils/types';

// ── CLIENT METRICS ─────────────────────────────────────────────────────────────
export interface ClientMetrics {
  domAnalysisMs: number;
  piiDetectionMs: number;
  ocrMs: number;
  faceDetectionMs: number;
  redactionMs: number;
  overlayMs: number;
  totalClientMs: number;
  piiDetected: number;
  piiRedacted: number;
  perceptionLevel: number;
  elementsFound: number;
  memoryUsedMB?: number;
  visionStats?: VisionInferenceStats;
}

let currentSettings: PrivacySettings = DEFAULT_SETTINGS;
let currentEntities: PIIEntity[] = [];
let auditLog: AuditEvent[] = [];
let lastStateHash = '';
let lastAnalysisContext: SanitizedContext | null = null;

// ── INITIALIZATION ─────────────────────────────────────────────────────────────

chrome.storage.local.get(['privacySettings'], (result) => {
  if (result.privacySettings) currentSettings = result.privacySettings;
});

// Announce site status to background on load (top-level frame only)
if (window === window.top) {
  (function announceSiteStatus() {
    const status = getSiteStatus(location.href);
    chrome.runtime.sendMessage({ type: 'SITE_STATUS', siteStatus: status }).catch(() => {});
  })();
}

// Global registry of child iframe PII entities received via postMessage
const activeIframeEntitiesStore: Map<HTMLIFrameElement, PIIEntity[]> = new Map();

if (window === window.top) {
  window.addEventListener('message', (ev) => {
    if (ev.data?.type === '__PRIVSIGHT_IFRAME_PII__' && Array.isArray(ev.data.entities)) {
      try {
        const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'));
        const frame = frames.find(f => {
          try { return f.contentWindow === ev.source; } catch { return false; }
        });
        if (!frame) return;

        const fRect = frame.getBoundingClientRect();
        if (fRect.width <= 0 || fRect.height <= 0) return;

        const mapped: PIIEntity[] = ev.data.entities.map((raw: any) => {
          const b = raw.bbox;
          const bbox: BoundingBox = {
            x: Math.round(fRect.left + (b?.x || 0) + window.scrollX),
            y: Math.round(fRect.top + (b?.y || 0) + window.scrollY),
            width: Math.round(b?.width || 0),
            height: Math.round(b?.height || 0),
          };
          return {
            id: raw.id || `iframe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: raw.type,
            confidence: raw.confidence || 0.98,
            source: 'dom',
            sensitivity: raw.sensitivity || 'CRITICAL',
            redactionMethod: 'mask',
            bbox,
            isFixed: true,
            rawValue: raw.rawValue,
            placeholder: raw.placeholder || (raw.type === 'credit_card' ? '[CARD REDACTED]' : raw.type === 'cvv' ? '[CVV REDACTED]' : '[REDACTED]'),
            timestamp: Date.now(),
          };
        });

        activeIframeEntitiesStore.set(frame, mapped);
      } catch (err) {
        console.warn('[PrivacyAgent] Error processing iframe PII message:', err);
      }
    }
  });
}

// List of video conferencing, meeting, and sensitive communication apps where
// the agent floating panel must NEVER automatically pop up.
const SENSITIVE_MEETING_PATTERNS = [
  'meet.google.com',
  'zoom.us',
  'teams.microsoft.com',
  'teams.live.com',
  'web.whatsapp.com',
  'web.telegram.org',
  'discord.com',
  'slack.com',
  'webex.com',
  'gotomeeting.com',
  'whereby.com',
  'skype.com',
];

function isMeetingOrSensitiveApp(): boolean {
  const host = location.hostname.toLowerCase();
  return SENSITIVE_MEETING_PATTERNS.some(pattern => host.includes(pattern));
}

// Check whether floating panel should be automatically injected.
// Defaults to FALSE so it does NOT pop up automatically every time user opens an app.
async function shouldAutoInjectPanel(): Promise<boolean> {
  // Never auto-inject on video calls / meeting apps
  if (isMeetingOrSensitiveApp()) return false;

  // Never auto-inject if user closed it in this tab session
  try {
    if (sessionStorage.getItem('__privsight_dismissed__') === '1') return false;
  } catch {}

  const hostClean = location.hostname.replace(/^www\./, '');
  const stored = await chrome.storage.local.get(['autoShowFloatingPanel', 'mutedSites']);
  if (stored.mutedSites?.includes(hostClean)) return false;

  // Only auto-show if user explicitly enabled it in settings
  return !!stored.autoShowFloatingPanel;
}

if (window === window.top) {
  shouldAutoInjectPanel().then((shouldInject) => {
    if (shouldInject) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => injectFloatingPanel());
      } else {
        injectFloatingPanel();
      }
    }
  });
}

// ── STATE HASH ─────────────────────────────────────────────────────────────────

function computeStateHash(): string {
  const elements = document.querySelectorAll('input, button, select, a').length;
  const textLength = document.body.innerText.length;
  const title = document.title;
  // Include all visible input/textarea/select values so that fill actions
  // (which only change field values, not body text) register as state changes.
  const fieldValues = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input:not([type=hidden]):not([type=password]), textarea, select'
    )
  )
    .map(el => el.value.slice(0, 30))
    .join('|');
  return `${elements}-${textLength}-${title.slice(0, 30)}-${location.href.slice(-50)}-${fieldValues}`;
}

// ── PAGE TYPE CLASSIFIER ───────────────────────────────────────────────────────

function classifyPageType(url: string, title: string): string {
  const combined = (url + ' ' + title).toLowerCase();
  if (/login|signin|sign-in|auth/.test(combined)) return 'login';
  if (/payment|checkout|pay|billing/.test(combined)) return 'payment';
  if (/flight|travel|airline|booking|ticket/.test(combined)) return 'travel_booking';
  if (/bank|account|transfer|ledger/.test(combined)) return 'banking';
  if (/health|medical|patient|clinic/.test(combined)) return 'healthcare';
  if (/shop|cart|product|order/.test(combined)) return 'ecommerce';
  if (/mail|inbox|compose|gmail/.test(combined)) return 'email';
  if (/social|profile|feed|post/.test(combined)) return 'social_media';
  if (/wiki/.test(combined)) return 'reference';
  if (/search/.test(combined)) return 'search_results';
  return 'general';
}

// ── ADAPTIVE PERCEPTION LEVEL ─────────────────────────────────────────────────

function determinePerceptionLevel(a11yResult: ReturnType<typeof extractA11yTree>): 1 | 2 | 3 | 4 {
  // Level 1: A11y is rich enough
  if (a11yResult.hasRichA11y && a11yResult.interactiveCount >= 2) return 1;
  // Level 2: DOM + visible text (no OCR needed if text is accessible)
  if (document.body.innerText.length > 200) return 2;
  // Level 3: DOM + OCR (images may contain important text)
  if (document.querySelectorAll('img, canvas, svg').length > 3) return 3;
  // Level 4: screenshot (absolute last resort — currently not used automatically)
  return 2;
}

// ── UI ELEMENT EXTRACTION ─────────────────────────────────────────────────────

function extractUIElements(registryRecords: ElementRecord[]): UIElement[] {
  const elements: UIElement[] = [];

  for (const record of registryRecords) {
    const el = (resolveElementId(record.elementId) || (record.domSelector ? document.querySelector(record.domSelector) : null)) as HTMLElement | null;
    if (!el) continue;

    const rect = el.getBoundingClientRect();
    // Only skip if both element and record bbox have zero size (preserve custom radios/checkboxes with label bbox)
    if (rect.width === 0 && rect.height === 0 && (!record.bbox || (record.bbox.width === 0 && record.bbox.height === 0))) {
      continue;
    }

    const isSensitive = record.sensitive;
    const bbox: BoundingBox = record.bbox;

    const elementType =
      record.tag === 'input' ? (record.inputType || 'text') :
      record.tag === 'button' ? 'button' :
      record.tag === 'select' ? 'select' :
      record.tag === 'textarea' ? 'textarea' :
      record.tag === 'a' ? 'link' : record.tag;

    // Enrich role with container context (e.g. flight card, product card)
    let extraContext = '';
    const parentContainer = el.closest('.flight-card, tr, li, article, section, [data-flight-id], .product_pod, .quote');
    if (parentContainer) {
      const containerText = parentContainer.textContent?.replace(/\s+/g, ' ').trim() || '';
      if (containerText && containerText !== el.textContent?.trim()) {
        const priceMatch = containerText.match(/(?:₹|\$|EUR|USD|INR)\s*[\d,]+/i);
        const priceStr = priceMatch ? ` price:${priceMatch[0]}` : '';
        extraContext = ` (${containerText.slice(0, 200)}${priceStr})`;
      }
    }

    const role = `${record.role}${extraContext}`;
    const inputVal = (el as HTMLInputElement).value;

    elements.push({
      id: record.elementId,          // el_NNN (stable, sent to LLM)
      elementId: record.elementId,
      type: elementType,
      role,
      label: record.ariaLabel || (record.text ? record.text : undefined),
      placeholder: record.placeholder || undefined,
      value: isSensitive ? undefined : (typeof inputVal === 'string' ? inputVal.slice(0, 100) : undefined),
      sensitive: isSensitive,
      sensitivityType: undefined,
      bbox,
      domSelector: record.domSelector,  // kept local, not sent to LLM
      interactable: !(el as any).disabled && !(el as any).readOnly,
      visible: record.visible,
      tagName: record.tag,
      attributes: collectSafeAttributes(el),
      ariaLabel: record.ariaLabel,
      ariaRole: record.ariaRole,
      accessibleName: record.role,
    });
  }

  return elements;
}

function collectSafeAttributes(el: HTMLElement): Record<string, string> {
  const SKIP = new Set(['value', 'style', 'class', 'data-pii-type']);
  const attrs: Record<string, string> = {};
  for (const attr of el.attributes) {
    if (!SKIP.has(attr.name)) attrs[attr.name] = attr.value.slice(0, 100);
  }
  return attrs;
}

// ── MAIN ANALYSIS PIPELINE ─────────────────────────────────────────────────────

let lastAnalysisEntities: any[] = [];

function toCleanSerializableEntities(entities: PIIEntity[]): any[] {
  return (entities || []).map(e => ({
    id: e.id,
    type: e.type,
    confidence: typeof e.confidence === 'number' ? Math.round(e.confidence > 1 ? e.confidence : e.confidence * 100) : 95,
    source: e.source === 'vision' ? 'WebGPU Vision' : e.source === 'dom' ? 'DOM Semantics' : (e.source || 'Local Regex'),
    sensitivity: e.sensitivity || 'HIGH',
    redactionMethod: e.redactionMethod === 'blur' ? 'Gaussian Blur' : e.redactionMethod === 'mask' ? 'Blackout Mask' : 'Semantic Token',
    placeholder: e.placeholder || (e.type === 'face' ? '[FACE BLURRED]' : `[${e.type.toUpperCase()} REDACTED]`),
    detectedText: e.placeholder || (e.type === 'face' ? 'Profile Face Avatar' : `[${e.type.toUpperCase()} REDACTED]`),
    bbox: e.bbox ? { x: Math.round(e.bbox.x), y: Math.round(e.bbox.y), width: Math.round(e.bbox.width), height: Math.round(e.bbox.height) } : undefined,
    domSelector: e.domSelector,
    timestamp: e.timestamp || Date.now(),
  }));
}

async function analyzePage(
  forceRefresh = false,
  rawScreenshot?: string,
  stepId: number | string = 1
): Promise<{ context: SanitizedContext; metrics: ClientMetrics }> {
  const t0 = Date.now();

  // Check if page changed
  const stateHash = computeStateHash();
  if (!forceRefresh && stateHash === lastStateHash && lastAnalysisContext) {
    console.log('[PrivacyAgent] State unchanged — returning cached context');
    const cachedMetrics: ClientMetrics = {
      domAnalysisMs: 0, piiDetectionMs: 0, ocrMs: 0, faceDetectionMs: 0,
      redactionMs: 0, overlayMs: 0, totalClientMs: 0,
      piiDetected: lastAnalysisContext.piiSummary.totalDetected,
      piiRedacted: lastAnalysisContext.piiSummary.totalRedacted,
      perceptionLevel: lastAnalysisContext.perceptionLevel ?? 1,
      elementsFound: lastAnalysisContext.elements.length,
    };
    return {
      context: { ...lastAnalysisContext, piiEntities: lastAnalysisEntities },
      metrics: cachedMetrics
    };
  }

  checkAndResetIfNeeded();

  const url = location.href.split('?')[0];
  const title = document.title;
  const pageType = classifyPageType(url, title);
  const adapter = getAdapter(location.href);
  const adapterName = adapter?.name;

  // ── Stage 1: DOM analysis (A11y tree + element registry) ─────────────────────
  const t_dom = Date.now();
  let a11yResult: ReturnType<typeof extractA11yTree>;
  try {
    a11yResult = extractA11yTree();
  } catch (err) {
    a11yResult = { nodes: [], landmarkSummary: '', formSummary: '' } as any;
  }
  const perceptionLevel = determinePerceptionLevel(a11yResult);
  let registryRecords: ElementRecord[] = [];
  try {
    registryRecords = buildRegistry();
  } catch (err) {
    console.warn('[PrivacyAgent] buildRegistry error:', err);
  }
  const domAnalysisMs = Date.now() - t_dom;

  // ── Stage 2: PII Detection (DOM + text nodes + regex) ───────────────────────
  const t_pii = Date.now();
  let domEntities: PIIEntity[] = [];
  try {
    domEntities = detectPIIFromDOM(currentSettings);
  } catch (err) {
    console.warn('[PrivacyAgent] detectPIIFromDOM error:', err);
  }
  let domTextEntities: PIIEntity[] = [];
  try {
    domTextEntities = detectPIIFromDOMText(currentSettings);
  } catch (err) {
    console.warn('[PrivacyAgent] detectPIIFromDOMText error:', err);
  }
  const bodyText = document.body ? (document.body.innerText ?? '') : '';
  let textEntities: PIIEntity[] = [];
  try {
    textEntities = detectPIIFromText(bodyText, 'regex', currentSettings);
  } catch (err) {
    console.warn('[PrivacyAgent] detectPIIFromText error:', err);
  }
  const piiDetectionMs = Date.now() - t_pii;

  // ── Stage 3: OCR / Image-Text scan ───────────────────────────────────────────
  const t_ocr = Date.now();
  let ocrTexts: string[] = [];
  let ocrEntities: PIIEntity[] = [];
  try {
    const imgTexts: string[] = [];
    document.querySelectorAll<HTMLImageElement>('img[alt], [title]').forEach(el => {
      const txt = (el.getAttribute('alt') || el.getAttribute('title') || '').trim();
      if (txt.length > 5) imgTexts.push(txt);
    });
    if (imgTexts.length > 0) {
      ocrTexts = imgTexts.slice(0, 15);
      const combined = imgTexts.join(' | ');
      ocrEntities = detectPIIFromText(combined, 'ocr', currentSettings);
    }
  } catch (err) {
    console.warn('[PrivacyAgent] OCR scan warning:', err);
  }
  const ocrMs = Date.now() - t_ocr;

  // ── Stage 4: Face & Visual PII detection (On-Device Vision Model) ──────────────
  const t_face = Date.now();
  let faceEntities: PIIEntity[] = [];
  let screenCanvas: HTMLCanvasElement | undefined;

  // If raw screenshot was not passed directly, request it from background service worker
  if (!rawScreenshot && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const shotResp = await new Promise<any>((resolve) => {
        chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (r) => {
          if (chrome.runtime.lastError || !r) resolve(null);
          else resolve(r);
        });
      });
      if (shotResp && (shotResp.dataUrl || shotResp.screenshot)) {
        rawScreenshot = shotResp.dataUrl || shotResp.screenshot;
      }
    } catch {}
  }

  if (rawScreenshot) {
    try {
      const img = new Image();
      img.src = rawScreenshot;
      await new Promise((res) => { img.onload = res; img.onerror = res; });
      screenCanvas = document.createElement('canvas');
      screenCanvas.width = img.naturalWidth || window.innerWidth;
      screenCanvas.height = img.naturalHeight || window.innerHeight;
      const sCtx = screenCanvas.getContext('2d');
      sCtx?.drawImage(img, 0, 0);
    } catch (imgErr) {
      console.warn('[PrivacyAgent] Failed to prepare screen canvas for vision model:', imgErr);
    }
  }

  const dpr = window.devicePixelRatio || 1;

  if (currentSettings.enableFaceDetection) {
    try {
      const faces = await detectFaces(screenCanvas, dpr);
      faceEntities = faces.map(f => createFaceEntity(f.bbox, f.confidence, f.domElement, f.isFixed));
    } catch (err) {
      console.warn('[PrivacyAgent] Face detection warning:', err);
    }
  }
  const faceDetectionMs = Date.now() - t_face;

  // ── Stage 4b: YOLOS-Tiny Object Detection (local neural network) ──────────────
  // Runs alongside the existing pixel-heuristic face detector.
  // Uses WebGPU when available, WASM as fallback.
  // Returns [] gracefully if model is unavailable — no functionality lost.
  let yolosEntities: import('../utils/types').PIIEntity[] = [];
  let yolosStats: VisionInferenceStats | undefined;
  if (screenCanvas && currentSettings.enableFaceDetection) {
    try {
      const yolosResult = await runYOLOSDetection(screenCanvas, window.scrollX, window.scrollY, 0.70, dpr);
      yolosEntities = yolosResult.entities;
      yolosStats = yolosResult.stats;
      if (yolosEntities.length > 0) {
        console.log(`[PrivacyAgent] YOLOS: ${yolosEntities.length} PII objects detected in ${yolosStats.inferenceMs}ms (${yolosStats.backend})`);
      }
    } catch (yolosErr) {
      console.warn('[PrivacyAgent] YOLOS detection warning:', yolosErr);
    }
  }

  // ── Stage 4c: Child Iframe PII & Payment Gateway Card Detection ───────────
  const childIframeEntities: PIIEntity[] = [];
  try {
    // Proactively ping child iframes to send fresh PII if not already sent
    document.querySelectorAll<HTMLIFrameElement>('iframe').forEach(f => {
      try { f.contentWindow?.postMessage({ type: '__PRIVSIGHT_REQUEST_IFRAME_PII__' }, '*'); } catch {}
    });

    for (const [frame, ents] of activeIframeEntitiesStore.entries()) {
      if (document.contains(frame)) {
        const fRect = frame.getBoundingClientRect();
        if (fRect.width > 0 && fRect.height > 0) {
          childIframeEntities.push(...ents);
        }
      } else {
        activeIframeEntitiesStore.delete(frame);
      }
    }

    // Payment Gateway Fallback:
    // If a payment checkout frame (Razorpay, Stripe) is present on page but child iframe PII has not arrived yet,
    // synthesize exact card input slots for Card Number, Expiry, and CVV fields.
    const paymentFrames = document.querySelectorAll<HTMLIFrameElement>(
      'iframe.razorpay-checkout-frame, iframe[src*="razorpay"], iframe[name*="razorpay"], .razorpay-checkout-frame, .razorpay-container iframe, iframe[src*="stripe"]'
    );
    paymentFrames.forEach(pFrame => {
      const pRect = pFrame.getBoundingClientRect();
      if (pRect.width < 100 || pRect.height < 100) return;

      const hasExistingCard = childIframeEntities.some(e =>
        (e.type === 'credit_card' || e.type === 'cvv') &&
        e.bbox && e.bbox.x >= pRect.left - 20 && e.bbox.x <= pRect.right + 20
      );
      if (!hasExistingCard) {
        const isRzp = /razorpay/i.test(pFrame.className + ' ' + (pFrame.src || '') + ' ' + (pFrame.name || ''));
        if (isRzp) {
          // Razorpay's iframe is full-viewport. The actual checkout dialog is centered on screen:
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const isFullIframe = pRect.width >= vw * 0.85 && pRect.height >= vh * 0.85;
          const isDesktop = vw >= 768;

          // Razorpay standard modal dialog sizing (1000px x 486px on desktop, or responsive max on smaller screens)
          const modalW = isDesktop ? Math.min(1000, Math.round(vw * 0.90)) : Math.min(480, Math.round(vw * 0.94));
          const modalH = isDesktop ? Math.min(486, Math.round(vh * 0.88)) : Math.min(560, Math.round(vh * 0.92));
          const modalVpLeft = isFullIframe ? Math.round((vw - modalW) / 2) : Math.round(pRect.left + (pRect.width - modalW) / 2);
          const modalVpTop = isFullIframe
            ? (isDesktop ? Math.max(20, Math.round((vh - modalH) / 2 - 50)) : Math.max(10, Math.round((vh - modalH) / 2)))
            : Math.round(pRect.top + (pRect.height - modalH) / 2);

          // Card Number input (top row of card container in Razorpay modal)
          // Exact dimensions matching desktop Razorpay: left=modalLeft+578, top=modalTop+114, width=389, height=43
          const cardVpX = isDesktop ? Math.round(modalVpLeft + modalW * 0.578) : Math.round(modalVpLeft + modalW * 0.05);
          const cardW = isDesktop ? Math.round(modalW * 0.389) : Math.round(modalW * 0.90);
          const cardVpY = isDesktop ? Math.round(modalVpTop + modalH * 0.235) : Math.round(modalVpTop + modalH * 0.30);
          const cardH = 43;

          // Expiry input (bottom-left cell of card container, flush under Card Number)
          const expVpX = cardVpX;
          const expW = Math.round(cardW / 2); // ~194px
          const expVpY = cardVpY + cardH; // flush under Card Number (e.g. 307px)
          const expH = 43;

          // CVV input (bottom-right cell of card container, flush next to Expiry)
          const cvvVpX = cardVpX + expW; // flush next to Expiry (e.g. 1023px)
          const cvvW = cardW - expW; // ~195px
          const cvvVpY = expVpY;
          const cvvH = 43;

          // Convert to page coordinates (for storage in entity.bbox)
          const cardX = cardVpX + window.scrollX;
          const cardY = cardVpY + window.scrollY;
          const expX = expVpX + window.scrollX;
          const expY = expVpY + window.scrollY;
          const cvvX = cvvVpX + window.scrollX;
          const cvvY = cvvVpY + window.scrollY;

          childIframeEntities.push(
            {
              id: `fallback-card-${Date.now()}`,
              type: 'credit_card',
              confidence: 0.98,
              source: 'dom',
              sensitivity: 'CRITICAL',
              redactionMethod: 'mask',
              bbox: { x: cardX, y: cardY, width: cardW, height: cardH },
              placeholder: '[CARD REDACTED]',
              isFixed: true,
              timestamp: Date.now(),
            },
            {
              id: `fallback-exp-${Date.now()}`,
              type: 'credit_card',
              confidence: 0.95,
              source: 'dom',
              sensitivity: 'CRITICAL',
              redactionMethod: 'mask',
              bbox: { x: expX, y: expY, width: expW, height: expH },
              placeholder: '[CARD REDACTED]',
              isFixed: true,
              timestamp: Date.now(),
            },
            {
              id: `fallback-cvv-${Date.now()}`,
              type: 'cvv',
              confidence: 0.98,
              source: 'dom',
              sensitivity: 'CRITICAL',
              redactionMethod: 'mask',
              bbox: { x: cvvX, y: cvvY, width: cvvW, height: cvvH },
              placeholder: '[CVV REDACTED]',
              isFixed: true,
              timestamp: Date.now(),
            }
          );
        }
      }
    });
  } catch (err) {
    console.warn('[PrivacyAgent] Child iframe PII aggregation warning:', err);
  }

  // ── Stage 5: Combine + apply policy ────────────────────────────────────────
  // YOLOS + child iframe payment entities merged in — all feed the same redaction pipeline
  const allEntities = [
    ...domEntities,
    ...childIframeEntities,
    ...domTextEntities,
    ...textEntities,
    ...ocrEntities,
    ...faceEntities,
    ...yolosEntities
  ];
  const appliedEntities = applyPolicy(allEntities, currentSettings)
    .filter(e => !isEntityOccluded(e));
  currentEntities = appliedEntities;

  // ── Stage 6: Redaction (DOM, Text & Pixel Screenshot) ────────────────────────
  const t_redact = Date.now();
  let rawElements = extractUIElements(registryRecords);
  if (adapter) {
    try {
      rawElements = adapter.normalizeElements(rawElements);
    } catch (err) {
      console.warn('[PrivacyAgent] Adapter normalization warning:', err);
    }
  }
  const sanitizedElems = sanitizeElements(rawElements, appliedEntities);

  let sanitizedText = redactText(bodyText.slice(0, 3000), appliedEntities);
  if (adapter) {
    try {
      const enriched = adapter.enrichPageContext({
        url: location.href,
        domain: new URL(location.href).hostname,
        elements: rawElements,
        visibleText: sanitizedText,
        title,
      });
      sanitizedText = enriched.visibleText;
    } catch (err) {
      console.warn('[PrivacyAgent] Adapter enrichment warning:', err);
    }
  }
  if (perceptionLevel === 1 && a11yResult.nodes?.length) {
    sanitizedText = `${formatA11yForLLM(a11yResult)}\n\nPAGE TEXT:\n${sanitizedText}`;
  }

  // Redact screenshot if raw image provided
  let sanitizedScreenshot: string | undefined;
  let screenshotIncluded = false;
  if (rawScreenshot) {
    try {
      const dpr = window.devicePixelRatio || 1;
      const redResult = await processScreenshot(
        rawScreenshot,
        appliedEntities,
        window.scrollX,
        window.scrollY,
        dpr
      );
      sanitizedScreenshot = redResult.redactedDataUrl;
      screenshotIncluded = true;
      emitAuditEvent('screenshot_redacted', {
        detail: `Visible tab screenshot sanitized and redacted locally (${redResult.entitiesApplied} entities). 0 raw PII pixels transmitted.`
      });
    } catch (scErr) {
      console.warn('[PrivacyAgent] processScreenshot error, falling back:', scErr);
      try {
        sanitizedScreenshot = await loadAndRedactScreenshot(
          rawScreenshot,
          appliedEntities,
          window.scrollX,
          window.scrollY
        );
        screenshotIncluded = true;
      } catch (fbErr) {
        console.warn('[PrivacyAgent] Fallback screenshot redaction failed:', fbErr);
      }
    }
  }

  const redactionMs = Date.now() - t_redact;

  // ── Stage 7: Overlay rendering ────────────────────────────────────────────────
  const t_overlay = Date.now();
  try {
    maskLifecycleManager.createMasks(appliedEntities, stepId);
    if (isFloatingPanelVisible()) {
      updatePanelStats(appliedEntities.length);
    }
  } catch (err) {
    console.warn('[PrivacyAgent] Overlay render warning:', err);
  }
  const overlayMs = Date.now() - t_overlay;

  // Emit audit events for each detected PII entity
  appliedEntities.forEach(e => {
    emitAuditEvent('pii_detected', {
      piiType: e.type, confidence: e.confidence, source: e.source,
      redactionMethod: e.redactionMethod, detail: `${e.type} detected via ${e.source}`,
    });
  });

  // Measure client memory (Chrome only)
  let memoryUsedMB: number | undefined;
  if ((performance as any).memory) {
    memoryUsedMB = Math.round((performance as any).memory.usedJSHeapSize / 1048576 * 10) / 10;
  }

  const totalClientMs = Date.now() - t0;

  const metrics: ClientMetrics = {
    domAnalysisMs,
    piiDetectionMs,
    ocrMs,
    faceDetectionMs,
    redactionMs,
    overlayMs,
    totalClientMs,
    piiDetected: appliedEntities.length,
    piiRedacted: appliedEntities.length,
    perceptionLevel,
    elementsFound: sanitizedElems.length,
    memoryUsedMB,
    visionStats: yolosStats,
  };

  const cleanEntities = toCleanSerializableEntities(appliedEntities);
  lastAnalysisEntities = cleanEntities;

  const context: SanitizedContext = {
    pageUrl: url,
    pageTitle: title,
    pageType,
    timestamp: Date.now(),
    rawElements: (rawElements || []).slice(0, 50).map(e => (e.sensitive ? { ...e, value: undefined } : e)),
    elements: sanitizedElems,
    sanitizedText,
    ocrTexts,
    piiSummary: {
      totalDetected: appliedEntities.length,
      totalRedacted: appliedEntities.length,
      byType: appliedEntities.reduce((acc, e) => ({ ...acc, [e.type]: (acc[e.type] ?? 0) + 1 }), {} as Record<string, number>),
    },
    screenshotIncluded,
    screenshot: sanitizedScreenshot,
    sanitizedScreenshot,
    perceptionLevel,
    stateHash,
    siteAdapter: adapterName,
    piiEntities: cleanEntities,
  };

  lastStateHash = stateHash;
  lastAnalysisContext = context;

  console.log(`[PrivacyAgent] Analysis in ${totalClientMs}ms | DOM:${domAnalysisMs}ms PII:${piiDetectionMs}ms OCR:${ocrMs}ms Face:${faceDetectionMs}ms Redact:${redactionMs}ms | Level ${perceptionLevel} | PII: ${appliedEntities.length} | Screenshot: ${screenshotIncluded}`);
  return { context, metrics };
}

// ── VISUAL OVERLAY (MANAGED VIA MASK LIFECYCLE MANAGER) ───────────────────────

function renderOverlay(entities: PIIEntity[], stepId: number | string = 1): void {
  maskLifecycleManager.createMasks(entities, stepId);
}

function clearOverlay(reason = 'explicit_clear'): void {
  maskLifecycleManager.cleanupMasks(reason);
}

// ── AUDIT LOGGING ─────────────────────────────────────────────────────────────

function emitAuditEvent(type: AuditEvent['type'], data: Partial<AuditEvent>): void {
  const event: AuditEvent = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    timestamp: Date.now(),
    type,
    detail: data.detail ?? '',
    rawDataTransmitted: false,
    ...data,
  };
  auditLog.push(event);
  chrome.runtime.sendMessage({ type: 'AUDIT_EVENT', event }).catch(() => {});
}

// ── VOICE RECOGNITION (DELEGATED FROM POPUP FOR DIRECT NATIVE PROMPT) ────────
let onPageVoiceManager: SpeechRecognitionManager | null = null;

function handleStartVoiceInput(): boolean {
  if (!onPageVoiceManager) {
    onPageVoiceManager = new SpeechRecognitionManager();
  }
  if (!onPageVoiceManager.isSupported) {
    chrome.runtime.sendMessage({
      type: 'VOICE_ERROR',
      errorMsg: 'Voice recognition is not supported in this browser.',
      errorCode: 'not-supported',
    });
    return false;
  }

  // Directly trigger Chrome's native microphone prompt on this webpage
  try {
    if (navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
      }).catch(() => {
        chrome.runtime.sendMessage({
          type: 'VOICE_ERROR',
          errorMsg: 'Microphone permission denied.',
          errorCode: 'not-allowed',
        });
      });
    }
  } catch {}

  return onPageVoiceManager.start(
    {
      onStateChange: (listening) => {
        chrome.runtime.sendMessage({ type: 'VOICE_STATE_CHANGE', isListening: listening });
      },
      onTranscript: (transcript, isFinal) => {
        chrome.runtime.sendMessage({ type: 'VOICE_TRANSCRIPT', transcript, isFinal });
      },
      onError: (errorMsg, errorCode) => {
        chrome.runtime.sendMessage({ type: 'VOICE_ERROR', errorMsg, errorCode });
      },
    },
    ''
  );
}

function handleStopVoiceInput(): void {
  onPageVoiceManager?.stop();
}

// ── MESSAGE HANDLER ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  // Never let sub-frames (invisible tracking scripts, Stripe fraud frames, etc.) handle tab-level page analysis or actions
  if (window !== window.top && (message.type === 'ANALYZE_PAGE' || message.type === 'ACTION_REQUEST')) {
    return;
  }
  (async () => {
    switch (message.type) {

      case 'ANALYZE_PAGE': {
        try {
          const timeoutPromise = new Promise<{ context: SanitizedContext; metrics: ClientMetrics }>((_, reject) =>
            setTimeout(() => reject(new Error('analyzePage timeout')), 8000)
          );
          const { context, metrics } = await Promise.race([
            analyzePage(message.forceRefresh === true, message.screenshot, message.stepId),
            timeoutPromise
          ]);
          sendResponse({
            context,
            piiEntities: context.piiEntities || toCleanSerializableEntities(currentEntities),
            clientMetrics: metrics
          });
        } catch (err) {
          console.error('[PrivacyAgent] analyzePage threw fatal error:', err);
          const safeContext: SanitizedContext = {
            pageUrl: location.href.split('?')[0],
            pageTitle: document.title || '',
            pageType: 'general',
            timestamp: Date.now(),
            elements: [],
            sanitizedText: '',
            ocrTexts: [],
            piiSummary: { totalDetected: 0, totalRedacted: 0, byType: {} },
            screenshotIncluded: false,
            perceptionLevel: 1,
            stateHash: computeStateHash(),
          };
          sendResponse({
            context: safeContext,
            piiEntities: [],
            clientMetrics: {
              domAnalysisMs: 0, piiDetectionMs: 0, ocrMs: 0, faceDetectionMs: 0,
              redactionMs: 0, overlayMs: 0, totalClientMs: 0, piiDetected: 0,
              piiRedacted: 0, perceptionLevel: 1, elementsFound: 0,
            }
          });
        }
        break;
      }

      case 'ACTION_REQUEST': {
        const { action, actionId } = message;
        const validationError = validateAction(action);
        if (validationError) {
          sendResponse({ success: false, error: validationError });
          emitAuditEvent('action_blocked', { detail: `Action blocked: ${validationError}` });
          return;
        }

        // Site adapter action validation
        const adapter = getAdapter(location.href);
        if (adapter) {
          const adapterError = adapter.validateAction(action);
          if (adapterError) {
            sendResponse({ success: false, error: adapterError });
            emitAuditEvent('action_blocked', { detail: `Adapter blocked: ${adapterError}` });
            return;
          }
        }

        // Approval check from settings
        if (currentSettings.requireApprovalFor.includes(action.action)) {
          console.log('[PrivacyAgent] Action requires approval:', action.action);
          // In production: block and wait for user input message
          // For now: auto-approve navigate in demo mode
        }

        maskLifecycleManager.onActionExecuting(action);
        let result: any;
        try {
          result = await executeAction(action);
        } finally {
          maskLifecycleManager.onActionCompleted(action);
        }
        emitAuditEvent('action_executed', { detail: `${action.action} → ${action.reason}` });
        sendResponse(result);
        break;
      }

      case 'SETTINGS_UPDATE': {
        currentSettings = message.settings;
        chrome.storage.local.set({ privacySettings: currentSettings });
        sendResponse({ ok: true });
        break;
      }

      case 'GET_STATUS': {
        sendResponse({ entities: currentEntities, auditLog: auditLog.slice(-50) });
        break;
      }

      case 'CLEAR_OVERLAYS': {
        maskLifecycleManager.cleanupMasks((message as any).reason || 'message_clear', (message as any).stepId);
        checkAndResetIfNeeded();
        sendResponse({ ok: true });
        break;
      }

      case 'TOGGLE_FLOATING_PANEL': {
        const isVisible = toggleFloatingPanel(message.show);
        sendResponse({ ok: true, visible: isVisible });
        break;
      }

      case 'START_VOICE_INPUT': {
        const ok = handleStartVoiceInput();
        sendResponse({ ok });
        break;
      }

      case 'STOP_VOICE_INPUT': {
        handleStopVoiceInput();
        sendResponse({ ok: true });
        break;
      }

      case 'SPEAK_ACTION_STATUS': {
        const text = (message as any).text;
        if (text) {
          try {
            chrome.storage.session?.get(['popupOpen'], (sessionRes) => {
              if (!sessionRes?.popupOpen) {
                voiceOutputManager.speak(text);
              }
            });
          } catch {
            voiceOutputManager.speak(text);
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case 'VOICE_OUTPUT_TOGGLED': {
        const enabled = (message as any).enabled;
        if (typeof enabled === 'boolean') {
          voiceOutputManager.setEnabled(enabled);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'TASK_STATE_CHANGE': {
        const state = (message as any).taskState;
        updateAgentBorder(state);
        if (state === 'IDLE' || state === 'COMPLETED' || state === 'ERROR') {
          maskLifecycleManager.cleanupMasks('task_state_' + state);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'STATUS_UPDATE': {
        const state = (message as any).taskState || (message as any).status;
        updateAgentBorder(state);
        if (state === 'IDLE' || state === 'COMPLETED' || state === 'ERROR') {
          maskLifecycleManager.cleanupMasks('status_update_' + state);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'STEP_UPDATE': {
        const step = message as any;
        if (step?.label) {
          updateAgentBorder('EXECUTING', step.label);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'TASK_DONE': {
        removeAgentBorder();
        maskLifecycleManager.cleanupMasks('task_done');
        sendResponse({ ok: true });
        break;
      }
    }
  })();
  return true; // Keep message channel open for async response
});

// ── SPA / TURBO / PJAX NAVIGATION DETECTION ──────────────────────────────────
let lastRecordedHref = location.href;
function handleSpaNavigation() {
  if (location.href !== lastRecordedHref) {
    console.log('[PrivacyAgent] SPA Navigation detected:', lastRecordedHref, '->', location.href);
    lastRecordedHref = location.href;
    maskLifecycleManager.onNavigation();
    checkAndResetIfNeeded();
  }
}

window.addEventListener('popstate', handleSpaNavigation);
window.addEventListener('hashchange', handleSpaNavigation);
window.addEventListener('turbo:render', () => { maskLifecycleManager.onNavigation(); checkAndResetIfNeeded(); });
window.addEventListener('turbo:load', () => { maskLifecycleManager.onNavigation(); checkAndResetIfNeeded(); });
document.addEventListener('pjax:end', () => { maskLifecycleManager.onNavigation(); checkAndResetIfNeeded(); });
window.addEventListener('beforeunload', () => { maskLifecycleManager.cleanupMasks('unload'); });

try {
  const origPush = history.pushState;
  history.pushState = function(...args) {
    const res = origPush.apply(this, args);
    handleSpaNavigation();
    return res;
  };
  const origReplace = history.replaceState;
  history.replaceState = function(...args) {
    const res = origReplace.apply(this, args);
    handleSpaNavigation();
    return res;
  };
} catch {}

// ── WINDOW MESSAGE BRIDGE (DASHBOARD TO EXTENSION) ─────────────────────────────
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'START_TASK_FROM_DASHBOARD') {
    console.log('[PrivacyAgent] Received task request from dashboard:', event.data.task);
    chrome.runtime.sendMessage({
      type: 'START_TASK',
      instruction: event.data.task,
      sessionId: event.data.sessionId,
    });
  }
});

// ── ON-PAGE SCAN TRIGGER (FROM FLOATING PANEL) ───────────────────────────────
window.addEventListener('privsight:scan', async () => {
  try {
    const { context } = await analyzePage(true);
    if (context?.piiSummary) {
      updatePanelStats(context.piiSummary.totalRedacted || context.piiSummary.totalDetected || 0);
    }
  } catch (err) {
    console.warn('[PrivacyAgent] privsight:scan handler error:', err);
  }
});

console.log('[PrivacyAgent] Content script initialized on', location.href,
  '| Site:', getSiteStatus(location.href).compatibility);

// Query background on page load so agent border shows immediately if a task is running (top frame only)
if (window === window.top) {
  try {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp?.taskState && resp.taskState !== 'IDLE' && resp.taskState !== 'COMPLETED' && resp.taskState !== 'ERROR') {
        updateAgentBorder(resp.taskState);
      }
    });
  } catch {}
}

// ── CHILD IFRAME AUTO-PROTECTION (RAZORPAY / STRIPE / PAYMENT GATEWAYS) ────────
if (window !== window.top) {
  const autoProtectIframe = () => {
    try {
      const entities = [
        ...detectPIIFromDOM(currentSettings),
        ...detectPIIFromDOMText(currentSettings),
      ];
      if (entities.length > 0) {
        maskLifecycleManager.createMasks(entities);
        // Relay detected PII to parent frame for screenshot canvas redaction & unified auditing
        const serializable = entities.map(e => ({
          id: e.id,
          type: e.type,
          sensitivity: e.sensitivity,
          confidence: e.confidence,
          placeholder: e.placeholder,
          rawValue: e.rawValue,
          bbox: e.bbox ? {
            x: Math.round(e.bbox.x - window.scrollX),
            y: Math.round(e.bbox.y - window.scrollY),
            width: Math.round(e.bbox.width),
            height: Math.round(e.bbox.height),
          } : undefined,
        }));
        try {
          window.parent.postMessage({
            type: '__PRIVSIGHT_IFRAME_PII__',
            entities: serializable,
          }, '*');
        } catch {}
        try {
          chrome.runtime.sendMessage({
            type: 'CHILD_FRAME_PII',
            entities: serializable,
          }).catch(() => {});
        } catch {}
      }
    } catch {}
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoProtectIframe);
  } else {
    autoProtectIframe();
  }

  document.addEventListener('input', autoProtectIframe, true);
  document.addEventListener('change', autoProtectIframe, true);
  document.addEventListener('focusin', autoProtectIframe, true);

  window.addEventListener('message', (ev) => {
    if (ev.data?.type === '__PRIVSIGHT_REQUEST_IFRAME_PII__') {
      autoProtectIframe();
    }
  });

  try {
    const frameObserver = new MutationObserver(() => {
      autoProtectIframe();
    });
    frameObserver.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  } catch {}
}

