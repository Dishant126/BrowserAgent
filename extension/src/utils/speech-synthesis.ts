/**
 * PrivSight — Native Web Speech Synthesis (Voice Output) Utility
 *
 * Provides a privacy-preserving text-to-speech status feedback mechanism
 * using the browser's native Web Speech API (window.speechSynthesis & SpeechSynthesisUtterance).
 *
 * Privacy Guarantees:
 * - 100% Native & Local: Generated entirely within the browser engine.
 * - Zero External Providers: No text or audio is ever sent to any cloud TTS service.
 * - Strict PII Protection: Sensitive data (emails, passwords, phone numbers, tokens)
 *   is never spoken aloud; safe semantic descriptions are used instead.
 */

import type { BrowserAction } from './types';

export interface VoiceOutputOptions {
  rate?: number;
  pitch?: number;
  volume?: number;
  lang?: string;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (err: any) => void;
}

// ── PII & SENSITIVE DATA DETECTION FOR SPEECH ────────────────────────────────

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i;
const PHONE_REGEX = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/;
const CREDIT_CARD_REGEX = /\b(?:\d{4}[-\s]?){3}\d{4}\b/;
const TOKEN_KEY_REGEX = /\b(?:bearer\s+[a-zA-Z0-9_\-\.]+|ghp_[a-zA-Z0-9]+|sk-[a-zA-Z0-9]{20,}|eyJ[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,})\b/i;
const REDACTED_PLACEHOLDER_REGEX = /\[.*(?:REDACTED|BLURRED|MASKED).*\].*/i;

/**
 * Checks if a piece of text contains sensitive information or PII.
 */
export function containsSensitiveData(text: string): boolean {
  if (!text) return false;
  return (
    EMAIL_REGEX.test(text) ||
    PHONE_REGEX.test(text) ||
    CREDIT_CARD_REGEX.test(text) ||
    TOKEN_KEY_REGEX.test(text) ||
    REDACTED_PLACEHOLDER_REGEX.test(text)
  );
}

/**
 * Sanitizes search / input queries for spoken output:
 * - Strips any detected PII
 * - Limits length to ~30 characters to avoid excessive speech
 * - Replaces URLs with clean domains
 */
export function sanitizeTextForSpeech(text: string, maxLength: number = 32): string {
  if (!text) return '';
  let clean = text.trim();

  // If text contains an email, mask it
  clean = clean.replace(EMAIL_REGEX, 'email address');
  // If text contains a phone number, mask it
  clean = clean.replace(PHONE_REGEX, 'phone number');
  // If text contains a credit card, mask it
  clean = clean.replace(CREDIT_CARD_REGEX, 'card details');
  // Strip tokens/keys
  clean = clean.replace(TOKEN_KEY_REGEX, 'secret key');
  // Clean up any remaining redaction brackets
  clean = clean.replace(/\[.*?(?:REDACTED|BLURRED|MASKED).*?\]/gi, 'sensitive data');

  // Truncate to reasonable length for spoken clarity
  if (clean.length > maxLength) {
    clean = clean.slice(0, maxLength).trim() + '…';
  }

  return clean;
}

/**
 * Extracts a clean, human-pronounceable domain from a URL.
 * e.g., "https://en.wikipedia.org/wiki/Main_Page" -> "wikipedia.org"
 */
export function getDomainFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    if (host.startsWith('en.')) host = host.slice(3);
    return host || 'page';
  } catch {
    return 'the requested page';
  }
}

/**
 * Creates a safe, action-aware spoken message from a BrowserAction.
 * Strictly avoids internal state narration (PERCEIVING, SANITIZING, PLANNING).
 * Returns null if the action does not warrant spoken feedback.
 */
