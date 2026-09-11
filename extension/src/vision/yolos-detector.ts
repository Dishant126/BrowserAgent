/**
 * YOLOS-Tiny Object Detector — Local Vision Model
 *
 * Stack:
 *   Transformers.js (v3)
 *     ↓
 *   ONNX Runtime Web
 *     ↓
 *   WebGPU  (primary)  /  WASM  (fallback)
 *     ↓
 *   YOLOS-Tiny  (Xenova/yolos-tiny)
 *
 * All inference runs 100% locally. Zero image pixels leave the browser unredacted.
 *
 * Returns standard detection boxes compatible with the existing PIIEntity[] pipeline.
 * Does NOT assume person === face. Person detections are tagged 'face' type for
 * downstream cross-validation by face-detector.ts.
 *
 * Graceful degradation: returns [] if model is unavailable (network error, no WebGPU/WASM,
 * etc.). Existing heuristic detectors continue to work normally.
 */

import { checkWebGPUSupport } from './vision-model';
import type { PIIEntity, PIIType, BoundingBox } from '../utils/types';

// ── TYPES ─────────────────────────────────────────────────────────────────────

export interface YOLOSDetection {
  label: string;
  score: number;
  box: {
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  };
}

export type YOLOSBackend = 'WebGPU' | 'WASM' | 'unavailable';

// ── COCO LABEL → PIIType MAPPING ──────────────────────────────────────────────

/**
 * Map COCO object-detection labels to PIIType.
 * Only privacy-relevant labels are included; all others are ignored.
 *
 * NOTE: 'person' → 'face' does NOT mean every person is a face.
 * face-detector.ts performs cross-validation before accepting the entity.
 */
const PII_LABEL_MAP: Record<string, { piiType: PIIType; sensitivity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'; method: 'blur' | 'mask' | 'remove' | 'replace' }> = {
  'person':      { piiType: 'face',        sensitivity: 'HIGH',     method: 'blur' },
  'credit card': { piiType: 'credit_card', sensitivity: 'CRITICAL', method: 'mask' },
};

// ── MODEL STATE ───────────────────────────────────────────────────────────────

let _pipeline: any = null;
let _loading = false;
let _loadError: Error | null = null;
let _lastErrorTime = 0;
let _backend: YOLOSBackend = 'unavailable';
const _waiters: Array<() => void> = [];

/**
 * Test whether the host page's Content Security Policy permits WebAssembly compilation.
 * Third-party websites with strict CSPs (such as GitHub) block WebAssembly.instantiate()
 * inside content scripts. Checking first prevents noisy unhandled Emscripten abort errors.
 */
function isWasmSupportedUnderCurrentCSP(): boolean {
  try {
    const minimalWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    new WebAssembly.Module(minimalWasm);
    return true;
  } catch {
    return false;
  }
}

let _huggingFaceAccessible: boolean | null = null;

/**
 * Check if the current page environment allows network connections to HuggingFace.
 * Sites like GitHub block connect-src to external CDNs. Probing first prevents 25-second timeouts.
 */
