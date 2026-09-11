/**
 * ViT Inference Worker — On-Device Visual Perception via Transformers.js
 *
 * Runs inside the Chrome MV3 offscreen document (offscreen.html).
 * Uses Xenova/yolos-tiny (7MB ONNX model) for fast object detection.
 *
 * Device priority: WebGPU → WASM (auto-selected by Transformers.js)
 *
 * Message protocol:
 *   IN:  { type: 'VIT_INFERENCE', imageData: string (base64 dataURL), requestId: string }
 *   OUT: { type: 'VIT_RESULT', requestId, detections: VitDetection[], latencyMs, device, modelId }
 *   OUT: { type: 'VIT_LOADING', progress: number, status: string }
 *   OUT: { type: 'VIT_ERROR', requestId, error: string }
 */

// ── COCO LABEL → PII TYPE MAPPING ────────────────────────────────────────────

const COCO_TO_PII: Record<string, { piiType: string; sensitivity: string; redact: boolean }> = {
  'person':      { piiType: 'face',        sensitivity: 'HIGH',     redact: true  },
  'laptop':      { piiType: 'screen',      sensitivity: 'MEDIUM',   redact: false },
  'cell phone':  { piiType: 'screen',      sensitivity: 'MEDIUM',   redact: false },
  'tv':          { piiType: 'screen',      sensitivity: 'LOW',      redact: false },
  'monitor':     { piiType: 'screen',      sensitivity: 'LOW',      redact: false },
  'book':        { piiType: 'document',    sensitivity: 'LOW',      redact: false },
  'credit card': { piiType: 'credit_card', sensitivity: 'CRITICAL', redact: true  },
};

// ── TYPES ─────────────────────────────────────────────────────────────────────

export interface VitDetection {
  label: string;
  piiType: string;
  score: number;
  sensitivity: string;
  shouldRedact: boolean;
  bbox: { x: number; y: number; width: number; height: number };
}

// ── MODEL STATE ───────────────────────────────────────────────────────────────

let detector: any = null;
let modelLoadPromise: Promise<void> | null = null;
let isLoaded = false;
const MODEL_ID = 'Xenova/yolos-tiny';

// ── MODEL LOADER ──────────────────────────────────────────────────────────────

function broadcastProgress(status: string, progress: number) {
  try {
    chrome.runtime.sendMessage({ type: 'VIT_LOADING', status, progress, modelId: MODEL_ID }).catch(() => {});
  } catch { /* no listeners */ }
}

async function loadModel(): Promise<void> {
  if (isLoaded) return;
  if (modelLoadPromise) return modelLoadPromise;

  modelLoadPromise = (async () => {
    console.log('[ViT-Worker] Loading model:', MODEL_ID);
    broadcastProgress('Initializing ViT model...', 5);

    try {
      const { pipeline, env } = await import('@huggingface/transformers');

      // Use pre-bundled local model weights — 100% offline, zero network requests
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.localModelPath = chrome.runtime.getURL('models');

      // Configure WASM paths
      if ((env as any).backends?.onnx?.wasm) {
        (env as any).backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort-wasm/');
        (env as any).backends.onnx.wasm.numThreads = 1;
      }

      broadcastProgress('Loading bundled model weights...', 30);

      const loadOpts = (device: string) => ({
        dtype: 'q8',
        device,
      } as any);

      try {
        detector = await (pipeline as any)('object-detection', MODEL_ID, loadOpts('webgpu'));
        console.log('[ViT-Worker] Model ready on WebGPU:', MODEL_ID);
      } catch (gpuErr) {
        console.warn('[ViT-Worker] WebGPU unavailable in offscreen, using WASM:', gpuErr);
        detector = await (pipeline as any)('object-detection', MODEL_ID, loadOpts('wasm'));
        console.log('[ViT-Worker] Model ready on WASM:', MODEL_ID);
      }

      isLoaded = true;
      broadcastProgress('ViT model ready ✓', 100);
    } catch (err: any) {
      console.error('[ViT-Worker] Load failed:', err);
      modelLoadPromise = null;
      throw err;
    }
  })();

  return modelLoadPromise;
}

// ── INFERENCE ─────────────────────────────────────────────────────────────────

async function runInference(imageDataUrl: string, threshold = 0.30): Promise<VitDetection[]> {
  await loadModel();

  const t0 = performance.now();

  const rawResults: Array<{
    label: string;
    score: number;
    box: { xmin: number; ymin: number; xmax: number; ymax: number };
  }> = await detector(imageDataUrl, { threshold });

  const latencyMs = Math.round(performance.now() - t0);
  console.log(`[ViT-Worker] ${rawResults.length} detections in ${latencyMs}ms`);

  return rawResults
    .filter(r => r.score >= threshold)
    .map(r => {
      const mapping = COCO_TO_PII[r.label.toLowerCase()] ?? {
        piiType: 'unknown', sensitivity: 'LOW', redact: false,
      };
      return {
        label: r.label,
        piiType: mapping.piiType,
        score: r.score,
        sensitivity: mapping.sensitivity,
        shouldRedact: mapping.redact,
        bbox: {
          x: r.box.xmin,
          y: r.box.ymin,
          width: r.box.xmax - r.box.xmin,
          height: r.box.ymax - r.box.ymin,
        },
      };
    })
    .sort((a, b) => b.score - a.score);
}

// ── MESSAGE HANDLER ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'VIT_INFERENCE') {
    const { imageData, requestId, threshold } = message;
    (async () => {
      try {
        const detections = await runInference(imageData, threshold ?? 0.30);
        sendResponse({ type: 'VIT_RESULT', requestId, detections, modelId: MODEL_ID, ok: true });
      } catch (err: any) {
        sendResponse({ type: 'VIT_ERROR', requestId, error: err?.message ?? String(err), ok: false });
      }
    })();
    return true;
  }

  if (message.type === 'VIT_PRELOAD') {
    loadModel().catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'VIT_STATUS') {
    sendResponse({ loaded: isLoaded, model: MODEL_ID });
    return;
  }
});

// Pre-warm on load
console.log('[ViT-Worker] Offscreen ViT worker initialized. Pre-warming...');
loadModel().catch(err => console.warn('[ViT-Worker] Pre-warm failed (will retry on demand):', err));
