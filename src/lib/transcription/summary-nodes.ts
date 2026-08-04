/**
 * Data model for the editable transcription workspace.
 *
 * The workspace runs on a single source of truth: a FLAT array of
 * `SummaryNode` linked by `parentId`. Both the mind-map view and the
 * document view read and mutate this same array, which is what keeps
 * them in two-way sync — there is no second tree structure to reconcile.
 */

export interface TranscriptChunk {
    speaker: string;
    timestamp: string;
    text: string;
}

export interface SummaryNode {
    id: string;
    label: string;
    /** null for root nodes. */
    parentId: string | null;
    /** Canvas coordinates, in un-scaled map units. */
    position: { x: number; y: number };
    metadata: { startTime: string; endTime: string; duration: string };
    /** The high-level summary shown on the card and in the document view. */
    sectionSummary: string;
    /** The raw text segments behind this section. */
    detailedTranscript: TranscriptChunk[];
    colorTheme: ColorTheme;
    tags: string[];
}

export type ColorTheme =
    | "slate"
    | "blue"
    | "emerald"
    | "purple"
    | "rose"
    | "amber";

export const COLOR_THEMES: ColorTheme[] = [
    "slate",
    "blue",
    "emerald",
    "purple",
    "rose",
    "amber",
];

/**
 * Static Tailwind class sets per theme. Written out in full because
 * Tailwind's compiler only keeps classes it can see as literals — building
 * these by interpolation (`bg-${theme}-500`) would purge them all.
 */
export const THEME_CLASSES: Record<
    ColorTheme,
    {
        border: string;
        ring: string;
        bg: string;
        text: string;
        dot: string;
        stroke: string;
    }
> = {
    slate: {
        border: "border-slate-400/40",
        ring: "ring-slate-400/50",
        bg: "bg-slate-500/10",
        text: "text-slate-700 dark:text-slate-300",
        dot: "bg-slate-500",
        stroke: "#64748b",
    },
    blue: {
        border: "border-blue-400/40",
        ring: "ring-blue-400/50",
        bg: "bg-blue-500/10",
        text: "text-blue-700 dark:text-blue-300",
        dot: "bg-blue-500",
        stroke: "#3b82f6",
    },
    emerald: {
        border: "border-emerald-400/40",
        ring: "ring-emerald-400/50",
        bg: "bg-emerald-500/10",
        text: "text-emerald-700 dark:text-emerald-300",
        dot: "bg-emerald-500",
        stroke: "#10b981",
    },
    purple: {
        border: "border-purple-400/40",
        ring: "ring-purple-400/50",
        bg: "bg-purple-500/10",
        text: "text-purple-700 dark:text-purple-300",
        dot: "bg-purple-500",
        stroke: "#a855f7",
    },
    rose: {
        border: "border-rose-400/40",
        ring: "ring-rose-400/50",
        bg: "bg-rose-500/10",
        text: "text-rose-700 dark:text-rose-300",
        dot: "bg-rose-500",
        stroke: "#f43f5e",
    },
    amber: {
        border: "border-amber-400/40",
        ring: "ring-amber-400/50",
        bg: "bg-amber-500/10",
        text: "text-amber-700 dark:text-amber-300",
        dot: "bg-amber-500",
        stroke: "#f59e0b",
    },
};

/** Card geometry. Fixed so SVG edge anchors are exact without measuring. */
export const NODE_WIDTH = 264;
export const NODE_HEIGHT = 116;
export const CHILD_X_GAP = 340;
export const CHILD_Y_GAP = 148;

let idCounter = 0;
/**
 * Node id generator. Uses a counter rather than Math.random/Date.now so
 * ids stay stable and collision-free within a session, and so server and
 * client renders of the same seed data agree (no hydration mismatch).
 */
export function nodeId(prefix = "n"): string {
    idCounter += 1;
    return `${prefix}-${idCounter}`;
}

export function createNode(partial: Partial<SummaryNode> = {}): SummaryNode {
    return {
        id: partial.id ?? nodeId(),
        label: partial.label ?? "New section",
        parentId: partial.parentId ?? null,
        position: partial.position ?? { x: 0, y: 0 },
        metadata: partial.metadata ?? {
            startTime: "",
            endTime: "",
            duration: "",
        },
        sectionSummary: partial.sectionSummary ?? "",
        detailedTranscript: partial.detailedTranscript ?? [],
        colorTheme: partial.colorTheme ?? "slate",
        tags: partial.tags ?? [],
    };
}