async function canConnectToHuggingFace(): Promise<boolean> {
  if (_huggingFaceAccessible !== null) return _huggingFaceAccessible;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    await fetch('https://huggingface.co/Xenova/yolos-tiny/resolve/main/config.json', {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    _huggingFaceAccessible = true;
  } catch {
    _huggingFaceAccessible = false;
  }
  return _huggingFaceAccessible;
}

/**
 * Lazily initialize the YOLOS-Tiny pipeline.
 * Model is downloaded from HuggingFace on first call and cached in browser IndexedDB.
 * Subsequent calls load from cache (fast, no network).
 */
async function getPipeline(): Promise<any | null> {
  if (_pipeline) return _pipeline;
  // If host page CSP blocks WebAssembly, do not attempt to compile WASM/WebGPU in content script
  if (!isWasmSupportedUnderCurrentCSP()) {
    if (_backend !== 'unavailable') {
      console.log('[YOLOS] Host page CSP restricts WebAssembly in content script (e.g. GitHub). Using fast on-device heuristic vision detector.');
      _backend = 'unavailable';
    }
    return null;
  }

  // If host page CSP blocks network downloads from HuggingFace, fall back immediately
  const canDownload = await canConnectToHuggingFace();
  if (!canDownload) {
    if (_backend !== 'unavailable') {
      console.log('[YOLOS] External model downloads blocked by page CSP (e.g. GitHub). Using fast on-device heuristic vision detector.');
      _backend = 'unavailable';
    }
    return null;
  }

  // Cool off 10s before retrying after an error, rather than locking out permanently
  if (_loadError && Date.now() - _lastErrorTime < 10000) return null;
  _loadError = null;

  if (_loading) {
    // Another call is already initializing — wait for it
    await new Promise<void>(resolve => _waiters.push(resolve));
    return _pipeline;
  }

  _loading = true;

  try {
    // Dynamic import keeps this out of the critical path during content script initialization
    const { pipeline, env } = await import(/* webpackMode: "eager" */ '@huggingface/transformers');

    // Allow downloading from HuggingFace CDN (one-time, then IndexedDB cached)
    env.allowRemoteModels = true;
    env.allowLocalModels  = false;

    // Configure WASM paths to extension's bundled WASM files (for WASM fallback)
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      try {
        if ((env as any).backends?.onnx?.wasm) {
          (env as any).backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort-wasm/');
          // Third-party pages do not provide Cross-Origin-Opener-Policy for SharedArrayBuffer,
          // so single-threaded WASM is required in content script context.
          (env as any).backends.onnx.wasm.numThreads = 1;
        }
      } catch { /* non-critical */ }
    }

    const hasGPU = await checkWebGPUSupport();
    let pipe: any = null;

    if (hasGPU) {
      try {
        _backend = 'WebGPU';
        console.log('[YOLOS] Initializing YOLOS-Tiny on WebGPU...');
        pipe = await pipeline(
          'object-detection',
          'Xenova/yolos-tiny',
          {
            device: 'webgpu',
            dtype: 'fp32',
          }
        );
        console.log('[YOLOS] YOLOS-Tiny ready on WebGPU');
      } catch (gpuErr) {
        console.warn('[YOLOS] WebGPU failed, attempting WASM fallback:', gpuErr);
        pipe = null;
      }
    }

    if (!pipe) {
      _backend = 'WASM';
      console.log('[YOLOS] Initializing YOLOS-Tiny on WASM fallback...');
      pipe = await pipeline(
        'object-detection',
        'Xenova/yolos-tiny',
        {
          device: 'wasm',
          dtype: 'fp32',
        }
      );
      console.log('[YOLOS] YOLOS-Tiny ready on WASM');
    }

    _pipeline = pipe;
    _loadError = null;
  } catch (err) {
    console.warn('[YOLOS] Initialization failed — falling back to existing heuristics:', err);
    _loadError = err as Error;
    _lastErrorTime = Date.now();
    _pipeline  = null;
  } finally {
    _loading = false;
    _waiters.forEach(r => r());
    _waiters.length = 0;
  }

  return _pipeline;
}

export interface VisionInferenceStats {
  model: string;
  backend: YOLOSBackend;
  inferenceMs: number;
  detectionCount: number;
  labels: string[];
}

export interface YOLOSDetectionResult {
  entities: PIIEntity[];
  stats: VisionInferenceStats;
}

let _latestStats: VisionInferenceStats = {
  model: 'Xenova/yolos-tiny',
  backend: 'unavailable',
  inferenceMs: 0,
  detectionCount: 0,
  labels: [],
};

// ── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * Run YOLOS-Tiny object detection on a screenshot canvas.
 *
 * Returns { entities, stats } compatible with the existing privacy pipeline.
 * Empty array is returned on any error (graceful degradation).
 *
 * @param canvas          Canvas containing the page screenshot
 * @param scrollX         Horizontal scroll offset for absolute bbox coordinates
 * @param scrollY         Vertical scroll offset for absolute bbox coordinates
 * @param scoreThreshold  Minimum detection confidence (default 0.5)
 */
