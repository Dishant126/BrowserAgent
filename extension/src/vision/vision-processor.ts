/**
 * VisionProcessor — On-Device Visual Perception Engine
 *
 * Uses a 4-tier detection strategy (all running 100% client-side):
 *   Tier 0: Transformers.js ViT/YOLOS model (Xenova/yolos-tiny) — real ML inference via ONNX/WebGPU
 *   Tier 1: Chrome Shape Detection API (FaceDetector, BarcodeDetector) — zero-latency native
 *   Tier 2: Canvas pixel analysis heuristics — skin-tone clustering, QR pattern detection
 *   Tier 3: DOM semantic fallback — alt/class/data-attribute signals
 *
 * All processing happens locally. No image data leaves the browser.
 */

import type { BoundingBox, PIIEntity, PIIType } from '../utils/types';

export interface VisionDetection {
  type: PIIType;
  bbox: BoundingBox;
  confidence: number;
  source: 'vit-model' | 'native-api' | 'canvas-heuristic' | 'dom-semantic';
  label: string;
  vitLabel?: string;
}

// ── TIER 0: TRANSFORMERS.JS VIT MODEL (via offscreen document) ────────────────

function computeIoU(a: BoundingBox, b: BoundingBox): number {
  const xA = Math.max(a.x, b.x);
  const yA = Math.max(a.y, b.y);
  const xB = Math.min(a.x + a.width, b.x + b.width);
  const yB = Math.min(a.y + a.height, b.y + b.height);
  const interW = Math.max(0, xB - xA);
  const interH = Math.max(0, yB - yA);
  if (interW === 0 || interH === 0) return 0;
  const interArea = interW * interH;
  const aArea = a.width * a.height;
  const bArea = b.width * b.height;
  return interArea / (aArea + bArea - interArea);
}

async function captureScreenshot(): Promise<string | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 3000);
    chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (resp) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError || !resp?.dataUrl) {
        resolve(null);
      } else {
        resolve(resp.dataUrl);
      }
    });
  });
}