export function childrenOf(nodes: SummaryNode[], id: string): SummaryNode[] {
    return nodes.filter((n) => n.parentId === id);
}

export function rootNodes(nodes: SummaryNode[]): SummaryNode[] {
    // A node whose parent is missing is treated as a root so an inconsistent
    // array can never hide nodes entirely.
    const ids = new Set(nodes.map((n) => n.id));
    return nodes.filter((n) => n.parentId === null || !ids.has(n.parentId));
}

/** Ids of `id` plus every descendant, breadth-first. Cycle-safe. */
export function branchIds(nodes: SummaryNode[], id: string): Set<string> {
    const out = new Set<string>([id]);
    const queue = [id];
    while (queue.length) {
        const current = queue.shift() as string;
        for (const child of nodes) {
            if (child.parentId === current && !out.has(child.id)) {
                out.add(child.id);
                queue.push(child.id);
            }
        }
    }
    return out;
}

/** Delete a node and all of its descendants — never leaves orphans. */
export function removeBranch(
    nodes: SummaryNode[],
    id: string,
): SummaryNode[] {
    const doomed = branchIds(nodes, id);
    return nodes.filter((n) => !doomed.has(n.id));
}

/**
 * How much of the tree hangs off this node, counting itself.
 *
 * This is the honest "importance" metric for a hierarchy. Link degree is
 * not: on a tree the root often has FEWER links than its own branches (a
 * root with 3 sections has degree 3, while a section with 6 items has
 * degree 7), so sizing by degree renders the root smaller than the things
 * beneath it and inverts the hierarchy it is supposed to show.
 */
export function subtreeSize(nodes: SummaryNode[], id: string): number {
    return branchIds(nodes, id).size;
}

/**
 * Ancestors from the root down to `id`, inclusive — the breadcrumb trail.
 * Cycle-safe.
 */
export function pathTo(nodes: SummaryNode[], id: string): SummaryNode[] {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const trail: SummaryNode[] = [];
    const seen = new Set<string>();
    let current = byId.get(id);
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        trail.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return trail;
}

/**
 * Transcript evidence for a section, grouped by the node that owns it.
 *
 * A branch's own `detailedTranscript` is usually empty — the segments live
 * on its leaves. Walking the subtree is what lets the detail pane answer
 * "what was actually said in this part of the conversation?" at every level
 * of the tree instead of only at the bottom.
 */
export function collectSegments(
    nodes: SummaryNode[],
    id: string,
): { node: SummaryNode; chunks: TranscriptChunk[] }[] {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const out: { node: SummaryNode; chunks: TranscriptChunk[] }[] = [];
    // Breadth-first so the node's own segments come before its children's,
    // and siblings stay in tree order.
    const queue = [id];
    const seen = new Set<string>([id]);
    while (queue.length) {
        const currentId = queue.shift() as string;
        const node = byId.get(currentId);
        if (!node) continue;
        if (node.detailedTranscript.length > 0) {
            out.push({ node, chunks: node.detailedTranscript });
        }
        for (const child of nodes) {
            if (child.parentId === currentId && !seen.has(child.id)) {
                seen.add(child.id);
                queue.push(child.id);
            }
        }
    }
    return out;
}

/** Total transcript segments at or beneath a node. */
export function segmentCount(nodes: SummaryNode[], id: string): number {
    return collectSegments(nodes, id).reduce(
        (n, group) => n + group.chunks.length,
        0,
    );
}

/** Depth from the nearest root, for document-view indentation. Cycle-safe. */
export function depthOf(nodes: SummaryNode[], id: string): number {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    let depth = 0;
    let current = byId.get(id);
    const seen = new Set<string>([id]);
    while (current?.parentId) {
        const parent = byId.get(current.parentId);
        if (!parent || seen.has(parent.id)) break;
        seen.add(parent.id);
        depth += 1;
        current = parent;
    }
    return depth;
}

/**
 * Place a new child to the right of its parent, stacked below any siblings
 * so a fresh node never lands underneath an existing card.
 */
