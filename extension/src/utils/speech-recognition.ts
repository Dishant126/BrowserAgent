/**
 * PrivSight — Native Web Speech Recognition Utility
 *
 * Provides a privacy-preserving voice-to-text integration using the browser's
 * native Web Speech API (SpeechRecognition / webkitSpeechRecognition).
 *
 * Privacy Guarantees:
 * - NO audio recordings or speech data are sent to the PrivSight backend.
 * - Only the resulting text transcript enters the prompt input field.
 * - Audio processing is handled strictly within the browser's speech recognition engine.
 */

// Browser SpeechRecognition interface augmentation
export interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

export interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

export interface SpeechRecognitionHandlers {
  onTranscript: (transcript: string, isFinal: boolean) => void;
  onStateChange: (isListening: boolean) => void;
  onError: (errorMessage: string, errorCode: string) => void;
}

/**
 * Checks whether speech recognition is supported in the current browser.
 */
export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

/**
 * Get the native SpeechRecognition constructor if available.
 */
function getSpeechRecognitionConstructor(): any {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

/**
 * Request microphone permission via getUserMedia.
 * In a Chrome extension popup, this may throw NotAllowedError if permission
 * hasn't been granted yet for the extension origin.
 */
export async function requestMicrophoneAccess(): Promise<{ granted: boolean; error?: string }> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return { granted: false, error: 'MediaDevices API not supported in this browser' };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Immediately stop tracks to release the microphone hardware
    stream.getTracks().forEach((track) => track.stop());
    return { granted: true };
  } catch (err: any) {
    return {
      granted: false,
      error: err?.name || err?.message || 'Permission denied',
    };
  }
}

/**
 * Opens the extension's dedicated voice permission tab so the user can grant
 * microphone permissions in a persistent tab context.
 */
export function openVoicePermissionPage(): void {
  try {
    if (typeof chrome !== 'undefined' && chrome.windows && chrome.runtime?.getURL) {
      const url = chrome.runtime.getURL('voice-permission.html');
      chrome.windows.create({
        url,
        type: 'popup',
        width: 460,
        height: 420,
        focused: true,
      });
    } else if (typeof chrome !== 'undefined' && chrome.tabs && chrome.runtime?.getURL) {
      chrome.tabs.create({ url: chrome.runtime.getURL('voice-permission.html') });
    }
  } catch (err) {
    console.error('[PrivSight Speech] Failed to open permission popup window:', err);
  }
}

/**
 * Map native speech recognition error codes to user-friendly messages.
 */
export function getFriendlySpeechErrorMessage(errorCode: string): string {
  switch (errorCode) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission denied. Please allow microphone access to use voice input.';
    case 'no-speech':
      return 'No speech was detected. Please try speaking again.';
    case 'audio-capture':
      return 'No microphone found. Please ensure a working microphone is connected.';
    case 'network':
      return 'Speech recognition service temporarily unavailable. Check your connection.';
    case 'aborted':
      return 'Voice input stopped.';
    case 'bad-grammar':
      return 'Speech grammar error.';
    case 'language-not-supported':
      return 'Your browser does not support the selected speech language.';
    default:
      return `Voice recognition error (${errorCode}).`;
  }
}

export class SpeechRecognitionManager {
  private recognition: any = null;
  private _isListening = false;
  private handlers: SpeechRecognitionHandlers | null = null;
  private currentFinalTranscript = '';
  private userStoppedManually = false;

  constructor() {
    const SpeechConstructor = getSpeechRecognitionConstructor();
    if (SpeechConstructor) {
      this.initRecognition(SpeechConstructor);
    }
  }

  private initRecognition(SpeechConstructor: any): void {
    try {
      this.recognition = new SpeechConstructor();
      this.recognition.continuous = false;
      this.recognition.interimResults = true;
      this.recognition.maxAlternatives = 1;
      this.recognition.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';

      this.recognition.onstart = () => {
        this._isListening = true;
        this.handlers?.onStateChange(true);
      };

      this.recognition.onresult = (event: SpeechRecognitionEvent) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const result = event.results[i];
          const transcriptChunk = result[0]?.transcript || '';
          if (result.isFinal) {
            finalTranscript += transcriptChunk;
          } else {
            interimTranscript += transcriptChunk;
          }
        }

        if (finalTranscript) {
          this.currentFinalTranscript = (this.currentFinalTranscript + ' ' + finalTranscript).trim();
          this.handlers?.onTranscript(this.currentFinalTranscript, true);
        } else if (interimTranscript) {
          const combined = (this.currentFinalTranscript + ' ' + interimTranscript).trim();
          this.handlers?.onTranscript(combined, false);
        }
      };

      this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        const error = event.error;
        // If the user deliberately clicked stop, aborted is not an error
        if (error === 'aborted' && this.userStoppedManually) {
          return;
        }

        const friendlyMsg = getFriendlySpeechErrorMessage(error);
        this.handlers?.onError(friendlyMsg, error);
      };

      this.recognition.onend = () => {
        this._isListening = false;
        this.userStoppedManually = false;
        this.handlers?.onStateChange(false);
      };
    } catch (err) {
      console.warn('[PrivSight Speech] Recognition init failed:', err);
      this.recognition = null;
    }
  }

  public get isListening(): boolean {
    return this._isListening;
  }

  public get isSupported(): boolean {
    return isSpeechRecognitionSupported() && this.recognition !== null;
  }

  /**
   * Start listening for voice input.
   */
  public start(handlers: SpeechRecognitionHandlers, initialTranscript = ''): boolean {
    if (!this.isSupported) {
      handlers.onError('Voice input is not supported in this browser.', 'not-supported');
      return false;
    }

    if (this._isListening) {
      // Prevent accidental repeated starts
      return true;
    }

    this.handlers = handlers;
    this.currentFinalTranscript = initialTranscript.trim();
    this.userStoppedManually = false;

    try {
      this.recognition.start();
      return true;
    } catch (err: any) {
      console.error('[PrivSight Speech] Start error:', err);
      // If already started or failed to initialize
      this._isListening = false;
      this.handlers?.onStateChange(false);
      const msg = getFriendlySpeechErrorMessage(err?.name || 'init-failed');
      this.handlers?.onError(msg, err?.name || 'init-failed');
      return false;
    }
  }

  /**
   * Stop listening and preserve whatever transcript was captured.
   */
  public stop(): void {
    if (!this._isListening || !this.recognition) return;
    this.userStoppedManually = true;
    try {
      this.recognition.stop();
    } catch {
      // Fallback if stop fails
      try {
        this.recognition.abort();
      } catch {}
    }
  }

  /**
   * Abort listening immediately.
   */
  public abort(): void {
    if (!this.recognition) return;
    this.userStoppedManually = true;
    try {
      this.recognition.abort();
    } catch {}
    this._isListening = false;
    this.handlers?.onStateChange(false);
  }
}
