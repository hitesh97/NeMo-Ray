"use client";

import { useCallback, useState, type FormEvent, type KeyboardEvent } from "react";
import { CornerDownLeft, Loader2, Mic, Volume2, VolumeX, X, Zap } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/components/primitives";
import { useAutoSpeakLatest, useVoice } from "@/hooks/useVoice";
import { useNemoStore } from "@/store";

// Does the operator's prompt mean "take the referenced mast(s) offline"? Mirrors the agent's
// outage keyword routing — when it matches and masts are referenced, we drop them on the map
// (red beacon, rays gone) as the run is dispatched, so the takedown is visible immediately.
const TAKEDOWN_RE =
  /\b(take\s+(it|them|this|that|these)?\s*(down|offline)|take\s+down|knock\s+(it|them|out)|down|offline|outage|disable|kill|drop|fail)\b/i;
const isTakedownIntent = (text: string) => TAKEDOWN_RE.test(text);

/**
 * Bottom-pinned operator input for the agent console. A full-width text area on its
 * own row (Enter to send, Shift+Enter for a newline) with the mic / auto-speak / send
 * controls on the row below — or dictate with the mic, transcribed straight into the
 * same input pipeline (not a separate card). Auto-speak echoes replies aloud when on.
 */
export function AgentComposer({ className }: { className?: string }) {
  const [value, setValue] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(false);
  const streaming = useNemoStore((s) => s.streaming);
  const addOperatorMessage = useNemoStore((s) => s.addOperatorMessage);
  const requestAgentRun = useNemoStore((s) => s.requestAgentRun);
  // Masts the operator clicked on the map — shown as removable chips and sent with the prompt.
  const referencedSiteIds = useNemoStore((s) => s.referencedSiteIds);
  const toggleReferencedSite = useNemoStore((s) => s.toggleReferencedSite);
  const deactivateSites = useNemoStore((s) => s.deactivateSites);

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
    // If the operator is taking referenced masts down, drop them on the map now (red beacon,
    // rays gone) — captured before sendPrompt, which consumes & clears the references.
    if (referencedSiteIds.length > 0 && isTakedownIntent(text)) {
      deactivateSites(referencedSiteIds);
    }
    sendPrompt(text);
    setValue("");
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline (so multi-line prompts are possible).
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
            : referencedSiteIds.length > 0
              ? "Referenced — try “take it down and replan coverage”…"
              : "Ask the AI agent — type or click the mic…";

  return (
    <div className={cn("shrink-0 border-t border-hairline bg-panel/60", className)}>
      {referencedSiteIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2">
          <span className="nm-eyebrow text-[9px] text-ink-faint">Masts</span>
          {referencedSiteIds.map((id) => (
            <span
              key={id}
              className="flex items-center gap-1 border border-nv/40 bg-nv/10 px-1.5 py-0.5 text-[10px] font-mono text-nv"
            >
              <Zap size={10} />
              {id}
              <button
                type="button"
                aria-label={`Remove ${id}`}
                onClick={() => toggleReferencedSite(id)}
                className="ml-0.5 text-nv/70 transition-colors hover:text-nv"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-2 px-2.5 py-2">
        {/* Row 1 — the prompt text area, full width so the operator sees what they type. */}
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={streaming || recording || transcribing}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          rows={2}
          className={cn(
            "w-full resize-none border border-hairline bg-bg px-2.5 py-1.5",
            "max-h-40 min-h-[3.25rem] overflow-y-auto",
            "font-mono text-[12.5px] leading-relaxed text-ink placeholder:text-ink-faint",
            "transition-colors focus:border-hairline-strong focus:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />

        {/* Row 2 — mic on the left, auto-speak + send on the right. */}
        <div className="flex items-center gap-2">
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
            className="ml-auto"
          >
            <CornerDownLeft size={13} />
            Send
          </Button>
        </div>
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
