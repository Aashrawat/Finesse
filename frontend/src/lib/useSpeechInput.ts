import { useCallback, useEffect, useRef, useState } from "react";

// The browser's built-in speech recognition (Chrome, Edge, Safari). It isn't in TypeScript's DOM types.
interface RecognitionAlternative { transcript: string }
interface RecognitionResult { isFinal: boolean; length: number; [index: number]: RecognitionAlternative }
interface RecognitionEvent { results: { length: number; [index: number]: RecognitionResult } }
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked. Allow the microphone in your browser's site settings to speak your prompt.",
  "service-not-allowed": "Microphone access is blocked. Allow the microphone in your browser's site settings to speak your prompt.",
  "audio-capture": "No microphone was found.",
  network: "Voice input needs an internet connection.",
};

/**
 * Speak instead of type. `onTranscript` gets everything said since `start()` (finished words plus the
 * words still being recognised), so the caller can show it live after whatever was already typed.
 */
export function useSpeechInput(onTranscript: (text: string) => void, onError: (message: string) => void) {
  const supported = recognitionCtor() !== undefined;
  const [listening, setListening] = useState(false);
  const active = useRef<Recognition | null>(null);
  const transcript = useRef(onTranscript);
  const failure = useRef(onError);
  transcript.current = onTranscript;
  failure.current = onError;

  const stop = useCallback(() => active.current?.stop(), []);

  /** Stop at once and ignore anything still being recognised (the message was sent, or the user started typing). */
  const abort = useCallback(() => {
    const rec = active.current;
    if (!rec) return;
    rec.onresult = null;
    rec.abort();
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || active.current) return;
    const rec = new Ctor();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let said = "";
      for (let i = 0; i < e.results.length; i++) said += e.results[i][0].transcript;
      transcript.current(said.trim());
    };
    rec.onerror = (e) => {
      const message = ERRORS[e.error];
      if (message) failure.current(message); // "no-speech" and "aborted" are not worth a message
    };
    rec.onend = () => {
      active.current = null;
      setListening(false);
    };
    try {
      rec.start();
      active.current = rec;
      setListening(true);
    } catch {
      failure.current("Couldn't start voice input. Please try again.");
    }
  }, []);

  // Never leave the microphone on after leaving the page
  useEffect(() => () => active.current?.abort(), []);

  return { supported, listening, start, stop, abort };
}
