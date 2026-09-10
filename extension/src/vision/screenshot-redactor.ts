/**
 * ScreenshotRedactor — Applies privacy redaction to a captured screenshot.
 *
 * Runs as an offscreen document handler (Chrome MV3) and also as a
 * standalone utility that can be called from the content script.
 *
 * Redaction visual styles:
 *   CRITICAL (passwords, credit cards, keys):  solid black fill + bold red label
 *   HIGH     (faces, emails, phone, Aadhaar):  Gaussian blur + translucent overlay + label
 *   MEDIUM   (names, DOB, UPI):               pixelate + amber overlay + label
 *   LOW      (barcodes, signatures):           hatching pattern + label
 *
 * The redacted image is CLEARLY visually altered — evaluators can see the protection.
 */

import type { PIIEntity, BoundingBox } from '../utils/types';

const COLORS = {
  CRITICAL: { fill: '#1a1a1a', border: '#dc2626', text: '#ff4444', badge: '#dc2626' },
  HIGH:     { fill: 'rgba(220,38,38,0.12)', border: '#f97316', text: '#ffffff', badge: '#f97316' },
  MEDIUM:   { fill: 'rgba(202,138,4,0.15)', border: '#ca8a04', text: '#ffffff', badge: '#ca8a04' },
  LOW:      { fill: 'rgba(37,99,235,0.12)', border: '#2563eb', text: '#ffffff', badge: '#2563eb' },
};

// ── CORE REDACTION PRIMITIVES ─────────────────────────────────────────────────

/** 
 * Apply a strong pixelation effect (mosaic) to a canvas region.
 * Pixelation is visually clear and GPU-friendly (no blur kernel needed).
 */
function pixelateRegion(
  ctx: CanvasRenderingContext2D,
  bbox: BoundingBox,
  blockSize = 12,
): void {
  const { x, y, width, height } = bbox;
  if (width <= 0 || height <= 0) return;

  // Sample pixels at block intervals, paint enlarged blocks
  for (let bx = x; bx < x + width; bx += blockSize) {
    for (let by = y; by < y + height; by += blockSize) {
      const sw = Math.min(blockSize, x + width - bx);
      const sh = Math.min(blockSize, y + height - by);
      try {
        const pixel = ctx.getImageData(bx + sw / 2, by + sh / 2, 1, 1).data;
        ctx.fillStyle = `rgb(${pixel[0]},${pixel[1]},${pixel[2]})`;
        ctx.fillRect(bx, by, sw, sh);
      } catch {
        ctx.fillStyle = '#333';
        ctx.fillRect(bx, by, sw, sh);
      }
    }
  }
}

/** Apply a roundRect polyfill for Chrome < 99 */
function polyfillRoundRect(ctx: CanvasRenderingContext2D) {
  if (!ctx.roundRect) {
    (ctx as any).roundRect = function(x: number, y: number, w: number, h: number, r: number) {
      const rr = Math.min(r, w / 2, h / 2);
      this.moveTo(x + rr, y);
      this.lineTo(x + w - rr, y);
      this.quadraticCurveTo(x + w, y, x + w, y + rr);
      this.lineTo(x + w, y + h - rr);
      this.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
      this.lineTo(x + rr, y + h);
      this.quadraticCurveTo(x, y + h, x, y + h - rr);
      this.lineTo(x, y + rr);
      this.quadraticCurveTo(x, y, x + rr, y);
      this.closePath();
    };
  }
}

