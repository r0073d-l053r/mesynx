"use client";

import { Pencil, Users } from "lucide-react";
import { useMemo, useState } from "react";
import {
    parseDiarized,
    speakerColor,
} from "@/lib/transcription/parse-diarized";
import { cn } from "@/lib/utils";

interface Props {
    text: string;
    /** Custom display names keyed by raw speaker id, e.g. {"SPEAKER_00": "Alice"}. */
    speakerNames?: Record<string, string> | null;
    /**
     * When provided, speaker badges become clickable and commit renames
     * through this callback. Omit for a read-only transcript.
     */
    onRename?: (speakerId: string, name: string) => void;
    className?: string;
}

/**
 * Renders a diarized (speaker-labelled) transcript as styled speaker blocks.
 *
 * Each speaker gets a consistent colour badge. Consecutive segments from the
 * same speaker are visually grouped. When `onRename` is provided, clicking a
 * speaker badge (in the legend or beside a segment run) opens an inline
 * input to replace the default "Speaker N" label with a real name.
 * Falls back to a plain `<p>` if the text doesn't parse into any speaker
 * segments (should never happen because the parent checks `isDiarized()`
 * first, but safe is better than sorry).
 */
export function DiarizedTranscript({
    text,
    speakerNames,
    onRename,
    className,
}: Props) {
    const segments = useMemo(
        () => parseDiarized(text, speakerNames),
        [text, speakerNames],
    );

    // Build a stable speaker → index map so colours don't shift if the
    // segment array is re-parsed (e.g. after an inline edit).
    const speakerIndex = useMemo(() => {
        const map = new Map<string, number>();
        for (const seg of segments) {
            if (!map.has(seg.speaker)) {
                map.set(seg.speaker, map.size);
            }
        }
        return map;
    }, [segments]);

    // First display label per speaker (custom name or "Speaker N").
    const speakerLabel = useMemo(() => {
        const map = new Map<string, string>();
        for (const seg of segments) {
            if (!map.has(seg.speaker)) {
                map.set(seg.speaker, seg.label);
            }
        }
        return map;
    }, [segments]);

    // The same speaker renders a badge in the legend AND at every run
    // start, so the editing key is the specific badge INSTANCE that was
    // clicked ("legend:SPEAKER_00" / "run:3"). Keying on the speaker alone
    // would mount multiple autoFocus inputs at once — the second one's
    // focus() blurs the first, which commits and closes the editor before
    // the user can type.
    const [editing, setEditing] = useState<{
        instance: string;
        speakerId: string;
    } | null>(null);
    const [draft, setDraft] = useState("");

    const speakerCount = speakerIndex.size;
    const canRename = Boolean(onRename);

    const startEditing = (speakerId: string, instance: string) => {
        if (!canRename) return;
        setDraft(speakerNames?.[speakerId] ?? "");
        setEditing({ instance, speakerId });
    };

    const commitEditing = () => {
        if (editing === null) return;
        const { speakerId } = editing;
        setEditing(null);
        // An unchanged value is a no-op; an empty value clears the custom
        // name (the parent drops the key and "Speaker N" returns).
        const previous = speakerNames?.[speakerId] ?? "";
        if (draft.trim() === previous.trim()) return;
        onRename?.(speakerId, draft.trim());
    };

    const cancelEditing = () => setEditing(null);

    if (segments.length === 0) {
        return (
            <p
                className={cn(
                    "text-sm whitespace-pre-wrap leading-relaxed text-foreground/90",
                    className,
                )}
            >
                {text}
            </p>
        );
    }

    /** Shared badge/input renderer for legend chips and run badges. */
    const renderBadge = (
        speakerId: string,
        badgeClassName: string,
        instance: string,
    ) => {
        const idx = speakerIndex.get(speakerId) ?? 0;
        const color = speakerColor(idx);
        const label = speakerLabel.get(speakerId) ?? speakerId;

        if (editing?.instance === instance) {
            return (
                <input
                    // biome-ignore lint/a11y/noAutofocus: input appears on explicit user click
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitEditing}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") commitEditing();
                        if (e.key === "Escape") cancelEditing();
                    }}
                    maxLength={60}
                    placeholder={`Speaker ${idx + 1}`}
                    aria-label={`Rename ${label}`}
                    className={cn(
                        "rounded border bg-background px-1.5 py-0.5 text-[10px] font-semibold leading-none w-24 outline-none focus:ring-1 focus:ring-ring",
                        color,
                    )}
                />
            );
        }

        if (!canRename) {
            return <span className={cn(badgeClassName, color)}>{label}</span>;
        }

        return (
            <button
                type="button"
                onClick={() => startEditing(speakerId, instance)}
                title="Rename speaker"
                className={cn(
                    badgeClassName,
                    color,
                    "group/badge cursor-pointer transition-shadow hover:ring-1 hover:ring-ring",
                )}
            >
                {label}
                <Pencil className="size-2.5 opacity-0 group-hover/badge:opacity-60 transition-opacity" />
            </button>
        );
    };

    return (
        <div className={cn("space-y-1", className)}>
            {/* Speaker legend */}
            {speakerCount > 1 && (
                <div className="flex flex-wrap items-center gap-2 pb-3 border-b border-border/40">
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground/60 font-mono uppercase tracking-wider">
                        <Users className="size-3" />
                        {speakerCount} speakers
                    </span>
                    {Array.from(speakerIndex.keys()).map((speakerId) =>
                        <span key={speakerId}>
                            {renderBadge(
                                speakerId,
                                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                                `legend:${speakerId}`,
                            )}
                        </span>,
                    )}
                </div>
            )}

            {/* Segments */}
            <div className="space-y-2 pt-1">
                {segments.map((seg, i) => {
                    // Check if this segment starts a new speaker block
                    const prevSpeaker = i > 0 ? segments[i - 1]?.speaker : null;
                    const isNewSpeaker = seg.speaker !== prevSpeaker;

                    return (
                        <div
                            key={`${seg.speaker}-${i}`}
                            className={cn(
                                "flex gap-3",
                                isNewSpeaker && i > 0 && "mt-3",
                            )}
                        >
                            {/* Speaker badge — only shown on the first segment of a run */}
                            <div className="w-20 shrink-0 pt-0.5">
                                {isNewSpeaker &&
                                    renderBadge(
                                        seg.speaker,
                                        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap",
                                        `run:${i}`,
                                    )}
                            </div>

                            {/* Transcript text */}
                            <p className="flex-1 text-sm leading-relaxed text-foreground/90">
                                {seg.text}
                            </p>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