export function childPosition(
    nodes: SummaryNode[],
    parent: SummaryNode,
): { x: number; y: number } {
    const siblings = childrenOf(nodes, parent.id);
    return {
        x: parent.position.x + CHILD_X_GAP,
        y: parent.position.y + siblings.length * CHILD_Y_GAP,
    };
}

/** Strip a leading bullet/number so derived labels read cleanly. */
function clean(text: string): string {
    return text
        .replace(/^[-•*]\s*/, "")
        .replace(/^\d+[.)]\s*/, "")
        .trim();
}

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    const cut = text.lastIndexOf(" ", max - 1);
    return `${(cut > max * 0.4 ? text.slice(0, cut) : text.slice(0, max - 1)).trimEnd()}…`;
}

const SPEAKER_LINE = /^((?:SPEAKER|speaker)_\d+|[^:\n]{1,60}):\s*(.+)$/;

/**
 * Parse a stored transcript into chunks. Diarized transcripts are stored as
 * `SPEAKER_00: text` lines (or `Alice: text` once speakers are renamed).
 *
 * Timestamps come back empty: `parseTranscriptionResponse` flattens the
 * diarizer's segments to text and drops each segment's start/end, so the
 * timing is not recoverable from what is persisted today. Populating them
 * requires persisting segment timings at transcription time.
 */
export function parseTranscriptChunks(text: string): TranscriptChunk[] {
    const chunks: TranscriptChunk[] = [];
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        const match = SPEAKER_LINE.exec(line);
        if (match) {
            chunks.push({
                speaker: match[1],
                timestamp: "",
                text: match[2].trim(),
            });
        } else if (chunks.length) {
            // Continuation line — belongs to the previous speaker.
            const last = chunks[chunks.length - 1];
            last.text = `${last.text} ${line}`;
        } else {
            chunks.push({ speaker: "", timestamp: "", text: line });
        }
    }
    return chunks;
}

/**
 * Words too common to carry topic signal. Deliberately short: an aggressive
 * stopword list would strip the domain vocabulary that makes matching work.
 */
const STOPWORDS = new Set([
    "the", "and", "but", "for", "you", "your", "that", "this", "with", "have",
    "has", "was", "were", "are", "not", "all", "any", "can", "will", "would",
    "should", "could", "just", "like", "get", "got", "one", "two", "our",
    "out", "who", "how", "why", "what", "when", "where", "they", "them",
    "their", "there", "then", "than", "some", "more", "most", "into", "from",
    "about", "know", "think", "really", "going", "gonna", "yeah", "okay",
    "right", "well", "actually", "basically", "kind", "sort", "mean", "say",
    "said", "thing", "things", "lot", "want", "need", "make", "made", "take",
]);

