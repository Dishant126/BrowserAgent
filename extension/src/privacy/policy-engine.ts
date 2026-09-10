/**
 * Policy Engine — maps PII types to sensitivity levels and redaction decisions.
 * The fail-safe rule: uncertain → BLOCK/REDACT.
 */
import type { PIIType, SensitivityLevel, RedactionMethod, PrivacySettings, PIIEntity } from '../utils/types';

export const DEFAULT_SETTINGS: PrivacySettings = {
  privacyLevel: 'STRICT',
  enabledCategories: [
    'email','phone','name','address','credit_card','cvv','password',
    'aadhaar','pan','dob','upi','ifsc','api_key','auth_token','face',
    'qr_code','account_number','passport','ssn',
  ],
  defaultRedactionMethod: 'mask',
  requireApprovalFor: ['navigate'],
  sendScreenshots: true,
  enableOCR: true,
  enableFaceDetection: true,
};

export const SENSITIVITY_THRESHOLDS: Record<SensitivityLevel, number> = {
  CRITICAL: 0.50, // Redact even at low confidence — fail-safe
  HIGH:     0.65,
  MEDIUM:   0.75,
  LOW:      0.85,
};

/** Filter entities by confidence threshold based on sensitivity + policy */
export function applyPolicy(entities: PIIEntity[], settings: PrivacySettings): PIIEntity[] {
  const enabled = new Set(settings.enabledCategories);
  return entities.filter(e => {
    if (!enabled.has(e.type)) return false;
    const threshold = SENSITIVITY_THRESHOLDS[e.sensitivity];
    // Fail-safe: if uncertain on CRITICAL items, still redact
    return e.confidence >= threshold || e.sensitivity === 'CRITICAL';
  });
}

/** Determine if a screenshot should be sent to the server */
export function shouldSendScreenshot(entities: PIIEntity[], settings: PrivacySettings): boolean {
  if (!settings.sendScreenshots) return false;
  // Only send if all visual PII has been redacted
  const unredactedVisual = entities.filter(e => e.bbox && e.source === 'vision');
  return unredactedVisual.length === 0;
}

/** Compute a composite privacy score for the session */
export function computePrivacyScore(
  detected: number,
  redacted: number,
  rawBytesTransmitted: number,
  rawScreenshots: number,
): { score: number; formula: string } {
  const recallScore = detected > 0 ? redacted / detected : 1.0;
  const transmitPenalty = rawBytesTransmitted > 0 ? 0 : 1.0;
  const screenshotPenalty = rawScreenshots > 0 ? 0 : 1.0;
  const score = Math.round((recallScore * 0.5 + transmitPenalty * 0.3 + screenshotPenalty * 0.2) * 100);
  return {
    score,
    formula: `score = (recall×0.5) + (no_raw_transmit×0.3) + (no_raw_screenshot×0.2) = ${score}/100`,
  };
}
