"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { probeVoice, synthesize, transcribe } from "@/lib/api/voice";
import { useNemoStore } from "@/store";

/** Pick a MediaRecorder mime type the current browser actually supports. */
function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

export type VadState =
  | "idle"
  | "listening"
  | "speech_detected"
  | "in_speech"
  | "post_speech_silence"
  | "committing";

// ── VAD constants ──
const SPEECH_THRESHOLD_RMS   = 0.045;
const NOISE_FLOOR_RMS        = 0.020;
const SPEECH_CONFIRM_MS      = 180;
const PRE_SPEECH_TIMEOUT_MS  = 8_000;
const SHORT_UTT_THRESHOLD_MS = 2_000;
const LONG_SILENCE_MS        = 2_500;
const SHORT_SILENCE_MS       = 1_200;
const MAX_TICK_DELTA_MS      = 100;

export interface UseVoice {
  /** Whether ElevenLabs is wired (probed from the server). */
  available: boolean;
  recording: boolean;
  transcribing: boolean;
  speaking: boolean;
  /** Live input level 0..1 (RMS) while recording — drives the meter. */
  level: number;
  vadState: VadState;
  toggleRecording(): Promise<void>;
  cancelRecording(): void;
  /** Speak arbitrary text (queued, sequential playback). */
  speak(text: string): Promise<void>;
  stopSpeaking(): void;
}