export function getSafeSpokenActionMessage(
  action: BrowserAction,
  targetFriendlyName?: string
): string | null {
  if (!action) return null;

  switch (action.action) {
    case 'navigate': {
      if (action.url) {
        const domain = getDomainFromUrl(action.url);
        return `Navigating to ${domain}.`;
      }
      return 'Navigating to page.';
    }

    case 'click': {
      const label = targetFriendlyName || action.target?.friendlyName || action.target?.label || '';
      if (label) {
        const safeLabel = sanitizeTextForSpeech(label, 30);
        // Distinguish common actions
        if (/search|submit|go|find/i.test(safeLabel)) {
          return `Searching ${safeLabel}.`;
        }
        if (/download/i.test(safeLabel)) {
          return `Downloading ${safeLabel}.`;
        }
        return `Opening ${safeLabel}.`;
      }
      return 'Clicking selected element.';
    }

    case 'fill': {
      const targetName = (targetFriendlyName || action.target?.friendlyName || action.target?.label || '').toLowerCase();
      const rawVal = action.value || '';
      const isSensitiveField =
        targetName.includes('password') ||
        targetName.includes('pin') ||
        targetName.includes('secret') ||
        targetName.includes('token') ||
        action.requiresApproval;

      if (isSensitiveField || targetName.includes('password')) {
        return 'Entering the password.';
      }

      if (EMAIL_REGEX.test(rawVal) || targetName.includes('email')) {
        return 'Entering the email address.';
      }

      if (PHONE_REGEX.test(rawVal) || targetName.includes('phone') || targetName.includes('mobile')) {
        return 'Entering the phone number.';
      }

      if (targetName.includes('search') || targetName.includes('query') || targetName.includes('find')) {
        if (containsSensitiveData(rawVal)) {
          return 'Entering search query.';
        }
        const safeQuery = sanitizeTextForSpeech(rawVal, 25);
        return safeQuery ? `Searching for ${safeQuery}.` : 'Entering search query.';
      }

      // General input field
      if (targetFriendlyName && !containsSensitiveData(targetFriendlyName)) {
        const safeName = sanitizeTextForSpeech(targetFriendlyName, 25);
        return `Entering ${safeName}.`;
      }

      return 'Entering details.';
    }

    case 'scroll': {
      return 'Looking for more results.';
    }

    case 'wait': {
      return 'Waiting for the page to load.';
    }

    case 'ask_user': {
      if (targetFriendlyName) {
        return `Would you like me to click ${sanitizeTextForSpeech(targetFriendlyName, 25)}?`;
      }
      return 'Waiting for your confirmation.';
    }

    case 'finish':
    case 'done': {
      if (action.reason && !containsSensitiveData(action.reason)) {
        const cleanReason = sanitizeTextForSpeech(action.reason, 60);
        if (cleanReason.toLowerCase().startsWith('done')) {
          return cleanReason.endsWith('.') ? cleanReason : `${cleanReason}.`;
        }
        return `Done. ${cleanReason}`;
      }
      return 'Done. Task completed.';
    }

    default:
      return null;
  }
}

// ── VOICE OUTPUT MANAGER CLASS ────────────────────────────────────────────────

export type VoiceStateListener = (isSpeaking: boolean, isEnabled: boolean) => void;

export class VoiceOutputManager {
  private enabled: boolean = true;
  private isSpeaking: boolean = false;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private selectedVoice: SpeechSynthesisVoice | null = null;
  private listeners: Set<VoiceStateListener> = new Set();
  private isInitialized: boolean = false;

  constructor() {
    this.init();
  }

