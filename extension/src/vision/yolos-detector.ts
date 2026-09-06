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
  'cell phone':  { piiType: 'face',        sensitivity: 'MEDIUM',   method: 'blur' },
  'book':        { piiType: 'face',        sensitivity: 'LOW',      method: 'blur' },
  'laptop':      { piiType: 'face',        sensitivity: 'LOW',      method: 'blur' },
  'tv':          { piiType: 'face',        sensitivity: 'LOW',      method: 'blur' },
};

// ── MODEL STATE ───────────────────────────────────────────────────────────────

let _pipeline: any = null;
let _loading = false;
let _loadError: Error | null = null;
let _backend: YOLOSBackend = 'unavailable';
const _waiters: Array<() => void> = [];

// ── MODEL INITIALIZATION ──────────────────────────────────────────────────────

/**
 * Lazily initialize the YOLOS-Tiny pipeline.
 * Model is downloaded from HuggingFace on first call and cached in browser IndexedDB.
 * Subsequent calls load from cache (fast, no network).
 */
async function getPipeline(): Promise<any | null> {
  if (_pipeline) return _pipeline;
  if (_loadError) return null;

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
        (env as any).backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort-wasm/');
      } catch { /* non-critical — WebGPU doesn't need WASM paths */ }
    }

    const hasGPU = await checkWebGPUSupport();
    const device  = hasGPU ? 'webgpu' : 'wasm';
    _backend = hasGPU ? 'WebGPU' : 'WASM';

    console.log(`[YOLOS] Initializing YOLOS-Tiny on ${_backend}...`);

    _pipeline = await pipeline(
      'object-detection',
      'Xenova/yolos-tiny',
      {
        device,
        // fp32 dtype — quantized variants can be set to 'int8' for faster loading
        dtype: 'fp32',
      }
    );

    console.log(`[YOLOS] YOLOS-Tiny ready on ${_backend}`);
  } catch (err) {
    console.warn('[YOLOS] Initialization failed — falling back to existing heuristics:', err);
    _loadError = err as Error;
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
  scoreThreshold = 0.50
): Promise<YOLOSDetectionResult> {
  const t0 = performance.now();
  const results: PIIEntity[] = [];
  const detectedLabels: string[] = [];

  try {
    const pipe = await Promise.race([
      getPipeline(),
      new Promise<null>((resolve) => setTimeout(() => {
        console.warn('[YOLOS] Pipeline initialization timed out (1500ms limit)');
        resolve(null);
      }, 1500)),
    ]);

    if (!pipe) {
      const stats: VisionInferenceStats = {
        model: 'Xenova/yolos-tiny',
        backend: _backend,
        inferenceMs: Math.round(performance.now() - t0),
        detectionCount: 0,
        labels: [],
      };
      _latestStats = stats;
      return { entities: [], stats };
    }

    // Convert canvas to JPEG data URL for the pipeline
    const imageDataUrl = canvas.toDataURL('image/jpeg', 0.85);

    const detections: YOLOSDetection[] = await Promise.race([
      pipe(imageDataUrl, { threshold: scoreThreshold }),
      new Promise<YOLOSDetection[]>((resolve) => setTimeout(() => resolve([]), 1500)),
    ]);

    const latencyMs = Math.round(performance.now() - t0);

    for (const det of detections) {
      const label = det.label.toLowerCase();
      detectedLabels.push(label);
      const mapping = PII_LABEL_MAP[label];
      if (!mapping) continue; // non-PII object — skip

      const { xmin, ymin, xmax, ymax } = det.box;
      const bbox: BoundingBox = {
        x:      Math.round(xmin + scrollX),
        y:      Math.round(ymin + scrollY),
        width:  Math.round(xmax - xmin),
        height: Math.round(ymax - ymin),
      };

      // Skip tiny boxes — likely noise
      if (bbox.width < 16 || bbox.height < 16) continue;

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