function tokenize(text: string): string[] {
    return (text.toLowerCase().match(/[a-z][a-z0-9']{2,}/g) ?? []).filter(
        (w) => !STOPWORDS.has(w),
    );
}

/**
 * Overlap between a section's vocabulary and one transcript chunk,
 * normalised by chunk length so a rambling chunk cannot outscore a precise
 * one purely by being longer.
 */
function relevance(sectionTokens: Set<string>, chunkTokens: string[]): number {
    if (sectionTokens.size === 0 || chunkTokens.length === 0) return 0;
    let hits = 0;
    for (const token of chunkTokens) {
        if (sectionTokens.has(token)) hits += 1;
    }
    return hits / Math.sqrt(chunkTokens.length);
}

/** Below this, a chunk is considered unrelated and stays on the root. */
const RELEVANCE_FLOOR = 0.6;

/** Distinct speakers in a chunk list, in first-appearance order. */
function speakersOf(chunks: TranscriptChunk[]): string[] {
    const seen: string[] = [];
    for (const c of chunks) {
        const s = c.speaker.trim();
        if (s && !seen.includes(s)) seen.push(s);
    }
    return seen;
}

/** "12 segments · 340 words · Alice, Bob" — the at-a-glance line on a card. */
function describeChunks(chunks: TranscriptChunk[]): string {
    if (chunks.length === 0) return "";
    const words = chunks.reduce((n, c) => n + c.text.split(/\s+/).length, 0);
    const speakers = speakersOf(chunks);
    const parts = [
        `${chunks.length} segment${chunks.length === 1 ? "" : "s"}`,
        `${words} word${words === 1 ? "" : "s"}`,
    ];
    if (speakers.length) parts.push(speakers.slice(0, 3).join(", "));
    return parts.join(" · ");
}

export interface DeriveInput {
    title: string;
    summary: string;
    keyPoints?: string[] | null;
    actionItems?: string[] | null;
    /** Raw stored transcript, diarized or plain. */
    transcriptText?: string | null;
}

/**
 * Build a starting hierarchy from a real recording: a root for the
 * recording, then a section per available summary facet. Transcript chunks
 * are attached to the root so the detail pane has real content to show;
 * per-section attribution needs segment timings we do not persist yet.
 */
export function deriveNodes(input: DeriveInput): SummaryNode[] {
    const nodes: SummaryNode[] = [];
    const chunks = input.transcriptText
        ? parseTranscriptChunks(input.transcriptText)
        : [];

    const root = createNode({
        label: truncate(input.title || "Recording", 48),
        parentId: null,
        position: { x: 0, y: 0 },
        sectionSummary: input.summary ?? "",
        // Filled below with whatever no section claims, rather than a blind
        // copy of the first 40 chunks.
        detailedTranscript: [],
        colorTheme: "blue",
        tags: ["recording"],
    });
    nodes.push(root);

    const sections: {
        label: string;
        theme: ColorTheme;
        items: string[];
        tag: string;
    }[] = [];

    if (input.summary?.trim()) {
        const sentences = (input.summary.match(/[^.!?]+[.!?]+/g) ?? [
            input.summary,
        ])
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 4);
        sections.push({
            label: "Overview",
            theme: "slate",
            items: sentences,
            tag: "overview",
        });
    }
    if (input.keyPoints?.length) {
        sections.push({
            label: "Key Points",
            theme: "emerald",
            items: input.keyPoints.map(clean).filter(Boolean),
            tag: "key-point",
        });
    }
    if (input.actionItems?.length) {
        sections.push({
            label: "Action Items",
            theme: "amber",
            items: input.actionItems.map(clean).filter(Boolean),
            tag: "action",
        });
    }

    const MAX_ITEMS_PER_SECTION = 6;

    // Lay sections out against a running cursor sized by how many leaves
    // each one owns. A fixed per-section offset would place leaf columns
    // from adjacent sections on identical coordinates — and because cards
    // are opaque and equally sized, the earlier one vanishes completely
    // behind the later one.
    const laneHeights = sections.map((section) =>
        Math.max(
            1,
            Math.min(section.items.length, MAX_ITEMS_PER_SECTION),
        ),
    );
    const totalRows = laneHeights.reduce((sum, rows) => sum + rows, 0);
    let cursor = (-(totalRows - 1) / 2) * CHILD_Y_GAP;

    const leaves: {
        node: SummaryNode;
        branchId: string;
        tokens: Set<string>;
    }[] = [];

    sections.forEach((section, sectionIndex) => {
        const rows = laneHeights[sectionIndex];
        const items = section.items.slice(0, MAX_ITEMS_PER_SECTION);
        // Centre the branch card against its own block of leaves.
        const branchY = cursor + ((rows - 1) / 2) * CHILD_Y_GAP;

        const branch = createNode({
            label: section.label,
            parentId: root.id,
            position: { x: CHILD_X_GAP, y: branchY },
            sectionSummary: `${section.items.length} item${section.items.length === 1 ? "" : "s"}`,
            colorTheme: section.theme,
            tags: [section.tag],
        });
        nodes.push(branch);

        items.forEach((item, itemIndex) => {
            const leaf = createNode({
                label: truncate(item, 46),
                parentId: branch.id,
                position: {
                    x: CHILD_X_GAP * 2,
                    y: cursor + itemIndex * CHILD_Y_GAP,
                },
                sectionSummary: item,
                colorTheme: section.theme,
                tags: [],
            });
            nodes.push(leaf);
            leaves.push({
                node: leaf,
                branchId: branch.id,
                // Match against the item's own words plus its section
                // heading, so "Action Items" context still counts.
                tokens: new Set(tokenize(`${section.label} ${item}`)),
            });
        });

        cursor += rows * CHILD_Y_GAP;
    });

    // ---- route transcript segments to the section they belong to --------
    //
    // The diarizer's per-segment start/end times are discarded when the
    // transcript is flattened to "SPEAKER_00: text" lines, so there is no
    // time range to slice on. Lexical overlap is the best signal actually
    // available; it is approximate by nature, and anything that matches
    // nothing stays on the root rather than being forced somewhere wrong.
    // Two passes.
    //
    // Pass 1 finds high-confidence lexical ANCHORS. Pass 2 hands every
    // remaining segment to the nearest anchor's section, because a
    // conversation is sequential: a filler line sitting between two anchors
    // belongs to whatever was being discussed around it.
    //
    // The fill pass is what makes this usable. Measured on a real 27-minute
    // workshop transcript, pure lexical matching claims only ~34% of
    // segments even with the threshold at zero — most lines are "yeah,
    // exactly" and share no vocabulary with any summary point — which left
    // every section looking empty. Anchor-and-fill reaches 100% coverage in
    // 25 contiguous runs, so each section reads as a stretch of the
    // conversation rather than scattered fragments.
    const anchors: { index: number; leaf: (typeof leaves)[number] }[] = [];
    chunks.forEach((chunk, index) => {
        const chunkTokens = tokenize(chunk.text);
        let best: (typeof leaves)[number] | null = null;
        let bestScore = 0;
        for (const leaf of leaves) {
            const score = relevance(leaf.tokens, chunkTokens);
            if (score > bestScore) {
                bestScore = score;
                best = leaf;
            }
        }
        if (best && bestScore >= RELEVANCE_FLOOR) {
            anchors.push({ index, leaf: best });
        }
    });

    const unclaimed: TranscriptChunk[] = [];
    if (anchors.length === 0) {
        // Nothing matched at all: better to show everything on the root than
        // to invent an attribution.
        unclaimed.push(...chunks);
    } else {
        chunks.forEach((chunk, index) => {
            let nearest = anchors[0];
            let nearestDistance = Number.POSITIVE_INFINITY;
            for (const anchor of anchors) {
                const distance = Math.abs(anchor.index - index);
                if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearest = anchor;
                }
            }
            nearest.leaf.node.detailedTranscript.push(chunk);
        });
    }

    // Leaves: tag with who spoke, and stamp the time range when timings
    // exist (mock data has them; real diarized text currently does not).
    for (const leaf of leaves) {
        const own = leaf.node.detailedTranscript;
        if (own.length === 0) continue;
        leaf.node.tags = speakersOf(own).slice(0, 2);
        const stamps = own.map((c) => c.timestamp).filter(Boolean);
        if (stamps.length) {
            leaf.node.metadata = {
                ...leaf.node.metadata,
                startTime: stamps[0],
                endTime: stamps[stamps.length - 1],
            };
        }
    }

    // Branches: summarise the evidence hanging beneath them.
    for (const node of nodes) {
        const owned = leaves.filter((l) => l.branchId === node.id);
        if (owned.length === 0) continue;
        const beneath = owned.flatMap((l) => l.node.detailedTranscript);
        const detail = describeChunks(beneath);
        if (detail) node.sectionSummary = `${node.sectionSummary} · ${detail}`;
    }

    root.detailedTranscript = unclaimed;
    if (unclaimed.length) {
        const detail = describeChunks(unclaimed);
        root.sectionSummary = root.sectionSummary
            ? `${root.sectionSummary}\n\nUnsectioned: ${detail}`
            : `Unsectioned: ${detail}`;
    }

    return nodes;
}