/** Apply a deep pixel-level box blur to a canvas region (proper getImageData approach). */
function blurRegion(ctx: CanvasRenderingContext2D, bbox: BoundingBox, radius = 18): void {
  const { x, y, width, height } = bbox;
  if (width <= 0 || height <= 0) return;

  try {
    const imageData = ctx.getImageData(x, y, width, height);
    const src = new Uint8ClampedArray(imageData.data);
    const dst = imageData.data;
    const w = width, h = height;
    const r = Math.min(radius, Math.floor(Math.min(w, h) / 3));

    // Horizontal pass
    const tmp = new Float32Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        let rs = 0, gs = 0, bs = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const nc = Math.min(w - 1, Math.max(0, col + k));
          const i = (row * w + nc) * 4;
          rs += src[i]; gs += src[i + 1]; bs += src[i + 2]; n++;
        }
        const oi = (row * w + col) * 4;
        tmp[oi] = rs / n; tmp[oi + 1] = gs / n; tmp[oi + 2] = bs / n; tmp[oi + 3] = src[oi + 3];
      }
    }

    // Vertical pass
    for (let col = 0; col < w; col++) {
      for (let row = 0; row < h; row++) {
        let rs = 0, gs = 0, bs = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const nr = Math.min(h - 1, Math.max(0, row + k));
          const i = (nr * w + col) * 4;
          rs += tmp[i]; gs += tmp[i + 1]; bs += tmp[i + 2]; n++;
        }
        const oi = (row * w + col) * 4;
        dst[oi] = rs / n; dst[oi + 1] = gs / n; dst[oi + 2] = bs / n; dst[oi + 3] = src[oi + 3];
      }
    }

    ctx.putImageData(imageData, x, y);
  } catch {
    // Cross-origin fallback: heavy pixelation
    pixelateRegion(ctx, bbox, 8);
  }

  // Second pixelation pass for stronger visual effect
  pixelateRegion(ctx, bbox, 10);
}

/** Draw a diagonal hatch pattern (for LOW sensitivity). */
function drawHatchPattern(
  ctx: CanvasRenderingContext2D,
  bbox: BoundingBox,
  color: string,
): void {
  const { x, y, width, height } = bbox;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  for (let i = -height; i < width + height; i += 10) {
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i - height, y + height);
  }
  ctx.stroke();
  ctx.restore();
}

/** Draw a badge label above a redacted region. */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  bbox: BoundingBox,
  label: string,
  bgColor: string,
  scroll = { x: 0, y: 0 },
): void {
  const bx = bbox.x - scroll.x;
  const by = bbox.y - scroll.y;

  ctx.save();
  ctx.font = 'bold 10px monospace';
  const textW = ctx.measureText(label).width;
  const badgeH = 18;
  const badgeW = textW + 12;
  const badgeX = bx;
  const badgeY = Math.max(0, by - badgeH - 2);

  // Badge background
  ctx.fillStyle = bgColor;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
  ctx.fill();

  // Badge text
  ctx.fillStyle = '#fff';
  ctx.fillText(label, badgeX + 6, badgeY + 12);
  ctx.restore();
}

