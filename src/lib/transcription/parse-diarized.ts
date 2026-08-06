/**
 * Utilities for handling diarized (speaker-labelled) transcription output.
 *
 * WhisperX stores diarized output in the format:
 *   SPEAKER_00: First sentence spoken.\nSPEAKER_01: Second sentence.\n...
 *
 * Lines that don't start with a SPEAKER_XX: prefix are treated as
 * continuation lines belonging to the most-recent speaker.
 */

export interface DiarizedSegment {
    speaker: string;
    /**
     * Display label: the user's custom name when one exists in the
     * supplied names map, otherwise derived from first-appearance order,
     * e.g. "Speaker 1".
     */
    label: string;
    text: string;
}

/**
 * Regex that matches the diarized speaker-label prefix at line start.
 * WhisperX emits uppercase `SPEAKER_00:`; some OpenAI-compatible diarize
 * backends emit lowercase `speaker_1:` (the repo's own test fixtures use
 * that form), so both are accepted.
 */
const SPEAKER_PREFIX = /^((?:SPEAKER|speaker)_\d+):\s*/;

/**
 * Returns true when the text was produced by a diarized transcription run.
 *
 * Scans the first few non-empty lines rather than only the first: a
 * diarizer can fail to attribute its opening segments (crosstalk, filler),
 * which yields unprefixed continuation lines at the top of an otherwise
 * fully diarized transcript. Bounded scan keeps this cheap enough to call
 * on every render.
 */
const DIARIZED_SCAN_LINES = 12;

export function isDiarized(text: string): boolean {
    let scanned = 0;
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (SPEAKER_PREFIX.test(trimmed)) return true;
        if (++scanned >= DIARIZED_SCAN_LINES) break;
    }
    return false;
}

/**
 * Parse a diarized transcript string into an ordered array of speaker
 * segments, merging consecutive lines from the same speaker.
 *
 * `speakerNames` optionally maps raw speaker ids (e.g. "SPEAKER_00") to
 * user-chosen display names; unmapped speakers fall back to "Speaker N"
 * by first appearance.
 */
export function parseDiarized(
    text: string,
    speakerNames?: Record<string, string> | null,
): DiarizedSegment[] {
    const lines = text.split("\n");
    const raw: { speaker: string; text: string }[] = [];
    let currentSpeaker: string | null = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const match = SPEAKER_PREFIX.exec(trimmed);
        if (match) {
            currentSpeaker = match[1];
            const segText = trimmed.slice(match[0].length).trim();
            if (segText) {
                raw.push({ speaker: currentSpeaker, text: segText });
            }
        } else if (currentSpeaker) {
            // Continuation line — append to the last segment from this speaker.
            const last = raw[raw.length - 1];
            if (last && last.speaker === currentSpeaker) {
                last.text = `${last.text} ${trimmed}`;
            } else {
                raw.push({ speaker: currentSpeaker, text: trimmed });
            }
        }
    }

    // Merge adjacent segments from the same speaker (WhisperX can emit
    // multiple short segments in a row for the same speaker ID).
    const merged: { speaker: string; text: string }[] = [];
    for (const seg of raw) {
        const prev = merged[merged.length - 1];
        if (prev && prev.speaker === seg.speaker) {
            prev.text = `${prev.text} ${seg.text}`;
        } else {
            merged.push({ ...seg });
        }
    }

    // Build stable speaker-number → friendly label mapping.
    const speakerOrder: string[] = [];
    for (const seg of merged) {
        if (!speakerOrder.includes(seg.speaker)) {
            speakerOrder.push(seg.speaker);
        }
    }

    return merged.map((seg) => ({
        speaker: seg.speaker,
        label:
            speakerNames?.[seg.speaker]?.trim() ||
            `Speaker ${speakerOrder.indexOf(seg.speaker) + 1}`,
        text: seg.text,
    }));
}

