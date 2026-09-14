/**
 * PII Detector — Layer 1 (DOM) + Layer 2 (OCR/Regex) + Layer 3 (Vision)
 *
 * Detection priority: DOM semantics → regex → OCR → vision model
 * Fail-safe: uncertain → BLOCK/REDACT
 */

import type {
  PIIEntity, PIIType, SensitivityLevel, RedactionMethod,
  PIISource, BoundingBox, OcrWord, PrivacySettings
} from '../utils/types';
import { isElementFixedOrSticky } from '../vision/face-detector';
import { isElementOccluded, isRectOccluded } from '../utils/dom-visibility';

let entityCounter = 0;
const nextId = () => `pii-${Date.now()}-${++entityCounter}`;

// ── SENSITIVITY & REDACTION MAP ────────────────────────────────────────────────

export const SENSITIVITY_MAP: Record<PIIType, SensitivityLevel> = {
  password:       'CRITICAL',
  credit_card:    'CRITICAL',
  cvv:            'CRITICAL',
  aadhaar:        'CRITICAL',
  api_key:        'CRITICAL',
  auth_token:     'CRITICAL',
  ssn:            'CRITICAL',
  passport:       'CRITICAL',
  pan:            'HIGH',
  email:          'HIGH',
  phone:          'HIGH',
  address:        'HIGH',
  face:           'HIGH',
  account_number: 'HIGH',
  upi:            'HIGH',
  ifsc:           'HIGH',
  dob:            'HIGH',
  qr_code:        'HIGH',
  barcode:        'MEDIUM',
  signature:      'HIGH',
  name:           'MEDIUM',
};

export const REDACTION_MAP: Record<SensitivityLevel, RedactionMethod> = {
  CRITICAL: 'remove',
  HIGH:     'mask',
  MEDIUM:   'replace',
  LOW:      'replace',
};

export const PLACEHOLDER_MAP: Record<PIIType, string> = {
  email:          '[EMAIL REDACTED]',
  phone:          '[PHONE REDACTED]',
  name:           '[PERSON]',
  address:        '[ADDRESS REDACTED]',
  credit_card:    '[CARD REDACTED]',
  cvv:            '[CVV REDACTED]',
  password:       '[PASSWORD REMOVED]',
  aadhaar:        '[GOVT-ID REDACTED]',
  pan:            '[GOVT-ID REDACTED]',
  dob:            '[DOB REDACTED]',
  upi:            '[PAYMENT-ID REDACTED]',
  ifsc:           '[BANK-CODE REDACTED]',
  api_key:        '[API-KEY REDACTED]',
  auth_token:     '[TOKEN REDACTED]',
  face:           '[FACE BLURRED]',
  qr_code:        '[QR-CODE REDACTED]',
  barcode:        '[BARCODE REDACTED]',
  signature:      '[SIGNATURE REDACTED]',
  account_number: '[ACCOUNT REDACTED]',
  ssn:            '[GOVT-ID REDACTED]',
  passport:       '[GOVT-ID REDACTED]',
};

// ── REGEX PATTERNS ─────────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const PHONE_REGEX = /^(?:\+?\d{1,3}[\s\-]?)?(?:\(?\d{2,4}\)?[\s\-]?)?\d{3,5}[\s\-]?\d{3,5}$/;