export function useVoice(): UseVoice {
  const available = useNemoStore((s) => s.voiceAvailable);
  const recording = useNemoStore((s) => s.voiceRecording);
  const transcribing = useNemoStore((s) => s.voiceTranscribing);
  const speaking = useNemoStore((s) => s.voiceSpeaking);

  const setVoiceAvailable = useNemoStore((s) => s.setVoiceAvailable);
  const setVoiceRecording = useNemoStore((s) => s.setVoiceRecording);
  const setVoiceTranscribing = useNemoStore((s) => s.setVoiceTranscribing);
  const setVoiceSpeaking = useNemoStore((s) => s.setVoiceSpeaking);
  const voiceVadState = useNemoStore((s) => s.voiceVadState);
  const setVoiceVadState = useNemoStore((s) => s.setVoiceVadState);
  const addOperatorMessage = useNemoStore((s) => s.addOperatorMessage);
  const requestAgentRun = useNemoStore((s) => s.requestAgentRun);

  const [level, setLevel] = useState(0);

  // ── recording refs ──
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  // ── playback refs ──
  const playQueue = useRef<string[]>([]);
  const playing = useRef(false);
  const activeAudio = useRef<HTMLAudioElement | null>(null);
  const activeAudioUrl = useRef<string | null>(null);

  // ── VAD refs ──
  const vadStateRef         = useRef<VadState>("idle");
  const speechConfirmAccRef = useRef(0);
  const totalSpeechMsRef    = useRef(0);
  const silenceStartRef     = useRef<number | null>(null);
  const recordingStartRef   = useRef<number>(0);
  const prevTickTimeRef     = useRef<number>(0);

  // Probe availability once on mount.
  useEffect(() => {
    let alive = true;
    void probeVoice().then((ok) => {
      if (alive) setVoiceAvailable(ok);
    });
    return () => {
      alive = false;
    };
  }, [setVoiceAvailable]);

  // ── level metering ──
  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setLevel(0);
  }, []);

  // ── teardown of the recording graph (stream, ctx, raf) ──
  const teardownRecording = useCallback(() => {
    stopMeter();
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    recorderRef.current = null;
  }, [stopMeter]);

  // ── TTS playback queue (ElevenLabs → MP3 → HTMLAudioElement) ──
  const drainQueue = useCallback(async () => {
    if (playing.current) return;
    playing.current = true;
    setVoiceSpeaking(true);

    try {
      for (;;) {
        const next = playQueue.current.shift();
        if (next === undefined) break;
        if (!playing.current) break; // stopSpeaking() called mid-loop

        let blob: Blob | null = null;
        try {
          blob = await synthesize(next);
        } catch (err) {
          console.warn("[tts] ElevenLabs unavailable, falling back to browser TTS:", err);
        }
        if (!playing.current) break;

        if (blob) {
          const url = URL.createObjectURL(blob);
          activeAudioUrl.current = url;
          await new Promise<void>((resolve) => {
            const audio = new Audio(url);
            activeAudio.current = audio;
            audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
            audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
            audio.play().catch(() => { URL.revokeObjectURL(url); resolve(); });
          });
          activeAudio.current = null;
          activeAudioUrl.current = null;
        } else if (typeof window !== "undefined" && "speechSynthesis" in window) {
          await new Promise<void>((resolve) => {
            const utt = new SpeechSynthesisUtterance(next);
            utt.onend = () => resolve();
            utt.onerror = () => resolve();
            window.speechSynthesis.speak(utt);
          });
        }
      }
    } finally {
      playing.current = false;
      setVoiceSpeaking(false);
    }
  }, [setVoiceSpeaking]);

  const speak = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      playQueue.current.push(trimmed);
      await drainQueue();
    },
    [drainQueue],
  );

  const stopSpeaking = useCallback(() => {
    playQueue.current = [];
    playing.current = false;
    if (activeAudio.current) {
      activeAudio.current.pause();
      activeAudio.current = null;
    }
    if (activeAudioUrl.current) {
      URL.revokeObjectURL(activeAudioUrl.current);
      activeAudioUrl.current = null;
    }
    setVoiceSpeaking(false);
  }, [setVoiceSpeaking]);

  const runMeter = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    prevTickTimeRef.current = performance.now();

    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      setLevel(Math.min(1, rms * 3.2));

      const now = performance.now();
      const delta = Math.min(now - prevTickTimeRef.current, MAX_TICK_DELTA_MS);
      prevTickTimeRef.current = now;

      const state = vadStateRef.current;

      const setVad = (next: VadState) => {
        if (vadStateRef.current !== next) {
          vadStateRef.current = next;
          setVoiceVadState(next);
        }
      };

      if (state === "listening") {
        if (rms > SPEECH_THRESHOLD_RMS) {
          speechConfirmAccRef.current = 0;
          setVad("speech_detected");
        } else if (now - recordingStartRef.current > PRE_SPEECH_TIMEOUT_MS) {
          // No speech detected in time — discard silently
          setVad("idle");
          // tear down without submitting
          stopMeter();
          if (streamRef.current) {
            for (const t of streamRef.current.getTracks()) t.stop();
            streamRef.current = null;
          }
          if (audioCtxRef.current) {
            void audioCtxRef.current.close().catch(() => {});
            audioCtxRef.current = null;
          }
          analyserRef.current = null;
          if (recorderRef.current && recorderRef.current.state !== "inactive") {
            // Prevent onstop from triggering transcription
            recorderRef.current.ondataavailable = null;
            recorderRef.current.onstop = () => {
              chunksRef.current = [];
              recorderRef.current = null;
              setVoiceRecording(false);
            };
            recorderRef.current.stop();
          }
          return;
        }
      } else if (state === "speech_detected") {
        if (rms > SPEECH_THRESHOLD_RMS) {
          speechConfirmAccRef.current += delta;
          if (speechConfirmAccRef.current >= SPEECH_CONFIRM_MS) {
            totalSpeechMsRef.current = 0;
            setVad("in_speech");
          }
        } else if (rms < NOISE_FLOOR_RMS) {
          setVad("listening");
        }
      } else if (state === "in_speech") {
        if (rms > NOISE_FLOOR_RMS) {
          totalSpeechMsRef.current += delta;
        } else {
          silenceStartRef.current = now;
          setVad("post_speech_silence");
        }
      } else if (state === "post_speech_silence") {
        if (rms > NOISE_FLOOR_RMS) {
          silenceStartRef.current = null;
          setVad("in_speech");
        } else {
          const silenceDuration = now - (silenceStartRef.current ?? now);
          const threshold =
            totalSpeechMsRef.current < SHORT_UTT_THRESHOLD_MS
              ? LONG_SILENCE_MS
              : SHORT_SILENCE_MS;
          if (silenceDuration >= threshold) {
            setVad("committing");
            // Stop the recorder — onstop will handle transcription
            const recorder = recorderRef.current;
            if (recorder && recorder.state !== "inactive") {
              recorder.stop();
            }
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [stopMeter, setVoiceVadState, setVoiceRecording]);

  const startRecording = useCallback(async () => {
    if (!available) return;
    if (recorderRef.current) return; // already recording
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      // Level meter graph.
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        analyserRef.current = analyser;
        runMeter();
      }

      const mimeType = pickMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        teardownRecording();
        setVoiceRecording(false);

        if (blob.size === 0) {
          vadStateRef.current = "idle";
          setVoiceVadState("idle");
          return;
        }

        setVoiceTranscribing(true);
        void transcribe(blob)
          .then((text) => {
            const trimmed = text.trim();
            if (trimmed.length > 0) {
              addOperatorMessage(trimmed);
              requestAgentRun({ prompt: trimmed });
            }
          })
          .catch(() => {})
          .finally(() => {
            setVoiceTranscribing(false);
            vadStateRef.current = "idle";
            setVoiceVadState("idle");
          });
      };

      recordingStartRef.current = performance.now();
      recorder.start();
      vadStateRef.current = "listening";
      setVoiceVadState("listening");
      setVoiceRecording(true);
    } catch {
      teardownRecording();
      setVoiceRecording(false);
      vadStateRef.current = "idle";
      setVoiceVadState("idle");
    }
  }, [
    available,
    runMeter,
    teardownRecording,
    setVoiceRecording,
    setVoiceTranscribing,
    setVoiceVadState,
    addOperatorMessage,
    requestAgentRun,
  ]);

  const cancelRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = () => {
        chunksRef.current = [];
        recorderRef.current = null;
        setVoiceRecording(false);
      };
      recorder.stop();
    }
    teardownRecording();
    setVoiceRecording(false);
    vadStateRef.current = "idle";
    setVoiceVadState("idle");
  }, [teardownRecording, setVoiceRecording, setVoiceVadState]);

  const toggleRecording = useCallback(async () => {
    if (vadStateRef.current !== "idle") {
      // Manual cancel — discard blob
      cancelRecording();
      return;
    }
    if (!available) return;
    // Stop any TTS before recording
    stopSpeaking();
    await startRecording();
  }, [available, cancelRecording, startRecording, stopSpeaking]);

  // ── unmount cleanup ──
  useEffect(() => {
    return () => {
      cancelRecording();
      stopSpeaking();
    };
  }, [cancelRecording, stopSpeaking]);

  return {
    available,
    recording,
    transcribing,
    speaking,
    level,
    vadState: voiceVadState,
    toggleRecording,
    cancelRecording,
    speak,
    stopSpeaking,
  };
}