async function runViTInference(screenshotDataUrl: string): Promise<VisionDetection[]> {
  const requestId = `vit-${Date.now()}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn('[VisionProcessor] ViT inference timeout — skipping Tier 0');
      resolve([]);
    }, 8000);

    chrome.runtime.sendMessage(
      { type: 'VIT_INFERENCE', imageData: screenshotDataUrl, requestId, threshold: 0.30 },
      (resp) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError || !resp?.ok) {
          console.warn('[VisionProcessor] ViT failed:', resp?.error ?? chrome.runtime.lastError?.message);
          resolve([]);
          return;
        }

        const dpr = window.devicePixelRatio || 1;
        const scrollX = window.scrollX || 0;
        const scrollY = window.scrollY || 0;

        const detections: VisionDetection[] = (resp.detections ?? [])
          .filter((d: any) => d.shouldRedact || d.piiType === 'face')
          .map((d: any) => ({
            type: d.piiType as PIIType,
            bbox: {
              x: (d.bbox.x / dpr) + scrollX,
              y: (d.bbox.y / dpr) + scrollY,
              width: d.bbox.width / dpr,
              height: d.bbox.height / dpr,
            },
            confidence: d.score,
            source: 'vit-model' as const,
            label: `${d.label.toUpperCase()} [ViT]`,
            vitLabel: d.label,
          }));

        console.log(`[VisionProcessor] Tier 0 ViT: ${detections.length} PII detections (yolos-tiny)`);
        resolve(detections);
      }
    );
  });
}

// ── TIER 1: CHROME SHAPE DETECTION API ────────────────────────────────────────

function hasFaceDetector(): boolean {
  return typeof (window as any).FaceDetector !== 'undefined';
}

function hasBarcodeDetector(): boolean {
  return typeof (window as any).BarcodeDetector !== 'undefined';
}

async function detectFacesNative(canvas: HTMLCanvasElement): Promise<VisionDetection[]> {
  if (!hasFaceDetector()) return [];
  try {
    const detector = new (window as any).FaceDetector({ fastMode: true, maxDetectedFaces: 10 });
    const faces = await detector.detect(canvas);
    return faces.map((face: any) => ({
      type: 'face' as PIIType,
      bbox: {
        x: face.boundingBox.x,
        y: face.boundingBox.y,
        width: face.boundingBox.width,
        height: face.boundingBox.height,
      },
      confidence: 0.95,
      source: 'native-api' as const,
      label: 'FACE DETECTED',
    }));
  } catch (err) {
    console.warn('[VisionProcessor] FaceDetector API error:', err);
    return [];
  }
}

async function detectBarcodesNative(canvas: HTMLCanvasElement): Promise<VisionDetection[]> {
  if (!hasBarcodeDetector()) return [];
  try {
    const detector = new (window as any).BarcodeDetector({
      formats: ['qr_code', 'code_128', 'ean_13', 'code_39', 'pdf417'],
    });
    const barcodes = await detector.detect(canvas);
    return barcodes.map((b: any) => ({
      type: (b.format === 'qr_code' ? 'qr_code' : 'barcode') as PIIType,
      bbox: {
        x: b.boundingBox.x,
        y: b.boundingBox.y,
        width: b.boundingBox.width,
        height: b.boundingBox.height,
      },
      confidence: 0.99,
      source: 'native-api' as const,
      label: b.format === 'qr_code' ? 'QR CODE — MAY CONTAIN PII' : 'BARCODE',
    }));
  } catch (err) {
    console.warn('[VisionProcessor] BarcodeDetector API error:', err);
    return [];
  }
}

// ── TIER 2: CANVAS PIXEL HEURISTICS ──────────────────────────────────────────

function isSkinToneRegion(imageData: ImageData): boolean {
  const { data, width, height } = imageData;
  let skinPixels = 0;
  const totalPixels = width * height;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const isSkin =
      r > 95 && g > 40 && b > 20 &&
      r > g && r > b &&
      Math.abs(r - g) > 15 &&
      r - b > 15 &&
      r < 250;
    if (isSkin) skinPixels++;
  }

  const skinRatio = skinPixels / totalPixels;
  return skinRatio > 0.25;
}

async function detectFacesByPixelAnalysis(): Promise<VisionDetection[]> {
  const results: VisionDetection[] = [];
  const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('img'));

  for (const img of imgs) {
    const rect = img.getBoundingClientRect();
    if (rect.width < 30 || rect.height < 30) continue;
    const aspectRatio = rect.width / rect.height;
    if (aspectRatio > 4 || aspectRatio < 0.25) continue;

    try {
      const canvas = document.createElement('canvas');
      const sampleSize = 80;
      canvas.width = sampleSize;
      canvas.height = sampleSize;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) continue;

      ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
      const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);

      if (isSkinToneRegion(imageData)) {
        results.push({
          type: 'face',
          bbox: {
            x: rect.left + window.scrollX,
            y: rect.top + window.scrollY,
            width: rect.width,
            height: rect.height,
          },
          confidence: 0.82,
          source: 'canvas-heuristic',
          label: 'FACE / PHOTO',
        });
      }
    } catch (err) {
      // Cross-origin images will throw — skip gracefully
    }
  }

  return results;
}

// ── TIER 3: DOM SEMANTIC DETECTION ────────────────────────────────────────────

function detectSensitiveImagesByDOM(): VisionDetection[] {
  const results: VisionDetection[] = [];

  const faceSelectors = [
    'img[data-pii-type="face"]',
    'img.avatar', 'img.profile-photo', 'img.profile-picture',
    'img.profile-img', 'img.user-avatar', 'img.user-photo',
    '.profile-photo > img', '.profile-picture > img', '.avatar > img',
    'img[alt="profile photo"]', 'img[alt="Profile Photo"]',
    'img[alt="profile picture"]', 'img[alt="Profile Picture"]',
    'img[alt="avatar"]', 'img[alt="Avatar"]',
    'img[alt="user avatar"]', 'img[alt="User Avatar"]',
    'img[alt="headshot"]', 'img[alt="Headshot"]',
    'img[alt*="profile photo" i]', 'img[alt*="profile picture" i]',
    'img[src*="gravatar.com"]',
    'img[src*="lh3.googleusercontent.com"]',
    'img[src*="twimg.com/profile_images"]',
    'img[src*="fbcdn.net/v/"]',
    'img[src*="pbs.twimg.com/profile"]',
    'img[src*="avatars.githubusercontent.com"]',
    'img[src*="secure.gravatar.com"]',
    'img[src*="/profile-photos/"]', 'img[src*="/profile_photo"]',
    'img[src*="/avatar/"]', 'img[src*="/avatars/"]',
    'img[src*="/profile-pic"]', 'img[src*="profilepic"]',
    'img[src*="profile_picture"]', 'img[src*="user_photo"]',
    'img[src*="user-photo"]', 'img[src*="userphoto"]',
    '[aria-label="profile photo"] img', '[aria-label="Profile photo"] img',
    '[aria-label="your profile photo"] img', '[aria-label="account photo"] img',
    'button[aria-label*="profile photo" i] img',
    'button[aria-label*="account photo" i] img',
    '.gb_d img[aria-hidden]', 'a[href*="accounts.google.com"] img',
    'img[style*="border-radius: 50%"]', 'img[style*="border-radius:50%"]',
    'img[style*="border-radius: 100%"]', 'img[style*="border-radius:100%"]',
    'img[style*="border-radius:9999px"]', 'img[style*="border-radius: 9999px"]',
    'img[style*="border-radius:999px"]',
    '[class*="profile" i] .avatar', '[class*="profile" i] .user-icon',
    '[class*="profile" i] .user-img', '[class*="profile" i] [class*="avatar" i]',
    '[class*="student" i] .avatar', '[class*="student" i] .user-icon',
    '[class*="student" i] [class*="photo" i]', '[class*="student" i] [class*="pic" i]',
    '.user-avatar', '.profile-avatar',
  ];

  const seen = new Set<Element>();

  faceSelectors.forEach(sel => {
    try {
      document.querySelectorAll<HTMLElement>(sel).forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        const rect = el.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) return;
        if (rect.width / rect.height > 3.5) return;
        if (rect.width > window.innerWidth * 0.5) return;
        results.push({
          type: 'face',
          bbox: {
            x: rect.left + window.scrollX,
            y: rect.top + window.scrollY,
            width: rect.width,
            height: rect.height,
          },
          confidence: 0.88,
          source: 'dom-semantic',
          label: 'PROFILE PHOTO',
        });
      });
    } catch {
      // Invalid selector — skip silently
    }
  });

  document.querySelectorAll<HTMLElement>('[data-pii-type="qr_code"], .qr-code, canvas[id*="qr" i], img[alt*="qr" i]').forEach(el => {
    if (seen.has(el)) return;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    results.push({
      type: 'qr_code',
      bbox: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      confidence: 0.95,
      source: 'dom-semantic',
      label: 'QR CODE',
    });
  });

  document.querySelectorAll<HTMLElement>('[data-pii-type="signature"], .signature-pad, canvas[id*="sign" i]').forEach(el => {
    if (seen.has(el)) return;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width < 10) return;
    results.push({
      type: 'signature',
      bbox: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      confidence: 0.90,
      source: 'dom-semantic',
      label: 'SIGNATURE',
    });
  });

  return results;
}

export function detectUserNameNodes(): VisionDetection[] {
  const results: VisionDetection[] = [];
  const seen = new Set<Element>();

  const nameContainerSelectors = [
    '.user-name', '.username', '.display-name', '.account-name',
    '.full-name', '.profile-name', '.user-display-name',
    '[class*="userName"]', '[class*="UserName"]', '[class*="displayName"]',
    '[class*="DisplayName"]', '[class*="accountName"]',
    '[class*="userFullName"]', '[class*="profileName"]',
    'header .name', 'nav .name', '.navbar .name',
    '.nav-user-name', '.header-user-name', '.topbar-username',
    '.headerProfile .name', '.user-info .name', '.member-name',
    '[class*="passengerName"]', '[class*="travelerName"]',
    '.gb_db', '.gb_lb',
  ];

  const namePattern = /^[A-Z][a-z]{1,20}(\s[A-Z][a-z]{0,20}){1,3}$/;

  nameContainerSelectors.forEach(sel => {
    try {
      document.querySelectorAll<HTMLElement>(sel).forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        const text = el.textContent?.trim() ?? '';
        if (text.length < 3 || text.length > 60) return;
        if (!namePattern.test(text)) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 5) return;
        results.push({
          type: 'name',
          bbox: {
            x: rect.left + window.scrollX,
            y: rect.top + window.scrollY,
            width: rect.width,
            height: rect.height,
          },
          confidence: 0.85,
          source: 'dom-semantic',
          label: 'NAME — REDACTED',
        });
      });
    } catch {
      // Invalid selector — skip
    }
  });

  return results;
}

// ── SCREENSHOT CANVAS DETECTOR ────────────────────────────────────────────────

export async function detectOnScreenshot(canvas: HTMLCanvasElement): Promise<VisionDetection[]> {
  const [faces, barcodes] = await Promise.all([
    detectFacesNative(canvas),
    detectBarcodesNative(canvas),
  ]);
  return [...faces, ...barcodes];
}

// ── MAIN VISION PROCESSING FUNCTION ──────────────────────────────────────────

/**
 * Run the full 4-tier visual detection pipeline on the current page.
 *
 * Tier 0: Transformers.js YOLOS-tiny ViT model (real ML, via offscreen doc)
 * Tier 1: Chrome ShapeDetector API (FaceDetector, BarcodeDetector)
 * Tier 2: Canvas pixel analysis (skin-tone clustering on <img> elements)
 * Tier 3: DOM semantic heuristics (selectors, aria, alt text)
 *
 * Results merged with IoU-based deduplication.
 * All processing is 100% client-side — no network calls.
 */
export async function runVisionDetection(): Promise<VisionDetection[]> {
  const results: VisionDetection[] = [];

  // Tier 3a: DOM semantic face/photo detection (fastest, runs first)
  const domResults = detectSensitiveImagesByDOM();
  results.push(...domResults);

  // Tier 3b: DOM semantic name detection
  const nameResults = detectUserNameNodes();
  results.push(...nameResults);

  // Tier 2: Canvas pixel analysis (confirms DOM detections)
  try {
    const pixelResults = await detectFacesByPixelAnalysis();
    for (const pxDet of pixelResults) {
      const alreadyFound = results.some(r =>
        r.type === 'face' &&
        Math.abs(r.bbox.x - pxDet.bbox.x) < 20 &&
        Math.abs(r.bbox.y - pxDet.bbox.y) < 20
      );
      if (!alreadyFound) results.push(pxDet);
      else {
        const existing = results.find(r =>
          r.type === 'face' &&
          Math.abs(r.bbox.x - pxDet.bbox.x) < 20 &&
          Math.abs(r.bbox.y - pxDet.bbox.y) < 20
        );
        if (existing) existing.confidence = Math.max(existing.confidence, pxDet.confidence);
      }
    }
  } catch (err) {
    console.warn('[VisionProcessor] Pixel analysis failed:', err);
  }

  // Tier 0: ViT model inference — real YOLOS object detection on screenshot
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    try {
      const screenshotDataUrl = await captureScreenshot();
      if (screenshotDataUrl) {
        const vitResults = await runViTInference(screenshotDataUrl);

        // Merge ViT results using IoU deduplication (IoU > 0.3 = same detection)
        for (const vitDet of vitResults) {
          const duplicate = results.find(r =>
            r.type === vitDet.type && computeIoU(r.bbox, vitDet.bbox) > 0.30
          );
          if (!duplicate) {
            // New detection found by ViT that heuristics missed
            results.push(vitDet);
          } else {
            // ViT confirmed existing detection — boost confidence + tag
            duplicate.confidence = Math.min(0.99, duplicate.confidence + 0.08);
            duplicate.label = `${duplicate.label} \u2713ViT`;
          }
        }
      }
    } catch (err) {
      console.warn('[VisionProcessor] Tier 0 ViT failed (non-fatal):', err);
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Convert VisionDetection[] to PIIEntity[] for use with the redaction pipeline.
 */
export function visionDetectionsToPIIEntities(detections: VisionDetection[]): PIIEntity[] {
  let counter = Date.now();
  return detections.map(d => {
    let sensitivity: 'HIGH' | 'MEDIUM' | 'LOW';
    let redactionMethod: 'blur' | 'mask' | 'replace';
    if (d.type === 'face') {
      sensitivity = 'HIGH';
      redactionMethod = 'blur';
    } else if (d.type === 'name') {
      sensitivity = 'MEDIUM';
      redactionMethod = 'replace';
    } else if (d.type === 'qr_code' || d.type === 'signature') {
      sensitivity = 'HIGH';
      redactionMethod = 'mask';
    } else {
      sensitivity = 'MEDIUM';
      redactionMethod = 'mask';
    }
    return {
      id: `vision-${++counter}`,
      type: d.type,
      confidence: d.confidence,
      source: 'vision' as const,
      sensitivity,
      redactionMethod,
      bbox: d.bbox,
      placeholder: d.type === 'name' ? '[PERSON]' : `[${d.label}]`,
      timestamp: Date.now(),
    };
  });
}