/**
 * Demo hierarchy used when a recording has no summary yet, and for
 * exercising the workspace's layout, colours and nesting during
 * development. Deliberately three levels deep with uneven branches.
 */
export function mockNodes(): SummaryNode[] {
    const root = createNode({
        label: "Team Sync — Product Review",
        position: { x: 0, y: 0 },
        metadata: {
            startTime: "00:00:00",
            endTime: "00:52:00",
            duration: "52m",
        },
        sectionSummary:
            "A four-person review covering the auth rewrite, a mobile Safari regression, and Q3 planning. Two decisions were made and three follow-ups assigned.",
        colorTheme: "blue",
        tags: ["meeting", "product"],
        detailedTranscript: [
            {
                speaker: "Alice",
                timestamp: "00:00:12",
                text: "Let's start with the auth rewrite — where are we?",
            },
            {
                speaker: "Bob",
                timestamp: "00:00:20",
                text: "Backend is done. The OAuth callback still fails on mobile Safari though.",
            },
        ],
    });

    const auth = createNode({
        label: "Auth Rewrite",
        parentId: root.id,
        position: { x: CHILD_X_GAP, y: -CHILD_Y_GAP },
        metadata: {
            startTime: "00:00:12",
            endTime: "00:18:40",
            duration: "18m",
        },
        sectionSummary:
            "Backend work is complete and shipping Friday. Remaining risk is the mobile Safari callback failure.",
        colorTheme: "emerald",
        tags: ["engineering", "shipping"],
        detailedTranscript: [
            {
                speaker: "Bob",
                timestamp: "00:02:05",
                text: "I can patch the callback today, but I need the staging keys rotated first.",
            },
            {
                speaker: "Alice",
                timestamp: "00:02:19",
                text: "I'll rotate them this afternoon.",
            },
        ],
    });

    const safari = createNode({
        label: "Mobile Safari regression",
        parentId: auth.id,
        position: { x: CHILD_X_GAP * 2, y: -CHILD_Y_GAP * 1.5 },
        metadata: {
            startTime: "00:03:00",
            endTime: "00:09:10",
            duration: "6m",
        },
        sectionSummary:
            "Callback returns to a blank page on iOS 17. Suspected third-party cookie handling.",
        colorTheme: "rose",
        tags: ["bug", "ios"],
        detailedTranscript: [
            {
                speaker: "Bob",
                timestamp: "00:04:41",
                text: "It only reproduces in private browsing, which points at cookie partitioning.",
            },
        ],
    });

    const keys = createNode({
        label: "Staging key rotation",
        parentId: auth.id,
        position: { x: CHILD_X_GAP * 2, y: -CHILD_Y_GAP * 0.4 },
        metadata: {
            startTime: "00:09:10",
            endTime: "00:12:30",
            duration: "3m",
        },
        sectionSummary: "Alice owns rotation; blocks Bob's patch.",
        colorTheme: "amber",
        tags: ["action", "blocker"],
        detailedTranscript: [
            {
                speaker: "Alice",
                timestamp: "00:10:02",
                text: "Rotating them is quick, it's the redeploy that takes a day.",
            },
        ],
    });

    const roadmap = createNode({
        label: "Q3 Roadmap",
        parentId: root.id,
        position: { x: CHILD_X_GAP, y: CHILD_Y_GAP },
        metadata: {
            startTime: "00:18:40",
            endTime: "00:41:05",
            duration: "22m",
        },
        sectionSummary:
            "Billing migration moves ahead of the reporting revamp. On-call handoff still unassigned.",
        colorTheme: "purple",
        tags: ["planning"],
        detailedTranscript: [
            {
                speaker: "Dana",
                timestamp: "00:22:14",
                text: "Billing has a hard deadline from finance, so it has to come first.",
            },
        ],
    });

    const billing = createNode({
        label: "Billing migration",
        parentId: roadmap.id,
        position: { x: CHILD_X_GAP * 2, y: CHILD_Y_GAP * 0.6 },
        metadata: {
            startTime: "00:22:00",
            endTime: "00:33:00",
            duration: "11m",
        },
        sectionSummary: "Two-week estimate; needs a data backfill plan.",
        colorTheme: "purple",
        tags: ["migration"],
        detailedTranscript: [],
    });

    const oncall = createNode({
        label: "On-call handoff",
        parentId: roadmap.id,
        position: { x: CHILD_X_GAP * 2, y: CHILD_Y_GAP * 1.8 },
        metadata: {
            startTime: "00:33:00",
            endTime: "00:41:05",
            duration: "8m",
        },
        sectionSummary: "Unresolved — no owner named before the call ended.",
        colorTheme: "slate",
        tags: ["open-question"],
        detailedTranscript: [
            {
                speaker: "Dana",
                timestamp: "00:38:50",
                text: "We should decide this before next week, otherwise it defaults to me again.",
            },
        ],
    });

    return [root, auth, safari, keys, roadmap, billing, oncall];
}