  private init(): void {
    if (this.isInitialized) return;
    this.isInitialized = true;

    // Load persisted voiceOutputEnabled preference from chrome.storage.local
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(['voiceOutputEnabled'], (res) => {
          if (res && typeof res.voiceOutputEnabled === 'boolean') {
            this.enabled = res.voiceOutputEnabled;
            this.notify();
          }
        });
      }
    } catch {}

    // Initialize voice list if in browser DOM context
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.selectBestVoice();
      if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = () => this.selectBestVoice();
      }
    }
  }

  private selectBestVoice(): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      const voices = window.speechSynthesis.getVoices();
      if (!voices || voices.length === 0) return;

      // Prefer high quality English voice (Google, Microsoft, Natural, or default)
      const preferred = voices.find(
        (v) =>
          v.lang.startsWith('en') &&
          (v.name.includes('Natural') ||
           v.name.includes('Google') ||
           v.name.includes('Jenny') ||
           v.name.includes('Guy') ||
           v.name.includes('Samantha'))
      ) || voices.find((v) => v.lang.startsWith('en')) || voices[0];

      if (preferred) {
        this.selectedVoice = preferred;
      }
    } catch {}
  }

  /**
   * Check if speech synthesis is supported in the current environment.
   */
  public isSupported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  /**
   * Check whether Voice Output is currently enabled by the user.
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Check whether speech is actively playing.
   */
  public isCurrentlySpeaking(): boolean {
    return this.isSpeaking;
  }

  /**
   * Enable or disable voice output (Mute / Unmute).
   * - When disabled (OFF): immediately halts active speech and clears state.
   * - When enabled (ON): ready for next action; never replays interrupted speech.
   */
  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;

    if (!enabled) {
      // Immediately cancel any currently speaking utterance
      this.cancel();
    }

    // Persist preference locally
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set({ voiceOutputEnabled: enabled });
      }
    } catch {}

    this.notify();
  }

  /**
   * Subscribe to state changes (speaking state or mute state changes).
   */
  public subscribe(listener: VoiceStateListener): () => void {
    this.listeners.add(listener);
    listener(this.isSpeaking, this.enabled);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((fn) => {
      try {
        fn(this.isSpeaking, this.enabled);
      } catch {}
    });
  }

  /**
   * Immediately cancel any current speech playback and clean up utterance.
   */
  public cancel(): void {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    this.currentUtterance = null;
    this.isSpeaking = false;
    this.notify();
  }

  /**
   * Speak a short status message.
   * - If disabled or empty: does nothing and returns false.
   * - Overlapping policy: cancels current utterance and speaks latest status immediately.
   * - Never throws; handles errors gracefully.
   */
  public speak(text: string, options?: VoiceOutputOptions): boolean {
    if (!this.enabled || !text || !text.trim()) {
      return false;
    }

    if (!this.isSupported()) {
      return false;
    }

    const cleanText = text.trim();

    try {
      // 1. Cancel previous speech immediately to prevent overlapping or stale queues
      this.cancel();

      // 2. Create SpeechSynthesisUtterance
      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.rate = options?.rate ?? 1.05;
      utterance.pitch = options?.pitch ?? 1.0;
      utterance.volume = options?.volume ?? 1.0;

      if (this.selectedVoice) {
        utterance.voice = this.selectedVoice;
      } else if (options?.lang) {
        utterance.lang = options.lang;
      }

      this.currentUtterance = utterance;

      utterance.onstart = () => {
        this.isSpeaking = true;
        this.notify();
        options?.onStart?.();
      };

      utterance.onend = () => {
        if (this.currentUtterance === utterance) {
          this.currentUtterance = null;
          this.isSpeaking = false;
          this.notify();
        }
        options?.onEnd?.();
      };

      utterance.onerror = (e) => {
        // 'canceled' or 'interrupted' is normal when user toggles OFF or next action arrives
        if (this.currentUtterance === utterance) {
          this.currentUtterance = null;
          this.isSpeaking = false;
          this.notify();
        }
        options?.onError?.(e);
      };

      window.speechSynthesis.speak(utterance);
      return true;
    } catch (err) {
      console.warn('[PrivSight TTS] Speech synthesis warning:', err);
      this.isSpeaking = false;
      this.currentUtterance = null;
      this.notify();
      return false;
    }
  }
}

// Export singleton instance for reuse across components within the same context
export const voiceOutputManager = new VoiceOutputManager();