/**
 * Substitute custom speaker names into a raw diarized transcript, turning
 * `SPEAKER_00: hi` into `Alice: hi`. Used server-side so summaries (and any
 * other LLM consumer of the raw text) see the user's names. Lines whose
 * speaker has no custom name keep their original id prefix. Returns the
 * text unchanged when the map is empty.
 */
/** Any `SPEAKER_07` / `speaker_7` token, wherever it appears in a string. */
const SPEAKER_TOKEN = /\b(SPEAKER|speaker)_(\d{1,6})\b/g;

/**
 * Replace every raw diarization id in a string with the user's chosen name.
 *
 * This is the ONE place speaker names become visible, and it runs at DISPLAY
 * time — never baked into stored text. That is what makes a rename
 * retroactive: the transcript, the summary prose, key points, action items,
 * node labels and tags all keep the raw `SPEAKER_NN` ids on disk, so
 * renaming the speaker once updates every surface at once, and renaming
 * again still works. Baking a name in at write time would freeze it forever.
 *
 * Matches are case-insensitive on the prefix and tolerant of zero padding,
 * so `SPEAKER_01`, `speaker_1` and `SPEAKER_001` all resolve to the same
 * person. Unknown ids are left exactly as they were.
 */
export function resolveSpeakerTokens(
    text: string,
    speakerNames?: Record<string, string> | null,
): string {
    if (!text || !speakerNames || Object.keys(speakerNames).length === 0) {
        return text;
    }
    // Index by numeric value so "SPEAKER_1" finds a map keyed "SPEAKER_01".
    const byNumber = new Map<number, string>();
    for (const [id, name] of Object.entries(speakerNames)) {
        const match = /^(?:SPEAKER|speaker)_(\d{1,6})$/.exec(id);
        const trimmed = name?.trim();
        if (match && trimmed) byNumber.set(Number(match[1]), trimmed);
    }
    if (byNumber.size === 0) return text;
    return text.replace(SPEAKER_TOKEN, (whole, _prefix, digits) => {
        return byNumber.get(Number(digits)) ?? whole;
    });
}

/** Resolve a speaker id on its own (a chunk's `speaker` field, a tag). */
export function resolveSpeakerLabel(
    speaker: string,
    speakerNames?: Record<string, string> | null,
): string {
    return resolveSpeakerTokens(speaker, speakerNames);
}

export function applySpeakerNames(
    text: string,
    speakerNames?: Record<string, string> | null,
): string {
    if (!speakerNames || Object.keys(speakerNames).length === 0) return text;
    return text
        .split("\n")
        .map((line) => {
            // Match on the dedented line but rebuild from the original so
            // leading whitespace survives. String concatenation (not a
            // .replace() pattern) keeps "$&"-style sequences in names inert.
            const dedented = line.trimStart();
            const match = SPEAKER_PREFIX.exec(dedented);
            if (!match) return line;
            const name = speakerNames[match[1]]?.trim();
            if (!name) return line;
            const indent = line.slice(0, line.length - dedented.length);
            return `${indent}${name}: ${dedented.slice(match[0].length)}`;
        })
        .join("\n");
}

/** Palette of muted colours for speaker blocks. Cycles when > 8 speakers. */
export const SPEAKER_COLORS = [
    "bg-blue-500/10 border-blue-500/20 text-blue-700 dark:text-blue-400",
    "bg-violet-500/10 border-violet-500/20 text-violet-700 dark:text-violet-400",
    "bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-400",
    "bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-400",
    "bg-rose-500/10 border-rose-500/20 text-rose-700 dark:text-rose-400",
    "bg-cyan-500/10 border-cyan-500/20 text-cyan-700 dark:text-cyan-400",
    "bg-fuchsia-500/10 border-fuchsia-500/20 text-fuchsia-700 dark:text-fuchsia-400",
    "bg-orange-500/10 border-orange-500/20 text-orange-700 dark:text-orange-400",
] as const;

export function speakerColor(speakerIndex: number): string {
    return (
        SPEAKER_COLORS[speakerIndex % SPEAKER_COLORS.length] ??
        SPEAKER_COLORS[0]
    );
}