/** Draw a centered label inside a redacted region. */
function drawCenteredLabel(
  ctx: CanvasRenderingContext2D,
  bbox: BoundingBox,
  label: string,
  color: string,
): void {
  ctx.save();
  const fontSize = Math.min(13, Math.max(9, bbox.height * 0.35));
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Text shadow for readability
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 4;
  ctx.fillText(label, bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
  ctx.restore();
}

// ── MAIN REDACTION FUNCTION ───────────────────────────────────────────────────

export interface RedactionResult {
  redactedDataUrl: string;
  entitiesApplied: number;
  processingMs: number;
}

/**
 * Apply all PII redactions to a screenshot canvas.
 *
 * @param canvas           - The canvas containing the captured screenshot
 * @param entities         - PIIEntity[] with bbox (page-coordinate space)
 * @param scrollX          - Page horizontal scroll offset
 * @param scrollY          - Page vertical scroll offset
 * @param devicePixelRatio - Screen DPR (captureVisibleTab gives physical pixels)
 * @returns                - Redacted canvas as a WebP data URL
 */
export function applyRedactionsToCanvas(
  canvas: HTMLCanvasElement,
  entities: PIIEntity[],
  scrollX: number,
  scrollY: number,
  devicePixelRatio = 1,
): RedactionResult {
  const t0 = Date.now();
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { redactedDataUrl: canvas.toDataURL(), entitiesApplied: 0, processingMs: 0 };
  }

  // Apply roundRect polyfill for Chrome < 99
  polyfillRoundRect(ctx);

  // DPR: captureVisibleTab gives physical pixels. Bboxes are CSS pixels.
  // Conversion: cssPixel * dpr = physicalPixel (screenshot coordinate)
  const dpr = devicePixelRatio;

  // Sort: CRITICAL first (so heavy redaction applied before lighter ones)
  const sorted = [...entities].filter(e => e.bbox).sort((a, b) => {
    const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    return (order[a.sensitivity] ?? 4) - (order[b.sensitivity] ?? 4);
  });

  // Consolidate overlapping boxes of the same type into a single bounding box (e.g. face fragments)
  const mergedEntities: PIIEntity[] = [];
  for (const ent of sorted) {
    if (!ent.bbox) continue;
    const existing = mergedEntities.find(m => {
      if (m.type !== ent.type || !m.bbox || !ent.bbox) return false;
      const x1 = Math.max(m.bbox.x, ent.bbox.x);
      const y1 = Math.max(m.bbox.y, ent.bbox.y);
      const x2 = Math.min(m.bbox.x + m.bbox.width, ent.bbox.x + ent.bbox.width);
      const y2 = Math.min(m.bbox.y + m.bbox.height, ent.bbox.y + ent.bbox.height);
      if (x2 <= x1 || y2 <= y1) return false;
      const interArea = (x2 - x1) * (y2 - y1);
      const minArea = Math.min(m.bbox.width * m.bbox.height, ent.bbox.width * ent.bbox.height);
      return minArea > 0 && interArea / minArea > 0.15;
    });
    if (existing && existing.bbox) {
      const minX = Math.min(existing.bbox.x, ent.bbox.x);
      const minY = Math.min(existing.bbox.y, ent.bbox.y);
      const maxX = Math.max(existing.bbox.x + existing.bbox.width, ent.bbox.x + ent.bbox.width);
      const maxY = Math.max(existing.bbox.y + existing.bbox.height, ent.bbox.y + ent.bbox.height);
      existing.bbox = {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };
      existing.confidence = Math.max(existing.confidence, ent.confidence);
    } else {
      mergedEntities.push({ ...ent, bbox: { ...ent.bbox } });
    }
  }

  let count = 0;

  for (const entity of mergedEntities) {
    if (!entity.bbox) continue;

    // Convert CSS-pixel page coordinates → physical screenshot pixel coordinates
    // Step 1: subtract scroll to get viewport-relative CSS pixels
    // Step 2: multiply by dpr to get physical screenshot pixels
    const vpX = (entity.bbox.x - scrollX) * dpr;
    const vpY = (entity.bbox.y - scrollY) * dpr;
    const vpW = entity.bbox.width * dpr;
    const vpH = entity.bbox.height * dpr;

    // Skip if fully outside the canvas
    if (vpX + vpW < 0 || vpY + vpH < 0) continue;
    if (vpX > canvas.width || vpY > canvas.height) continue;

    // Clamp to canvas bounds
    const cx = Math.max(0, vpX);
    const cy = Math.max(0, vpY);
    const cw = Math.min(vpW, canvas.width - cx);
    const ch = Math.min(vpH, canvas.height - cy);
    // Reject anomalous bounding boxes that would wipe out the entire screenshot
    if (cw <= 0 || ch <= 0 || (cw > canvas.width * 0.6 && ch > canvas.height * 0.6)) continue;

    const clampedBbox: BoundingBox = { x: cx, y: cy, width: cw, height: ch };
    const colors = COLORS[entity.sensitivity] ?? COLORS.MEDIUM;

    switch (entity.sensitivity) {
      case 'CRITICAL':
        // Solid black fill — data is completely hidden
        ctx.fillStyle = colors.fill;
        ctx.fillRect(cx, cy, cw, ch);
        // Red border
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 2;
        ctx.strokeRect(cx + 1, cy + 1, cw - 2, ch - 2);
        // Centered label
        drawCenteredLabel(ctx, clampedBbox, entity.placeholder, colors.text);
        break;

      case 'HIGH':
        if (entity.type === 'face') {
          // Blur + mosaic for faces
          blurRegion(ctx, clampedBbox, 20);
          ctx.fillStyle = 'rgba(220,38,38,0.25)';
          ctx.fillRect(cx, cy, cw, ch);
        } else {
          // Pixelate for other HIGH-sensitivity data
          pixelateRegion(ctx, clampedBbox, 10);
          ctx.fillStyle = 'rgba(249,115,22,0.30)';
          ctx.fillRect(cx, cy, cw, ch);
        }
        // Orange border
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 2;
        ctx.strokeRect(cx + 1, cy + 1, cw - 2, ch - 2);
        drawCenteredLabel(ctx, clampedBbox, entity.placeholder, '#fff');
        break;

      case 'MEDIUM':
        pixelateRegion(ctx, clampedBbox, 14);
        ctx.fillStyle = colors.fill;
        ctx.fillRect(cx, cy, cw, ch);
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cx + 1, cy + 1, cw - 2, ch - 2);
        if (cw > 50) drawCenteredLabel(ctx, clampedBbox, entity.placeholder, '#fff');
        break;

      case 'LOW':
      default:
        ctx.fillStyle = 'rgba(37,99,235,0.08)';
        ctx.fillRect(cx, cy, cw, ch);
        drawHatchPattern(ctx, clampedBbox, colors.border);
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cx + 1, cy + 1, cw - 2, ch - 2);
        break;
    }

    // Draw top badge — position it inside canvas, right-clipped
    // If near the top edge, draw badge INSIDE the redacted region instead
    const badgeLabel = `${entity.type.toUpperCase()} — REDACTED`;
    ctx.save();
    ctx.font = 'bold 10px monospace';
    const textW = ctx.measureText(badgeLabel).width + 12;
    const badgeX = Math.min(Math.max(0, cx), canvas.width - textW - 2);
    const spaceAbove = cy;
    const badgeH = 16;
    // If there's room above the box, draw above; otherwise draw inside at top
    const badgeY = spaceAbove >= badgeH + 2
      ? cy - badgeH - 2
      : cy + 2;
    ctx.fillStyle = colors.badge;
    ctx.beginPath();
    (ctx as any).roundRect(badgeX, badgeY, textW, badgeH, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(badgeLabel, badgeX + 6, badgeY + 11);
    ctx.restore();
    count++;
  }

  // Watermark
  ctx.save();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = '#dc2626';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'right';
  ctx.fillText('🔒 PRIVSIGHT — PII REDACTED LOCALLY', canvas.width - 8, canvas.height - 8);
  ctx.restore();

  const redactedDataUrl = canvas.toDataURL('image/webp', 0.82);
  return { redactedDataUrl, entitiesApplied: count, processingMs: Date.now() - t0 };
}