/**
 * Optional companion: auto-speaks the latest COMPLETED agent message.
 * Mount this once (e.g. alongside the agent console) and toggle with `enabled`.
 * Safe no-op when voice is unavailable or disabled.
 */
export function useAutoSpeakLatest(speak: UseVoice["speak"], enabled: boolean): void {
  const available = useNemoStore((s) => s.voiceAvailable);
  const messages = useNemoStore((s) => s.messages);
  const streaming = useNemoStore((s) => s.streaming);
  const spokenId = useRef<string | null>(null);
  // Tracks the enabled value from the previous effect run so we can detect
  // the false→true transition and suppress history replay only on that frame.
  const wasEnabledRef = useRef(false);

  useEffect(() => {
    const wasEnabled = wasEnabledRef.current;
    wasEnabledRef.current = enabled;

    if (!enabled || !available) return;
    if (streaming) return;

    // Find the most recent finished agent message.
    let latest: (typeof messages)[number] | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "agent" && !m.streaming) {
        latest = m;
        break;
      }
    }
    if (!latest) return;

    // On the frame where enabled just became true, mark the current latest as
    // already seen so we don't replay prior conversation history. Any message
    // that arrives after this point (including messages already streaming when
    // the toggle fired) will be spoken normally.
    if (!wasEnabled) {
      spokenId.current = latest.id;
      return;
    }
    if (latest.id === spokenId.current) return;

    spokenId.current = latest.id;
    if (latest.content.trim().length > 0) {
      void speak(latest.content);
    }
  }, [enabled, available, streaming, messages, speak]);
}
