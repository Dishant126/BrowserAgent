/**
 * Redaction Engine — applies redaction to text, canvas regions, and DOM context
 */
import type { PIIEntity, UIElement, BoundingBox } from '../utils/types';

export const SENSITIVITY_COLORS: Record<string, string> = {
  CRITICAL: '#dc2626', HIGH: '#f57c00', MEDIUM: '#ca8a04', LOW: '#2563eb',
};

export interface OverlayBox {
  bbox: BoundingBox;
  label: string;
  color: string;
  targetElement?: HTMLElement | Element;
  isFixed?: boolean;
}

/** Replace raw PII values in text with semantic placeholders */
export function redactText(text: string, entities: PIIEntity[]): string {
  let redacted = text;
  const sorted = [...entities].filter(e => e.rawValue).sort((a, b) => (b.rawValue?.length ?? 0) - (a.rawValue?.length ?? 0));
  for (const entity of sorted) {
    if (!entity.rawValue) continue;
    const escaped = entity.rawValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      redacted = redacted.replace(new RegExp(escaped, 'gi'), entity.placeholder);
    } catch {
      redacted = redacted.split(entity.rawValue).join(entity.placeholder);
    }
  }
  return redacted;
}

/** Generate overlay boxes for visual display */
export function buildOverlayBoxes(entities: PIIEntity[]): OverlayBox[] {
  return entities.filter(e => e.bbox).map(e => ({
    bbox: e.bbox!,
    label: `${e.type.toUpperCase()} (${Math.round(e.confidence * 100)}%)`,
    color: SENSITIVITY_COLORS[e.sensitivity] ?? '#6b7280',
    targetElement: e.targetElement,
    isFixed: e.isFixed,
  }));
}

/** Apply box blur to a canvas region (for face/visual PII blurring) */
export function blurCanvasRegion(ctx: CanvasRenderingContext2D, bbox: BoundingBox, radius = 25): void {
  const canvasW = ctx.canvas.width;
  const canvasH = ctx.canvas.height;

  // Clamp bounding box to canvas bounds
  const x = Math.max(0, Math.min(canvasW - 1, Math.round(bbox.x)));
  const y = Math.max(0, Math.min(canvasH - 1, Math.round(bbox.y)));
  const width = Math.max(1, Math.min(canvasW - x, Math.round(bbox.width)));
  const height = Math.max(1, Math.min(canvasH - y, Math.round(bbox.height)));

  if (width <= 4 || height <= 4) return;

  try {
    const imageData = ctx.getImageData(x, y, width, height);
    const blurredArr = boxBlur(imageData.data, width, height, Math.min(radius, Math.floor(Math.min(width, height) / 2)));
    const blurredClamped = new Uint8ClampedArray(blurredArr);
    ctx.putImageData(new ImageData(blurredClamped, width, height), x, y);

    // Overlay privacy badge
    ctx.fillStyle = 'rgba(220, 38, 38, 0.85)';
    const badgeH = Math.min(22, height);
    ctx.fillRect(x, y, width, badgeH);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px monospace';
    ctx.fillText('[FACE BLURRED]', x + 6, y + 15);
  } catch (err) {
    // Fallback if getImageData blocked: solid mask
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(x, y, width, height);
  }
}

/** Redact all PII regions on a canvas screenshot and return base64 dataURL */
export function redactScreenshot(canvas: HTMLCanvasElement, entities: PIIEntity[], scrollX: number, scrollY: number): string {
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas.toDataURL('image/webp', 0.8);

  const canvasW = canvas.width;
  const canvasH = canvas.height;

  for (const entity of entities) {
    if (!entity.bbox) continue;

    // Viewport-relative coordinates
    const vx = Math.round(entity.bbox.x - scrollX);
    const vy = Math.round(entity.bbox.y - scrollY);
    const vw = Math.round(entity.bbox.width);
    const vh = Math.round(entity.bbox.height);

    // Skip regions outside visible canvas
    if (vx + vw <= 0 || vy + vh <= 0 || vx >= canvasW || vy >= canvasH) continue;

    const clampedX = Math.max(0, vx);
    const clampedY = Math.max(0, vy);
    const clampedW = Math.min(canvasW - clampedX, vw - (clampedX - vx));
    const clampedH = Math.min(canvasH - clampedY, vh - (clampedY - vy));

    if (clampedW <= 0 || clampedH <= 0) continue;

    const clampedBbox: BoundingBox = { x: clampedX, y: clampedY, width: clampedW, height: clampedH };

    if (entity.redactionMethod === 'blur' || entity.type === 'face') {
      blurCanvasRegion(ctx, clampedBbox, 25);
    } else if (entity.type === 'password') {
      // Solid blackout mask for passwords
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(clampedX, clampedY, clampedW, clampedH);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(clampedX, clampedY, clampedW, clampedH);
      ctx.fillStyle = '#fca5a5';
      ctx.font = 'bold 10px monospace';
      ctx.fillText('[PASSWORD REMOVED]', clampedX + 4, clampedY + Math.min(14, clampedH / 2 + 4));
    } else {
      // Solid color mask with placeholder label
      ctx.fillStyle = SENSITIVITY_COLORS[entity.sensitivity] ?? '#6b7280';
      ctx.fillRect(clampedX, clampedY, clampedW, clampedH);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px monospace';
      const label = entity.placeholder || `[${entity.type.toUpperCase()} REDACTED]`;
      const tw = ctx.measureText(label).width;
      const textX = clampedW > tw ? clampedX + (clampedW - tw) / 2 : clampedX + 2;
      const textY = clampedY + Math.min(14, clampedH / 2 + 4);
      ctx.fillText(label, textX, textY);
    }
  }

  return canvas.toDataURL('image/webp', 0.8);
}