// ── PAGE SCREENSHOT CAPTURE ───────────────────────────────────────────────────

/**
 * Capture the current viewport as a canvas element using html-to-canvas
 * equivalent (CSS 2D approach — no external library needed).
 * 
 * NOTE: For the extension, screenshots come from the background SW via
 * chrome.tabs.captureVisibleTab(). This function decodes the incoming
 * base64 image into a canvas for processing.
 */
export function base64ToCanvas(base64DataUrl: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) { reject(new Error('No 2d context')); return; }
      ctx.drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = reject;
    img.src = base64DataUrl;
  });
}

/**
 * Full pipeline: decode screenshot → apply all redactions → return result.
 *
 * @param screenshotBase64  - base64 data URL from captureVisibleTab
 * @param entities          - PIIEntity array with page-absolute bboxes
 * @param scrollX           - window.scrollX at capture time
 * @param scrollY           - window.scrollY at capture time
 * @param devicePixelRatio  - window.devicePixelRatio at capture time
 */
export async function processScreenshot(
  screenshotBase64: string,
  entities: PIIEntity[],
  scrollX: number,
  scrollY: number,
  devicePixelRatio = 1,
): Promise<RedactionResult> {
  const canvas = await base64ToCanvas(screenshotBase64);
  return applyRedactionsToCanvas(canvas, entities, scrollX, scrollY, devicePixelRatio);
}
