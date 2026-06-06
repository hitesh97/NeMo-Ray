"use client";

import { useCallback, useState, type FormEvent, type KeyboardEvent } from "react";
import { CornerDownLeft, Loader2, Mic, Volume2, VolumeX } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/components/primitives";
import { useAutoSpeakLatest, useVoice } from "@/hooks/useVoice";
import { useNemoStore } from "@/store";

/**
 * Bottom-pinned operator input for the agent console. Type a prompt and submit
 * on Enter, or hold the mic to dictate it — voice is just another way to talk to
 * the agent, transcribed straight into this same input pipeline (not a separate
 * card). Auto-speak echoes the agent's replies aloud when toggled on.
 */
export function AgentComposer({ className }: { className?: string }) {
  const [value, setValue] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(false);
  const streaming = useNemoStore((s) => s.streaming);
  const addOperatorMessage = useNemoStore((s) => s.addOperatorMessage);
  const requestAgentRun = useNemoStore((s) => s.requestAgentRun);

  const sendPrompt = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      addOperatorMessage(trimmed);
      requestAgentRun({ prompt: trimmed });
    },
    [addOperatorMessage, requestAgentRun],
  );

  const {
    available,
    recording,
    transcribing,
    speaking,
    vadState,
    toggleRecording,
    stopSpeaking,
    speak,
  } = useVoice();

  useAutoSpeakLatest(speak, autoSpeak);

  const submit = () => {
    const text = value.trim();
    if (!text || streaming) return;
    sendPrompt(text);
    setValue("");
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Toggle mic — click to start VAD recording; click again (or VAD auto-commits) to stop.
  const onMicClick = useCallback(() => {
    if (!available || transcribing || streaming) return;
    void toggleRecording();
  }, [available, transcribing, streaming, toggleRecording]);

  const canSend = value.trim().length > 0 && !streaming;

  const placeholder = streaming
    ? "Agent is responding…"
    : vadState === "listening"
      ? "Listening… click mic to cancel"
      : vadState === "speech_detected" || vadState === "in_speech"
        ? "Speaking… click mic to stop"
        : vadState === "post_speech_silence"
          ? "Finishing…"
          : transcribing
            ? "Transcribing…"
            : "Ask the AI agent — type or click the mic…";

  return (
    <div className={cn("shrink-0 border-t border-hairline bg-panel/60", className)}>
      <form onSubmit={onSubmit} className="flex items-center gap-2 px-2.5 py-2">
        {available && (
          <button
            type="button"
            aria-label={recording ? "Stop recording" : "Start recording"}
            aria-pressed={recording}
            disabled={transcribing || streaming}
            onClick={onMicClick}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center border transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-nv",
              "disabled:cursor-not-allowed disabled:opacity-40",
              vadState === "in_speech" || vadState === "speech_detected"
                ? "border-critical bg-critical/10 text-critical"
                : vadState === "listening"
                  ? "border-hairline-strong text-ink-dim"
                  : vadState === "post_speech_silence"
                    ? "border-info text-info"
                    : "border-hairline text-ink-dim hover:border-nv hover:text-nv",
            )}
          >
            {transcribing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Mic size={14} className={cn((vadState === "in_speech" || vadState === "speech_detected") && "nm-pulse")} />
            )}
          </button>
        )}

        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={streaming || recording || transcribing}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className={cn(
            "min-w-0 flex-1 border border-hairline bg-bg px-2.5 py-1.5",
            "font-mono text-[12.5px] text-ink placeholder:text-ink-faint",
            "transition-colors focus:border-hairline-strong focus:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />

        {available && (
          <button
            type="button"
            aria-label={autoSpeak ? "Mute agent replies" : "Speak agent replies"}
            aria-pressed={autoSpeak}
            onClick={() => {
              const next = !autoSpeak;
              setAutoSpeak(next);
              if (!next && speaking) stopSpeaking();
            }}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center border transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-nv",
              autoSpeak
                ? "border-info/60 text-info"
                : "border-hairline text-ink-faint hover:border-hairline-strong hover:text-ink-dim",
              speaking && autoSpeak && "nm-pulse",
            )}
          >
            {autoSpeak ? <Volume2 size={14} /> : <VolumeX size={14} />}
          </button>
        )}

        <Button
          type="submit"
          variant="solid"
          size="md"
          disabled={!canSend}
          aria-label="Send to agent"
        >
          <CornerDownLeft size={13} />
          Send
        </Button>
      </form>

      <div className="flex items-center gap-1.5 px-2.5 pb-1.5">
        <span
          className={cn(
            "h-1 w-1 rounded-full",
            vadState === "in_speech" || vadState === "speech_detected"
              ? "nm-pulse bg-critical"
              : vadState === "listening"
                ? "bg-ink-dim"
                : vadState === "post_speech_silence" || streaming || transcribing || speaking
                  ? "nm-pulse bg-info"
                  : "bg-ink-faint",
          )}
        />
        <span className="nm-eyebrow text-[9px] text-ink-faint">
          {vadState === "listening"
            ? "Waiting for speech · click mic to cancel"
            : vadState === "speech_detected" || vadState === "in_speech"
              ? "Listening · click mic to stop"
              : vadState === "post_speech_silence"
                ? "Finishing…"
                : transcribing
                  ? "Transcribing speech"
                  : streaming
                    ? "Streaming · input locked"
                    : speaking
                      ? "Speaking reply"
                      : available
                        ? "Enter to send · click mic to talk"
                        : "Enter to send"}
        </span>
      </div>
    </div>
  );
}