/** Load a raw screenshot dataURL onto a canvas, redact all PII, and return sanitized base64 */
export async function loadAndRedactScreenshot(
  dataUrl: string,
  entities: PIIEntity[],
  scrollX = 0,
  scrollY = 0
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || window.innerWidth;
      canvas.height = img.naturalHeight || window.innerHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const redactedUrl = redactScreenshot(canvas, entities, scrollX, scrollY);
        resolve(redactedUrl);
      } else {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

const PII_PATTERNS = [
  { type: 'email' as const, regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi, token: '[EMAIL REDACTED]' },
  { type: 'phone' as const, regex: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, token: '[PHONE REDACTED]' },
  { type: 'credit_card' as const, regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, token: '[CARD REDACTED]' },
  { type: 'auth_token' as const, regex: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}|eyJh[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/gi, token: '[AUTH_TOKEN REDACTED]' },
];

export function maskPIIString(str?: string, entities: PIIEntity[] = []): { text?: string; isSensitive: boolean; detectedType?: import('../utils/types').PIIType } {
  if (!str) return { text: str, isSensitive: false };
  let sanitized = redactText(str, entities);
  let isSensitive = sanitized !== str;
  let detectedType: import('../utils/types').PIIType | undefined = isSensitive ? 'email' : undefined;

  for (const pattern of PII_PATTERNS) {
    if (pattern.regex.test(sanitized)) {
      isSensitive = true;
      detectedType = pattern.type;
      sanitized = sanitized.replace(pattern.regex, pattern.token);
    }
  }

  // Also sanitize mailto: references
  if (/mailto:/i.test(sanitized)) {
    isSensitive = true;
    detectedType = 'email';
    sanitized = sanitized.replace(/mailto:[^\s"'>]+/gi, 'mailto:[EMAIL REDACTED]');
  }

  return { text: sanitized, isSensitive, detectedType };
}

/** Strip sensitive values and mask PII in element labels, attributes, and values before server transmission */
export function sanitizeElements(elements: UIElement[], entities: PIIEntity[]): UIElement[] {
  const sensitiveSelectors = new Set(entities.map(e => e.domSelector).filter(Boolean));
  return elements.map(el => {
    const entity = entities.find(e => e.domSelector === el.domSelector);
    
    // Mask label, ariaLabel, placeholder, and value
    const maskLabel = maskPIIString(el.label, entities);
    const maskAria = maskPIIString(el.ariaLabel, entities);
    const maskPlaceholder = maskPIIString(el.placeholder, entities);
    const cleanAttrs = sanitizeAttributes(el.attributes || {}, entities);

    // Check if element is sensitive via DOM inspection, matched PII entity, or masked string
    const isSensitive = Boolean(
      el.sensitive ||
      sensitiveSelectors.has(el.domSelector) ||
      maskLabel.isSensitive ||
      maskAria.isSensitive ||
      maskPlaceholder.isSensitive ||
      entity != null
    );

    const detectedType = el.sensitivityType || maskLabel.detectedType || maskAria.detectedType || entity?.type || 'email';

    const finalLabel = maskLabel.text;
    const finalAria = maskAria.text;
    const finalPlaceholder = isSensitive
      ? (entity?.placeholder ?? `[${detectedType.toUpperCase()} REDACTED]`)
      : (maskPlaceholder.text || el.placeholder);

    return {
      ...el,
      label: finalLabel,
      ariaLabel: finalAria,
      sensitive: isSensitive,
      sensitivityType: isSensitive ? detectedType : undefined,
      value: isSensitive
        ? (el.value ? `[${detectedType.toUpperCase()} REDACTED]` : undefined)
        : el.value,
      attributes: cleanAttrs,
      placeholder: finalPlaceholder,
    };
  });
}

function sanitizeAttributes(attrs: Record<string, string>, entities: PIIEntity[] = []): Record<string, string> {
  const SKIP = new Set(['value', 'data-value', 'data-token', 'data-key']);
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (SKIP.has(k.toLowerCase())) continue;
    let cleanVal = v;
    if (/href/i.test(k) && /mailto:/i.test(cleanVal)) {
      cleanVal = cleanVal.replace(/mailto:[^\s"'>]+/gi, 'mailto:[EMAIL REDACTED]');
    } else {
      cleanVal = maskPIIString(cleanVal, entities).text || cleanVal;
    }
    result[k] = cleanVal;
  }
  return result;
}

function boxBlur(srcData: Uint8ClampedArray, w: number, h: number, r: number): number[] {
  const out: number[] = new Array(srcData.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let rs = 0, gs = 0, bs = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = Math.min(w-1, Math.max(0, x+dx)), ny = Math.min(h-1, Math.max(0, y+dy));
          const i = (ny*w+nx)*4; rs += srcData[i]; gs += srcData[i+1]; bs += srcData[i+2]; n++;
        }
      }
      const i = (y*w+x)*4;
      out[i]=rs/n; out[i+1]=gs/n; out[i+2]=bs/n; out[i+3]=srcData[i+3];
    }
  }
  return out;
}