export async function runYOLOSDetection(
  canvas: HTMLCanvasElement,
  scrollX = 0,
  scrollY = 0,
  scoreThreshold = 0.70,
  devicePixelRatio = 1
): Promise<YOLOSDetectionResult> {
  const t0 = performance.now();
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  const results: PIIEntity[] = [];
  const detectedLabels: string[] = [];

  try {
    // 1. Primary path: Offscreen document with pre-bundled local Xenova/yolos-tiny model (immune to page CSP)
    let detections: YOLOSDetection[] = [];
    let backendUsed: YOLOSBackend = 'unavailable';

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        const offscreenResp = await new Promise<any>((resolve) => {
          const timeout = setTimeout(() => resolve(null), 4000);
          chrome.runtime.sendMessage({
            type: 'VIT_INFERENCE',
            imageData: canvas.toDataURL('image/jpeg', 0.85),
            threshold: scoreThreshold,
          }, (resp) => {
            clearTimeout(timeout);
            const err = chrome.runtime.lastError;
            if (err || !resp?.ok) resolve(null);
            else resolve(resp);
          });
        });

        if (offscreenResp && Array.isArray(offscreenResp.detections)) {
          detections = offscreenResp.detections.map((d: any) => ({
            label: d.label,
            score: d.score,
            box: {
              xmin: d.bbox.x,
              ymin: d.bbox.y,
              xmax: d.bbox.x + d.bbox.width,
              ymax: d.bbox.y + d.bbox.height,
            },
          }));
          backendUsed = 'WebGPU';
          _backend = 'WebGPU';
          console.log(`[YOLOS] Offscreen bundled model detected ${detections.length} objects`);
        }
      } catch { /* fallback to local pipeline */ }
    }

    // 2. Fallback: Local pipeline if offscreen didn't run
    if (detections.length === 0) {
      const pipe = await Promise.race([
        getPipeline(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      if (pipe) {
        const localDets: YOLOSDetection[] = await Promise.race([
          pipe(canvas.toDataURL('image/jpeg', 0.85), { threshold: scoreThreshold }),
          new Promise<YOLOSDetection[]>((resolve) => setTimeout(() => resolve([]), 4000)),
        ]);
        if (localDets && localDets.length > 0) {
          detections = localDets;
          backendUsed = _backend;
        }
      }
    }

    const latencyMs = Math.round(performance.now() - t0);

    for (const det of detections) {
      const label = det.label.toLowerCase();
      detectedLabels.push(label);
      const mapping = PII_LABEL_MAP[label];
      if (!mapping) continue; // non-PII object — skip

      const { xmin, ymin, xmax, ymax } = det.box;
      const bbox: BoundingBox = {
        x:      Math.round(xmin / dpr + scrollX),
        y:      Math.round(ymin / dpr + scrollY),
        width:  Math.round((xmax - xmin) / dpr),
        height: Math.round((ymax - ymin) / dpr),
      };

      // Skip tiny boxes or oversized layout spans
      if (bbox.width < 24 || bbox.height < 24 || bbox.width > 400 || bbox.height > 400) continue;

      // Ensure detection lies on a real visual element (img or canvas), not empty HTML background
      const centerX = bbox.x - scrollX + bbox.width / 2;
      const centerY = bbox.y - scrollY + bbox.height / 2;
      if (centerX >= 0 && centerX <= window.innerWidth && centerY >= 0 && centerY <= window.innerHeight) {
        const el = document.elementFromPoint(centerX, centerY);
        if (el) {
          const isImageOrCanvas = el instanceof HTMLImageElement || el instanceof HTMLCanvasElement || !!el.closest('img, canvas, [class*="avatar"]');
          if (!isImageOrCanvas && mapping.piiType === 'face') {
            continue; // Skip phantom person detections in empty background / text
          }
        }
      }

      const entity: PIIEntity = {
        id:              `yolos-${label.replace(/\s/g, '_')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type:            mapping.piiType,
        confidence:      det.score,
        source:          'vision',
        sensitivity:     mapping.sensitivity,
        redactionMethod: mapping.method,
        bbox,
        placeholder:     `[${label.toUpperCase()} DETECTED]`,
        timestamp:       Date.now(),
      };

      results.push(entity);
    }

    _latestStats = {
      model: 'Xenova/yolos-tiny',
      backend: _backend,
      inferenceMs: latencyMs,
      detectionCount: results.length,
      labels: detectedLabels,
    };

    console.log(`[YOLOS] ${results.length} PII objects detected in ${latencyMs}ms (${_backend}) [all objects: ${detectedLabels.join(', ') || 'none'}]`);
  } catch (err) {
    console.warn('[YOLOS] Detection error:', err);
    _latestStats = {
      model: 'Xenova/yolos-tiny',
      backend: _backend,
      inferenceMs: Math.round(performance.now() - t0),
      detectionCount: 0,
      labels: [],
    };
  }

  return { entities: results, stats: _latestStats };
}

/**
 * Get latest vision inference stats for observability.
 */
export function getLatestInferenceStats(): VisionInferenceStats {
  return _latestStats;
}

/**
 * Get current backend status.
 */
export function getYOLOSStatus(): { backend: YOLOSBackend; loaded: boolean } {
  return { backend: _backend, loaded: _pipeline !== null };
}

/**
 * Raw detections (without PIIEntity mapping) — useful for diagnostics.
 */
export async function getRawYOLOSDetections(
  canvas: HTMLCanvasElement,
  scoreThreshold = 0.30
): Promise<YOLOSDetection[]> {
  try {
    const pipe = await getPipeline();
    if (!pipe) return [];
    return await pipe(canvas.toDataURL('image/jpeg', 0.85), { threshold: scoreThreshold });
  } catch {
    return [];
  }
}
