/**
 * Offscreen Document Entry Point
 * Bundles OCR (Tesseract.js) and ViT Local Vision (Transformers.js YOLOS-Tiny).
 * Runs with full extension_pages CSP (wasm-unsafe-eval allowed).
 */
import './ocr';
import './vit-worker';
