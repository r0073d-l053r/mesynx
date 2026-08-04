import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { encryptJsonField } from "@/lib/encryption/fields";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    COLOR_THEMES,
    type SummaryNode,
} from "@/lib/transcription/summary-nodes";

type IdContext = { params: Promise<{ id: string }> };

const MAX_NODES = 500;
const MAX_CHUNKS_PER_NODE = 500;
const MAX_LABEL = 300;
const MAX_SUMMARY = 20_000;
const MAX_CHUNK_TEXT = 20_000;
const MAX_TAGS = 24;
const MAX_TAG = 60;
/** Guards against a runaway payload filling a jsonb column. */
const MAX_SERIALISED_BYTES = 2_000_000;

const THEMES = new Set<string>(COLOR_THEMES);

function bad(message: string): never {
    throw new AppError(ErrorCode.INVALID_INPUT, message, 400);
}

function str(value: unknown, max: number, field: string): string {
    if (typeof value !== "string") bad(`${field} must be a string`);
    const s = value as string;
    if (s.length > max) bad(`${field} exceeds ${max} characters`);
    // NUL is rejected by Postgres jsonb regardless of column type.
    // replaceAll with a string literal avoids a control-character escape
    // in a regex. Only NUL is stripped - other control characters are
    // legitimate inside transcript text.
    return s.replaceAll("\u0000", "");
}

function finiteNumber(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        bad(`${field} must be a finite number`);
    }
    return value as number;
}

/**
 * Validate and normalise the client's node array.
 *
 * This is user-authored structure round-tripping through the browser, so
 * nothing is trusted: unknown keys are dropped rather than stored, every
 * field is type- and length-checked, and the parent graph is verified to
 * be acyclic with no dangling references — a cycle would hang the
 * recursive document view and the descendant walk on the next read.
 */
function validateNodes(input: unknown): SummaryNode[] {
    if (!Array.isArray(input)) bad("nodes must be an array");
    if (input.length > MAX_NODES) bad(`at most ${MAX_NODES} nodes`);

    const seen = new Set<string>();
    const nodes: SummaryNode[] = input.map((raw, i) => {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            bad(`nodes[${i}] must be an object`);
        }
        const n = raw as Record<string, unknown>;

        const id = str(n.id, 128, `nodes[${i}].id`);
        if (!id) bad(`nodes[${i}].id is required`);
        if (seen.has(id)) bad(`duplicate node id "${id}"`);
        seen.add(id);

        const parentId =
            n.parentId === null || n.parentId === undefined
                ? null
                : str(n.parentId, 128, `nodes[${i}].parentId`);
        if (parentId === id) bad(`node "${id}" cannot be its own parent`);

        const position =
            typeof n.position === "object" && n.position !== null
                ? (n.position as Record<string, unknown>)
                : bad(`nodes[${i}].position must be an object`);

        const metadata =
            typeof n.metadata === "object" && n.metadata !== null
                ? (n.metadata as Record<string, unknown>)
                : {};

        const theme = typeof n.colorTheme === "string" ? n.colorTheme : "slate";
        if (!THEMES.has(theme))
            bad(`nodes[${i}].colorTheme "${theme}" invalid`);

        const rawTags = Array.isArray(n.tags) ? n.tags : [];
        if (rawTags.length > MAX_TAGS) bad(`nodes[${i}] has too many tags`);

        const rawChunks = Array.isArray(n.detailedTranscript)
            ? n.detailedTranscript
            : [];
        if (rawChunks.length > MAX_CHUNKS_PER_NODE) {
            bad(`nodes[${i}] has too many transcript chunks`);
        }

        return {
            id,
            parentId,
            label: str(n.label ?? "", MAX_LABEL, `nodes[${i}].label`),
            position: {
                x: finiteNumber(position.x, `nodes[${i}].position.x`),
                y: finiteNumber(position.y, `nodes[${i}].position.y`),
            },
            metadata: {
                startTime: str(metadata.startTime ?? "", 40, "startTime"),
                endTime: str(metadata.endTime ?? "", 40, "endTime"),
                duration: str(metadata.duration ?? "", 40, "duration"),
            },
            sectionSummary: str(
                n.sectionSummary ?? "",
                MAX_SUMMARY,
                `nodes[${i}].sectionSummary`,
            ),
            detailedTranscript: rawChunks.map((c, j) => {
                const chunk =
                    typeof c === "object" && c !== null
                        ? (c as Record<string, unknown>)
                        : bad(`nodes[${i}].detailedTranscript[${j}] invalid`);
                return {
                    speaker: str(chunk.speaker ?? "", 120, "speaker"),
                    timestamp: str(chunk.timestamp ?? "", 40, "timestamp"),
                    text: str(chunk.text ?? "", MAX_CHUNK_TEXT, "chunk text"),
                };
            }),
            colorTheme: theme as SummaryNode["colorTheme"],
            tags: rawTags.map((t, j) => str(t, MAX_TAG, `tags[${j}]`)),
        };
    });

    // Every parentId must resolve, and following parents must terminate.
    const ids = new Set(nodes.map((n) => n.id));
    const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
    for (const node of nodes) {
        if (node.parentId && !ids.has(node.parentId)) {
            bad(`node "${node.id}" references missing parent`);
        }
        let cursor = node.parentId;
        let hops = 0;
        while (cursor) {
            if (++hops > nodes.length) {
                bad(`parent cycle detected at node "${node.id}"`);
            }
            cursor = parentOf.get(cursor) ?? null;
        }
    }

    return nodes;
}

/**
 * PATCH /api/recordings/[id]/workspace
 * Persist the editable workspace's node array for this recording.
 * Send `{ nodes: SummaryNode[] }`, or `{ nodes: null }` to clear it and
 * fall back to the derived-on-the-fly layout.
 */
export const PATCH = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const userId = session.user.id;

    const body = await request.json().catch(() => ({}));
    const input = body?.nodes;

    let stored: unknown = null;
    if (input !== null && input !== undefined) {
        const nodes = validateNodes(input);
        const serialised = JSON.stringify(nodes);
        if (serialised.length > MAX_SERIALISED_BYTES) {
            bad("workspace is too large to save");
        }
        stored = nodes.length ? encryptJsonField(nodes) : null;
    }

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
        .set({ workspaceNodes: stored })
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

    return NextResponse.json({ success: true });
});
