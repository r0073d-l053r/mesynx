import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { encryptJsonField } from "@/lib/encryption/fields";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";

type IdContext = { params: Promise<{ id: string }> };

/** Raw diarized speaker ids we accept as rename keys, e.g. "SPEAKER_00". */
const SPEAKER_ID = /^(?:SPEAKER|speaker)_\d{1,6}$/;
const MAX_SPEAKERS = 64;
const MAX_NAME_LENGTH = 60;

/**
 * Collapse whitespace runs (incl. newlines) and strip control characters.
 * NUL (\u0000) in particular is rejected by Postgres jsonb; newlines
 * would let a name span multiple lines when substituted into LLM prompts.
 */
function sanitizeName(name: string): string {
    return name
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * PATCH /api/recordings/[id]/speakers
 * Persist custom display names for diarized speakers, keyed by the raw
 * speaker id present in the transcript text:
 *   { speakerNames: { "SPEAKER_00": "Alice", "SPEAKER_01": "Bob" } }
 * The whole map is replaced on every call (the client always sends the
 * full current map). Empty/whitespace names delete the override — send
 * the map without that key instead. Names identify who spoke in a private
 * recording, so they are content by the encryption-at-rest standard and
 * are stored as an encryptJsonField envelope (same as key_points).
 */
export const PATCH = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const userId = session.user.id;

    const body = await request.json().catch(() => ({}));
    // `JSON.parse("null")` succeeds, so body itself may be null.
    const input = body?.speakerNames;
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "speakerNames must be an object mapping speaker ids to names",
            400,
        );
    }

    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length > MAX_SPEAKERS) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `At most ${MAX_SPEAKERS} speakers can be named`,
            400,
        );
    }

    const speakerNames: Record<string, string> = {};
    for (const [speakerId, name] of entries) {
        if (!SPEAKER_ID.test(speakerId)) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                `"${speakerId}" is not a valid speaker id`,
                400,
            );
        }
        if (typeof name !== "string") {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                `Name for ${speakerId} must be a string`,
                400,
            );
        }
        const trimmed = sanitizeName(name);
        // Skip empty names — omitting a key clears its override.
        if (!trimmed) continue;
        if (trimmed.length > MAX_NAME_LENGTH) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                `Name for ${speakerId} is too long (max ${MAX_NAME_LENGTH})`,
                400,
            );
        }
        speakerNames[speakerId] = trimmed;
    }

    // Verify recording ownership (same pattern as the transcription route).
    const [recording] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);

    if (!recording) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }

    const result = await db
        .update(transcriptions)
        .set({
            speakerNames: Object.keys(speakerNames).length
                ? encryptJsonField(speakerNames)
                : null,
        })
        .where(
            and(
                eq(transcriptions.recordingId, id),
                eq(transcriptions.userId, userId),
            ),
        )
        .returning({ id: transcriptions.id });

    if (result.length === 0) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "No transcription found for this recording",
            404,
        );
    }

    return NextResponse.json({ success: true, speakerNames });
});