const PATTERNS: Array<{ type: PIIType; pattern: RegExp; confidence: number }> = [
  // Email
  { type: 'email',       pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,                      confidence: 0.98 },
  // Phone (Indian +91 format, 10-digit, with flexible separators)
  { type: 'phone',       pattern: /(?:\+91[\s\-]?)?[6-9]\d{4}[\s\-]?\d{5}\b/g,                                   confidence: 0.92 },
  { type: 'phone',       pattern: /(?:\+91[\s\-]?)?[6-9]\d{2,4}[\s\-]?\d{2,4}[\s\-]?\d{3,5}\b/g,                 confidence: 0.90 },
  // International phone
  { type: 'phone',       pattern: /\+?1?\s?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/g,                              confidence: 0.85 },
  // Credit card (13 to 19 digits, with spaces or dashes e.g. 6027 6589 0000 1005)
  { type: 'credit_card', pattern: /\b(?:\d[ \-]?){12,18}\d\b/g,                                                   confidence: 0.92 },
  // Card Expiry Date (MM / YY or MM/YY e.g. 12 / 29)
  { type: 'credit_card', pattern: /\b(?:0[1-9]|1[0-2])\s*\/\s*(?:2\d|3\d)\b/g,                                  confidence: 0.88 },
  // Aadhaar (12 digits, starting with 2-9, separated by spaces or dashes)
  { type: 'aadhaar',     pattern: /\b[2-9]\d{3}[\s-]\d{4}[\s-]\d{4}\b/g,                                          confidence: 0.92 },
  // PAN Card
  { type: 'pan',         pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,                                                   confidence: 0.97 },
  // UPI ID (handles without TLD, e.g. user@oksbi, user@paytm)
  { type: 'upi',         pattern: /\b[\w.\-]+@[a-z0-9]+(?!\.[a-zA-Z]{2,})\b/g,                                   confidence: 0.90 },
  // IFSC Code
  { type: 'ifsc',        pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,                                                    confidence: 0.95 },
  // API Key / Token patterns (hex strings, JWT-like, long random strings)
  { type: 'api_key',     pattern: /\b(?:sk[-_]|pk[-_]|api[-_]?key[\s:=]+)[A-Za-z0-9\-_]{20,}\b/gi,              confidence: 0.93 },
  // JWT tokens
  { type: 'auth_token',  pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b/g,             confidence: 0.99 },
  // URLs with sensitive params
  { type: 'auth_token',  pattern: /[?&](?:token|access_token|auth|api_key|key|secret)=[^&\s"']+/gi,              confidence: 0.90 },
  // Passport number (simplified pattern)
  { type: 'passport',    pattern: /\b[A-Z]{1,2}[0-9]{6,9}\b/g,                                                   confidence: 0.70 },
  // Account numbers (8-18 digits, context-dependent)
  { type: 'account_number', pattern: /\b\d{8,18}\b/g,                                                             confidence: 0.55 },
  // Date of birth patterns
  { type: 'dob',         pattern: /\b(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/gi, confidence: 0.75 },
];

// DOM input types/autocomplete values that always indicate sensitivity
const SENSITIVE_INPUT_TYPES = new Set(['password', 'hidden']);
const SENSITIVE_AUTOCOMPLETE: Record<string, PIIType> = {
  'current-password':  'password',
  'new-password':      'password',
  'cc-number':         'credit_card',
  'cc-csc':            'cvv',
  'cc-exp':            'credit_card',
  'cc-exp-month':      'credit_card',
  'cc-exp-year':       'credit_card',
  'cc-name':           'name',
  'email':             'email',
  'tel':               'phone',
  'name':              'name',
  'given-name':        'name',
  'family-name':       'name',
  'street-address':    'address',
  'address-line1':     'address',
  'postal-code':       'address',
  'bday':              'dob',
  'one-time-code':     'password',
};

const SENSITIVE_PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; type: PIIType }> = [
  { pattern: /email|e-mail/i,                               type: 'email' },
  { pattern: /phone|mobile|cell|contact.?no/i,               type: 'phone' },
  { pattern: /password|pass|pin\b/i,                         type: 'password' },
  { pattern: /card|credit|debit|cc[-_]?num|pan\b/i,          type: 'credit_card' },
  { pattern: /cvv|cvc|csc|security.?code|verification/i,     type: 'cvv' },
  { pattern: /exp|expiry|expiration|valid.?thru|mm\s*\/?\s*yy/i, type: 'credit_card' },
  { pattern: /otp|one[-_]?time|passcode/i,                   type: 'password' },
  { pattern: /aadhaar|aadhar/i,                              type: 'aadhaar' },
  { pattern: /\bpan\b/i,                                     type: 'pan' },
  { pattern: /address/i,                                     type: 'address' },
  { pattern: /upi/i,                                         type: 'upi' },
  { pattern: /ifsc/i,                                        type: 'ifsc' },
];

// ── LAYER 1: DOM ANALYSIS ─────────────────────────────────────────────────────

export function detectPIIFromDOM(settings: PrivacySettings): PIIEntity[] {
  const entities: PIIEntity[] = [];
  const enabledTypes = new Set(settings.enabledCategories);

  // Query all input, select, textarea elements in top-level document
  const formElements = document.querySelectorAll<HTMLElement>(
    'input, select, textarea, [data-pii-type]'
  );

  formElements.forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return; // hidden element
    if (isElementOccluded(el, rect)) return; // occluded or covered by modal/backdrop

    const bbox: BoundingBox = {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
    };

    const input = el as HTMLInputElement;
    const type = input.type?.toLowerCase() ?? '';
    const autoComplete = input.autocomplete?.toLowerCase() ?? '';
    const name = input.name?.toLowerCase() ?? '';
    const id = input.id?.toLowerCase() ?? '';
    const placeholder = input.placeholder?.toLowerCase() ?? '';
    const dataPiiType = el.getAttribute('data-pii-type') ?? '';

    const ariaLabel = input.getAttribute('aria-label')?.toLowerCase() ?? '';
    const ariaPlaceholder = input.getAttribute('aria-placeholder')?.toLowerCase() ?? '';
    const titleAttr = input.getAttribute('title')?.toLowerCase() ?? '';
    const testId = input.getAttribute('data-testid')?.toLowerCase() ?? '';
    const className = (input.className && typeof input.className === 'string') ? input.className.toLowerCase() : '';
    const labelText = (input.closest('label')?.textContent || input.previousElementSibling?.textContent || '').toLowerCase();
    const combinedDescriptor = `${name} ${id} ${placeholder} ${ariaLabel} ${ariaPlaceholder} ${titleAttr} ${testId} ${className} ${labelText}`;

    let detectedType: PIIType | null = null;
    let confidence = 0;

    // Rule 1: Explicit data-pii-type attribute (demo site)
    if (dataPiiType && enabledTypes.has(dataPiiType as PIIType)) {
      detectedType = dataPiiType as PIIType;
      confidence = 1.0;
    }
    // Rule 2: Password input type
    else if (SENSITIVE_INPUT_TYPES.has(type) && type === 'password') {
      detectedType = 'password';
      confidence = 1.0;
    }
    // Rule 3: Autocomplete attribute
    else if (autoComplete && SENSITIVE_AUTOCOMPLETE[autoComplete]) {
      detectedType = SENSITIVE_AUTOCOMPLETE[autoComplete];
      confidence = 0.97;
    }
    // Rule 4: Input type=email/tel
    else if (type === 'email') { detectedType = 'email'; confidence = 0.99; }
    else if (type === 'tel') { detectedType = 'phone'; confidence = 0.95; }
    // Rule 5: Name/ID/placeholder/aria-label heuristics
    else {
      for (const { pattern, type: pType } of SENSITIVE_PLACEHOLDER_PATTERNS) {
        if (pattern.test(combinedDescriptor)) {
          if (enabledTypes.has(pType)) {
            detectedType = pType;
            confidence = 0.85;
            break;
          }
        }
      }
    }

    // Rule 6: Input Value Inspection (e.g. Card number, CVV, Phone filled in)
    const rawVal = (input.value || '').trim();
    if (!detectedType && rawVal) {
      const cleanDigits = rawVal.replace(/\D/g, '');
      if (cleanDigits.length >= 13 && cleanDigits.length <= 19 && enabledTypes.has('credit_card')) {
        detectedType = 'credit_card';
        confidence = 0.98;
      } else if (EMAIL_REGEX.test(rawVal) && enabledTypes.has('email')) {
        detectedType = 'email';
        confidence = 0.98;
      } else if (PHONE_REGEX.test(rawVal) && enabledTypes.has('phone')) {
        detectedType = 'phone';
        confidence = 0.95;
      } else if (/^\d{3,4}$|^\.{3,4}$|^\*{3,4}$|^•{3,4}$/.test(rawVal) && enabledTypes.has('cvv') && (/cvv|cvc|csc|security.?code|verification/i.test(combinedDescriptor) || input.maxLength === 3 || input.maxLength === 4 || /^\.{3,4}$|^\*{3,4}$|^•{3,4}$/.test(rawVal))) {
        detectedType = 'cvv';
        confidence = 0.98;
      } else if (/^(?:0[1-9]|1[0-2])\s*\/\s*(?:2\d|3\d)$/.test(rawVal) && enabledTypes.has('credit_card')) {
        detectedType = 'credit_card';
        confidence = 0.95;
      } else if (/^\d{4,8}$/.test(cleanDigits) && /otp|passcode|verification/i.test(combinedDescriptor) && enabledTypes.has('password')) {
        detectedType = 'password';
        confidence = 0.95;
      }
    }

    if (detectedType === 'credit_card' || detectedType === 'cvv') {
      confidence = Math.max(confidence, 0.98);
    }

    if (detectedType && enabledTypes.has(detectedType)) {
      const sensitivity = SENSITIVITY_MAP[detectedType];
      entities.push({
        id: nextId(),
        type: detectedType,
        confidence,
        source: 'dom',
        sensitivity,
        redactionMethod: getRedactionMethod(sensitivity, settings),
        bbox,
        targetElement: el as HTMLElement,
        isFixed: isElementFixedOrSticky(el),
        domSelector: getSelector(el),
        rawValue: input.value || undefined, // stored locally only
        placeholder: PLACEHOLDER_MAP[detectedType],
        timestamp: Date.now(),
      });
    }
  });

  // Also scan static text elements with data-pii-type
  document.querySelectorAll('[data-pii-type]').forEach(el => {
    const input = el as HTMLElement;
    if (el.tagName.match(/INPUT|SELECT|TEXTAREA/i)) return; // already handled above
    const piiType = el.getAttribute('data-pii-type') as PIIType;
    if (!piiType || !enabledTypes.has(piiType)) return;

    const rect = el.getBoundingClientRect();
    if (isElementOccluded(el, rect)) return;

    const bbox: BoundingBox = {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
    };

    const sensitivity = SENSITIVITY_MAP[piiType];
    entities.push({
      id: nextId(),
      type: piiType,
      confidence: 1.0,
      source: 'dom',
      sensitivity,
      redactionMethod: getRedactionMethod(sensitivity, settings),
      bbox,
      targetElement: el as HTMLElement,
      isFixed: isElementFixedOrSticky(el),
      domSelector: getSelector(el),
      rawValue: input.textContent?.trim() || undefined,
      placeholder: PLACEHOLDER_MAP[piiType],
      timestamp: Date.now(),
    });
  });

  // Also scan accessible same-origin/embedded iframes (e.g. payment checkout frames)
  try {
    document.querySelectorAll<HTMLIFrameElement>('iframe').forEach(frame => {
      try {
        const frameDoc = frame.contentDocument;
        if (!frameDoc || !frameDoc.body) return;
        const frameRect = frame.getBoundingClientRect();
        if (frameRect.width <= 0 || frameRect.height <= 0) return;

        const frameInputs = frameDoc.querySelectorAll<HTMLElement>('input, select, textarea, [data-pii-type]');
        frameInputs.forEach(fEl => {
          const r = fEl.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;

          const bbox: BoundingBox = {
            x: Math.round(frameRect.left + r.left + window.scrollX),
            y: Math.round(frameRect.top + r.top + window.scrollY),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };

          const fInput = fEl as HTMLInputElement;
          const fName = fInput.name?.toLowerCase() ?? '';
          const fId = fInput.id?.toLowerCase() ?? '';
          const fPh = fInput.placeholder?.toLowerCase() ?? '';
          const fAria = fInput.getAttribute('aria-label')?.toLowerCase() ?? '';
          const fClass = (fInput.className && typeof fInput.className === 'string') ? fInput.className.toLowerCase() : '';
          const fCombined = `${fName} ${fId} ${fPh} ${fAria} ${fClass}`;

          let fDetected: PIIType | null = null;
          if (fInput.type === 'password') fDetected = 'password';
          else if (fInput.type === 'email') fDetected = 'email';
          else if (fInput.type === 'tel') fDetected = 'phone';
          else {
            for (const { pattern, type: pType } of SENSITIVE_PLACEHOLDER_PATTERNS) {
              if (pattern.test(fCombined) && enabledTypes.has(pType)) {
                fDetected = pType;
                break;
              }
            }
          }

          const fVal = (fInput.value || '').trim();
          if (!fDetected && fVal) {
            const digits = fVal.replace(/\D/g, '');
            if (digits.length >= 13 && digits.length <= 19 && enabledTypes.has('credit_card')) fDetected = 'credit_card';
            else if (EMAIL_REGEX.test(fVal) && enabledTypes.has('email')) fDetected = 'email';
            else if (PHONE_REGEX.test(fVal) && enabledTypes.has('phone')) fDetected = 'phone';
            else if ((/^\d{3,4}$|^\.{3,4}$|^\*{3,4}$|^•{3,4}$/.test(fVal) || /cvv|cvc|security/i.test(fCombined)) && (/cvv|cvc|security/i.test(fCombined) || fInput.maxLength === 3 || fInput.maxLength === 4 || /^\.{3,4}$|^\*{3,4}$|^•{3,4}$/.test(fVal))) fDetected = 'cvv';
            else if (/^(?:0[1-9]|1[0-2])\s*\/\s*(?:2\d|3\d)$/.test(fVal) && enabledTypes.has('credit_card')) fDetected = 'credit_card';
          }

          if (fDetected && enabledTypes.has(fDetected)) {
            const sensitivity = SENSITIVITY_MAP[fDetected];
            entities.push({
              id: nextId(),
              type: fDetected,
              confidence: 0.95,
              source: 'dom',
              sensitivity,
              redactionMethod: getRedactionMethod(sensitivity, settings),
              bbox,
              targetElement: fEl as HTMLElement,
              isFixed: true,
              domSelector: getSelector(fEl),
              rawValue: fInput.value || undefined,
              placeholder: PLACEHOLDER_MAP[fDetected],
              timestamp: Date.now(),
            });
          }
        });
      } catch {}
    });
  } catch {}

  return deduplicate(entities);
}

// ── LAYER 1b: VISIBLE TEXT NODE SCAN WITH EXACT BOUNDING BOXES ─────────────────

/**
 * Scans visible DOM text nodes to detect rendered PII (emails, phone numbers,
 * cards, and profile names) and computes exact client bounding boxes via Range.
 */
export function detectPIIFromDOMText(settings: PrivacySettings): PIIEntity[] {
  const entities: PIIEntity[] = [];
  const enabledTypes = new Set(settings.enabledCategories);
  const NAME_LABEL_REGEX = /(?:(?:[Ff]irst|[Gg]iven|[Ll]ast|[Ff]ull|[Uu]ser|[Pp]rofile)\s*name\s*[:\-]|(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear)\s*[\uD800-\uDBFF\uDC00-\uDFFF\u2600-\u27BF\s,:\-]*I['’]m)\s+([A-Z][a-z]{1,25}(?:\s+[A-Z][a-z]{1,25}){1,3})\b/;
  const FORBIDDEN_WORDS = /\b(country|india|united\s*states|timezone|utc|email|phone|password|address|city|state|zip|postal|change|edit|update|delete|cancel|save|profile|account|select|choose|none|optional|required|sign|login|logout|menu|tools|developer|engineer|software|designer|manager|student|founder|stack|problem|solver|enthusiast|creator|architect|specialist|passionate|contributor|member|overview|repositories|projects|packages|stars)\b/i;

  try {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'OPTION'].includes(tag)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.closest('#__privacy-agent-overlay__, #__privsight-floating-panel__')) {
            return NodeFilter.FILTER_REJECT;
          }
          const val = node.nodeValue?.trim() || '';
          return val.length >= 2 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
      }
    );

    let currentNode = walker.nextNode();
    let count = 0;
    while (currentNode && count < 600) {
      count++;
      const text = currentNode.nodeValue || '';
      const textNode = currentNode as Text;

      // Skip text nodes whose parent container is occluded by modal/backdrop
      if (textNode.parentElement && isElementOccluded(textNode.parentElement)) {
        currentNode = walker.nextNode();
        continue;
      }

      // 1. Scan regex patterns (Email, Phone, Card, Govt ID, UPI, etc.)
      for (const { type, pattern, confidence } of PATTERNS) {
        if (!enabledTypes.has(type)) continue;
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
          if (match[0].length < 3) continue;

          try {
            const range = document.createRange();
            range.setStart(textNode, match.index);
            range.setEnd(textNode, match.index + match[0].length);
            const rect = range.getBoundingClientRect();

            if (rect.width > 2 && rect.height > 2) {
              if (isRectOccluded(rect, textNode.parentElement)) continue;

              const bbox: BoundingBox = {
                x: Math.round(rect.left + window.scrollX),
                y: Math.round(rect.top + window.scrollY),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              };

              const sensitivity = SENSITIVITY_MAP[type];
              entities.push({
                id: nextId(),
                type,
                confidence,
                source: 'dom',
                sensitivity,
                redactionMethod: getRedactionMethod(sensitivity, settings),
                bbox,
                targetElement: textNode.parentElement || undefined,
                isFixed: isElementFixedOrSticky(textNode.parentElement),
                domSelector: textNode.parentElement ? getSelector(textNode.parentElement) : undefined,
                rawValue: match[0],
                placeholder: PLACEHOLDER_MAP[type],
                timestamp: Date.now(),
              });
            }
          } catch {}
        }
      }

      // 2. Contextual inline name detection (e.g. "First name: Dharaya", "Hi, I'm Krishna Agarwal")
      if (enabledTypes.has('name')) {
        const nameMatch = NAME_LABEL_REGEX.exec(text);
        if (nameMatch && nameMatch[1]) {
          const nameValue = nameMatch[1];
          if (!FORBIDDEN_WORDS.test(nameValue)) {
            const nameIndex = text.indexOf(nameValue, nameMatch.index);
          if (nameIndex !== -1) {
            try {
              const range = document.createRange();
              range.setStart(textNode, nameIndex);
              range.setEnd(textNode, nameIndex + nameValue.length);
              const rect = range.getBoundingClientRect();
              if (rect.width > 2 && rect.height > 2) {
                if (isRectOccluded(rect, textNode.parentElement)) continue;

                const bbox: BoundingBox = {
                  x: Math.round(rect.left + window.scrollX),
                  y: Math.round(rect.top + window.scrollY),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                };
                entities.push({
                  id: nextId(),
                  type: 'name',
                  confidence: 0.92,
                  source: 'dom',
                  sensitivity: 'MEDIUM',
                  redactionMethod: 'replace',
                  bbox,
                  targetElement: textNode.parentElement || undefined,
                  isFixed: isElementFixedOrSticky(textNode.parentElement),
                  domSelector: textNode.parentElement ? getSelector(textNode.parentElement) : undefined,
                  rawValue: nameValue,
                  placeholder: PLACEHOLDER_MAP['name'],
                  timestamp: Date.now(),
                });
              }
            } catch {}
          }
        }
      }
    }

      currentNode = walker.nextNode();
    }

    // 3. Scan profile name containers and labels (e.g. "First name: Dharaya")
    if (enabledTypes.has('name')) {
      const NAME_CONTAINER_REGEX = /(?:(?:[Ff]irst|[Gg]iven|[Ff]ull|[Rr]egistered|[Uu]ser|[Pp]rofile)\s*name\s*[:\-]|(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear)\s*[\uD800-\uDBFF\uDC00-\uDFFF\u2600-\u27BF\s,:\-]*I['’]m)\s+([A-Z][a-z]{1,25}(?:\s+[A-Z][a-z]{1,25}){1,3})\b/;

      const candidateElements = document.querySelectorAll<HTMLElement>('label, dt, h1, h2, [class*="author"], [class*="profile-name"], [class*="user-name"], [class*="vcard-names"]');
      candidateElements.forEach(el => {
        if (el.children.length > 25) return;
        if (isElementOccluded(el)) return;
        const text = (el.innerText || '').trim();
        if (text.length < 3 || text.length > 300) return;

        const match = NAME_CONTAINER_REGEX.exec(text);
        if (match && match[1]) {
          const nameValue = match[1].trim();
          if (nameValue.length >= 2 && !FORBIDDEN_WORDS.test(nameValue)) {
            let targetEl: HTMLElement = el;
            let targetRect: DOMRect | null = null;

            // Search for direct child element with exact name
            const childWithExactName = Array.from(el.querySelectorAll<HTMLElement>('*')).find(c =>
              (c.innerText || '').trim() === nameValue && c.children.length === 0
            );

            if (childWithExactName) {
              targetEl = childWithExactName;
              targetRect = childWithExactName.getBoundingClientRect();
            } else {
              // Try finding text node to create an exact range bounding box
              const nodeWalker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
              let n = nodeWalker.nextNode();
              while (n) {
                const idx = (n.nodeValue || '').indexOf(nameValue);
                if (idx !== -1) {
                  try {
                    const r = document.createRange();
                    r.setStart(n, idx);
                    r.setEnd(n, idx + nameValue.length);
                    const rect = r.getBoundingClientRect();
                    if (rect.width > 2 && rect.height > 2) {
                      targetRect = rect;
                      if (n.parentElement) targetEl = n.parentElement;
                      break;
                    }
                  } catch {}
                }
                n = nodeWalker.nextNode();
              }
            }

            if (targetRect && targetRect.width > 2 && targetRect.height > 2) {
              if (isElementOccluded(targetEl, targetRect)) return;

              const bbox: BoundingBox = {
                x: Math.round(targetRect.left + window.scrollX),
                y: Math.round(targetRect.top + window.scrollY),
                width: Math.round(targetRect.width),
                height: Math.round(targetRect.height),
              };

              // Avoid duplicates
              const exists = entities.some(e =>
                e.type === 'name' && e.bbox &&
                Math.abs(e.bbox.x - bbox.x) < 15 && Math.abs(e.bbox.y - bbox.y) < 15
              );

              if (!exists) {
                entities.push({
                  id: nextId(),
                  type: 'name',
                  confidence: 0.95,
                  source: 'dom',
                  sensitivity: 'MEDIUM',
                  redactionMethod: 'replace',
                  bbox,
                  targetElement: targetEl,
                  isFixed: isElementFixedOrSticky(targetEl),
                  domSelector: getSelector(targetEl),
                  rawValue: nameValue,
                  placeholder: PLACEHOLDER_MAP['name'],
                  timestamp: Date.now(),
                });
              }
            }
          }
        }
      });

      // 4. Scan explicit labels and adjacent values (e.g. <label>First name:</label> <span>Dharaya</span> or sidebar "Registered" + "Dharaya")
      const LABEL_PATTERN = /^(?:first\s*name|given\s*name|full\s*name|user\s*name|registered)$/i;
      const potentialLabels = document.querySelectorAll<HTMLElement>('label, dt, .label, [class*="label"], [class*="title"], [class*="field"], [class*="status"], p, span, div, b, strong');
      potentialLabels.forEach(lblEl => {
        const rawLbl = (lblEl.innerText || '').trim().replace(/[:\-]/g, '').trim();
        if (!LABEL_PATTERN.test(rawLbl)) return;

        // Candidate value element: next sibling, or next child of parent, or child in same row
        let valEl: HTMLElement | null = lblEl.nextElementSibling as HTMLElement | null;
        if (!valEl && lblEl.parentElement) {
          const siblings = Array.from(lblEl.parentElement.children) as HTMLElement[];
          const idx = siblings.indexOf(lblEl);
          if (idx !== -1 && idx < siblings.length - 1) {
            valEl = siblings[idx + 1];
          }
        }

        if (valEl) {
          if (isElementOccluded(valEl)) return;
          const valText = (valEl.innerText || '').trim();
          if (valText && valText.length >= 2 && valText.length <= 30 && /^[A-Za-z\u00C0-\u024F\s.'-]+$/.test(valText) && !FORBIDDEN_WORDS.test(valText)) {
            const rect = valEl.getBoundingClientRect();
            if (rect.width > 2 && rect.height > 2) {
              const bbox: BoundingBox = {
                x: Math.round(rect.left + window.scrollX),
                y: Math.round(rect.top + window.scrollY),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              };

              const exists = entities.some(e =>
                e.type === 'name' && e.bbox &&
                Math.abs(e.bbox.x - bbox.x) < 15 && Math.abs(e.bbox.y - bbox.y) < 15
              );

              if (!exists) {
                entities.push({
                  id: nextId(),
                  type: 'name',
                  confidence: 0.96,
                  source: 'dom',
                  sensitivity: 'MEDIUM',
                  redactionMethod: 'replace',
                  bbox,
                  targetElement: valEl,
                  isFixed: isElementFixedOrSticky(valEl),
                  domSelector: getSelector(valEl),
                  rawValue: valText,
                  placeholder: PLACEHOLDER_MAP['name'],
                  timestamp: Date.now(),
                });
              }
            }
          }
        }
      });

      // 5. Scan semantic profile name elements (e.g. GitHub [itemprop="name"], .p-name, .vcard-fullname, profile headers)
      const profileNameElements = document.querySelectorAll<HTMLElement>(
        '[itemprop="name"], .p-name, .vcard-fullname, .profile-name, [class*="profile-fullname"], [class*="user-fullname"], .vcard-names span:first-child'
      );
      profileNameElements.forEach(pEl => {
        if (isElementOccluded(pEl)) return;
        const textVal = (pEl.innerText || '').trim();
        if (textVal.length >= 2 && textVal.length <= 40 && !FORBIDDEN_WORDS.test(textVal)) {
          const rect = pEl.getBoundingClientRect();
          if (rect.width > 2 && rect.height > 2) {
            const bbox: BoundingBox = {
              x: Math.round(rect.left + window.scrollX),
              y: Math.round(rect.top + window.scrollY),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
            const exists = entities.some(e =>
              e.type === 'name' && e.bbox &&
              Math.abs(e.bbox.x - bbox.x) < 15 && Math.abs(e.bbox.y - bbox.y) < 15
            );
            if (!exists) {
              entities.push({
                id: nextId(),
                type: 'name',
                confidence: 0.98,
                source: 'dom',
                sensitivity: 'MEDIUM',
                redactionMethod: 'replace',
                bbox,
                targetElement: pEl,
                isFixed: isElementFixedOrSticky(pEl),
                domSelector: getSelector(pEl),
                rawValue: textVal,
                placeholder: PLACEHOLDER_MAP['name'],
                timestamp: Date.now(),
              });
            }
          }
        }
      });
    }

  } catch (err) {
    console.warn('[PIIDetector] Error scanning DOM text nodes:', err);
  }

  return entities;
}

// ── LAYER 2: REGEX-BASED TEXT SCAN ────────────────────────────────────────────

export function detectPIIFromText(
  text: string,
  source: PIISource,
  settings: PrivacySettings
): PIIEntity[] {
  const entities: PIIEntity[] = [];
  const enabledTypes = new Set(settings.enabledCategories);

  for (const { type, pattern, confidence } of PATTERNS) {
    if (!enabledTypes.has(type)) continue;

    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      // Skip very short matches that are likely false positives
      if (match[0].length < 3) continue;

      // Additional validation for credit cards (basic Luhn check for high confidence)
      if (type === 'credit_card') {
        const digits = match[0].replace(/\D/g, '');
        if (digits.length < 13 || !luhnCheck(digits)) continue;
      }

      // Skip account numbers if surrounded by common non-PII patterns
      if (type === 'account_number') {
        const ctx = text.slice(Math.max(0, match.index - 20), match.index + match[0].length + 20);
        if (/order|ref|flight|booking|conf/i.test(ctx)) continue;
      }

      const sensitivity = SENSITIVITY_MAP[type];
      entities.push({
        id: nextId(),
        type,
        confidence,
        source,
        sensitivity,
        redactionMethod: getRedactionMethod(sensitivity, settings),
        rawValue: match[0],
        placeholder: PLACEHOLDER_MAP[type],
        timestamp: Date.now(),
      });
    }
  }

  return entities;
}

// ── LAYER 2b: OCR WORD-LEVEL DETECTION ────────────────────────────────────────

export function detectPIIFromOCRWords(
  words: OcrWord[],
  settings: PrivacySettings
): PIIEntity[] {
  const entities: PIIEntity[] = [];

  // Combine nearby words into lines for pattern matching
  const text = words.map(w => w.text).join(' ');
  const textEntities = detectPIIFromText(text, 'ocr', settings);

  // Try to associate detected text entities back to word bounding boxes
  textEntities.forEach(entity => {
    if (!entity.rawValue) {
      entities.push(entity);
      return;
    }
    // Find matching word bbox
    const matchingWord = words.find(w =>
      entity.rawValue!.includes(w.text) || w.text.includes(entity.rawValue!)
    );
    if (matchingWord) {
      entity.bbox = matchingWord.bbox;
    }
    entities.push(entity);
  });

  return entities;
}

// ── LAYER 3: VISION-BASED (face detection result integration) ─────────────────

export function createFaceEntity(
  bbox: BoundingBox,
  confidence: number,
  domElement?: HTMLElement,
  isFixed?: boolean
): PIIEntity {
  return {
    id: nextId(),
    type: 'face',
    confidence,
    source: 'vision',
    sensitivity: 'HIGH',
    redactionMethod: 'blur',
    bbox,
    targetElement: domElement,
    domSelector: domElement ? getSelector(domElement) : undefined,
    isFixed,
    placeholder: '[FACE BLURRED]',
    timestamp: Date.now(),
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function getRedactionMethod(
  sensitivity: SensitivityLevel,
  settings: PrivacySettings
): RedactionMethod {
  if (settings.privacyLevel === 'STRICT') {
    if (sensitivity === 'CRITICAL') return 'remove';
    if (sensitivity === 'HIGH') return 'mask';
    return 'replace';
  }
  if (settings.privacyLevel === 'BALANCED') {
    if (sensitivity === 'CRITICAL') return 'remove';
    return settings.defaultRedactionMethod;
  }
  // PERMISSIVE
  return settings.defaultRedactionMethod;
}

function getSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    let seg = cur.tagName.toLowerCase();
    if (cur.id) { seg = `#${CSS.escape(cur.id)}`; parts.unshift(seg); break; }
    if (cur.className) {
      const cls = Array.from(cur.classList).slice(0, 2).join('.');
      if (cls) seg += `.${cls}`;
    }
    const parent = cur.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === cur!.tagName);
      if (siblings.length > 1) seg += `:nth-of-type(${siblings.indexOf(cur as Element) + 1})`;
    }
    parts.unshift(seg);
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

function luhnCheck(num: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = parseInt(num[i], 10);
    if (alternate) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function deduplicate(entities: PIIEntity[]): PIIEntity[] {
  // Sort entities with bbox first so they take precedence over text-only matches
  const sorted = [...entities].sort((a, b) => {
    if (a.bbox && !b.bbox) return -1;
    if (!a.bbox && b.bbox) return 1;
    return (b.confidence || 0) - (a.confidence || 0);
  });

  const result: PIIEntity[] = [];
  const seenRaw = new Set<string>();

  for (const e of sorted) {
    if (e.rawValue) {
      const key = `${e.type}:${e.rawValue.toLowerCase().trim()}`;
      if (e.bbox) {
        // Allow multiple occurrences of the same email/value if they are at different visual positions
        const isDuplicatePos = result.some(r =>
          r.type === e.type && r.bbox &&
          Math.abs(r.bbox.x - e.bbox!.x) < 15 && Math.abs(r.bbox.y - e.bbox!.y) < 15
        );
        if (isDuplicatePos) continue;
      } else {
        // Without bbox: deduplicate by value
        if (seenRaw.has(key)) continue;
      }
      seenRaw.add(key);
    }
    result.push(e);
  }

  return result;
}
