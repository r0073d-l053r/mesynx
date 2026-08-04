"use client";

import {
    Check,
    ChevronRight,
    CornerLeftUp,
    FileText,
    RefreshCw,
    Maximize2,
    Minus,
    Network,
    Pencil,
    Plus,
    Share2,
    Trash2,
    X,
} from "lucide-react";
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { ObsidianGraphView } from "@/components/dashboard/obsidian-graph-view";
import {
    branchIds,
    childPosition,
    childrenOf,
    collectSegments,
    COLOR_THEMES,
    type ColorTheme,
    createNode,
    depthOf,
    NODE_HEIGHT,
    NODE_WIDTH,
    pathTo,
    removeBranch,
    rootNodes,
    segmentCount,
    type SummaryNode,
    THEME_CLASSES,
    type TranscriptChunk,
} from "@/lib/transcription/summary-nodes";
import {
    resolveSpeakerLabel,
    resolveSpeakerTokens,
} from "@/lib/transcription/parse-diarized";
import { cn } from "@/lib/utils";

type ViewMode = "map" | "graph" | "document";

/* ------------------------------------------------------------------ */
/* Modal host                                                          */
/* ------------------------------------------------------------------ */

/**
 * Full-screen host for the workspace. The 70/30 split needs real height,
 * so it does not fit inline in the summary panel — this renders through a
 * portal, matching how the existing memory map opens its full view.
 */
export function WorkspaceModal({
    initialNodes,
    speakerNames,
    onRenameSpeaker,
    onNodesChange,
    onClose,
    onRebuild,
}: WorkspaceProps & { onClose: () => void }) {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        const previous = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            window.removeEventListener("keydown", onKey);
            document.body.style.overflow = previous;
        };
    }, [onClose]);

    if (!mounted) return null;

    return createPortal(
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop is a convenience dismissal; Escape and the close button are the accessible paths
        <div
            className="fixed inset-0 z-50 flex flex-col bg-background/80 p-4 backdrop-blur-sm sm:p-8"
            onPointerDown={(e) => {
                // Dismiss only on the backdrop itself, never on a stray
                // pointer-up that started inside the workspace.
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <dialog
                open
                aria-modal="true"
                aria-label="Transcription workspace"
                className="relative flex min-h-0 flex-1 w-full max-w-none bg-transparent p-0 text-inherit"
            >
                {/* Close lives in the workspace header rather than floating
                    outside the panel: an outside-and-above position is
                    clipped by the overlay padding, and body scroll is
                    locked, so a clipped control would be unreachable. */}
                <EditableTranscriptionWorkspace
                    initialNodes={initialNodes}
                    speakerNames={speakerNames}
                    onRenameSpeaker={onRenameSpeaker}
                    onNodesChange={onNodesChange}
                    onClose={onClose}
                    onRebuild={onRebuild}
                    className="flex-1 shadow-2xl"
                />
            </dialog>
        </div>,
        document.body,
    );
}

interface WorkspaceProps {
    initialNodes: SummaryNode[];
    /**
     * The one speaker-name map for this recording. Raw `SPEAKER_NN` ids stay
     * in the stored nodes; names are resolved for display only, so renaming
     * once updates every surface and stays reversible.
     */
    speakerNames?: Record<string, string> | null;
    /** Rename a speaker from here; writes to the same map every view reads. */
    onRenameSpeaker?: (speakerId: string, name: string) => void;
    /**
     * Regenerate from the current summary + transcript, discarding the
     * saved arrangement. Without this a stored workspace shadows every
     * later improvement to how nodes are derived.
     */
    onRebuild?: () => void;
    /** Called on every mutation — the hook point for persistence. */
    onNodesChange?: (nodes: SummaryNode[]) => void;
    /** When set, the header shows a close control (used by the modal host). */
    onClose?: () => void;
    className?: string;
}

/* ------------------------------------------------------------------ */
/* Root                                                                */
/* ------------------------------------------------------------------ */

export function EditableTranscriptionWorkspace({
    initialNodes,
    speakerNames,
    onRenameSpeaker,
    onNodesChange,
    onClose,
    onRebuild,
    className,
}: WorkspaceProps) {
    const [nodes, setNodesState] = useState<SummaryNode[]>(initialNodes);
    const [view, setView] = useState<ViewMode>("map");
    const [selectedId, setSelectedId] = useState<string | null>(
        initialNodes[0]?.id ?? null,
    );

    // Re-seed when the caller supplies a different recording's nodes.
    const seedRef = useRef(initialNodes);
    if (initialNodes !== seedRef.current) {
        seedRef.current = initialNodes;
        setNodesState(initialNodes);
        setSelectedId(initialNodes[0]?.id ?? null);
    }

    const setNodes = useCallback(
        (updater: (prev: SummaryNode[]) => SummaryNode[]) => {
            setNodesState((prev) => {
                const next = updater(prev);
                onNodesChange?.(next);
                return next;
            });
        },
        [onNodesChange],
    );

    const updateNode = useCallback(
        (id: string, patch: Partial<SummaryNode>) => {
            setNodes((prev) =>
                prev.map((n) => (n.id === id ? { ...n, ...patch } : n)),
            );
        },
        [setNodes],
    );

    const addChild = useCallback(
        (parentId: string) => {
            setNodes((prev) => {
                const parent = prev.find((n) => n.id === parentId);
                if (!parent) return prev;
                const child = createNode({
                    label: "New section",
                    parentId,
                    position: childPosition(prev, parent),
                    // Inherit the parent's theme, per spec.
                    colorTheme: parent.colorTheme,
                });
                return [...prev, child];
            });
        },
        [setNodes],
    );

    const deleteBranch = useCallback(
        (id: string) => {
            setNodes((prev) => {
                const next = removeBranch(prev, id);
                setSelectedId((current) =>
                    current && next.some((n) => n.id === current)
                        ? current
                        : (next[0]?.id ?? null),
                );
                return next;
            });
        },
        [setNodes],
    );

    const selected = useMemo(
        () => nodes.find((n) => n.id === selectedId) ?? null,
        [nodes, selectedId],
    );

    return (
        <div
            className={cn(
                "flex flex-col h-full min-h-0 rounded-xl border border-border/60 bg-card overflow-hidden",
                className,
            )}
        >
            <WorkspaceHeader
                view={view}
                onViewChange={setView}
                nodeCount={nodes.length}
                onClose={onClose}
                onRebuild={onRebuild}
            />

            {view === "map" || view === "graph" ? (
                <div className="flex flex-1 min-h-0">
                    {/* Both stay mounted: unmounting the graph would throw
                        away its simulation state and viewport, so every
                        toggle back would re-settle from scratch. The hidden
                        one is paused rather than torn down. */}
                    <div className="relative w-[70%] min-w-0 border-r border-border/60">
                        <div
                            className={cn(
                                "absolute inset-0",
                                view === "map"
                                    ? "visible"
                                    : "invisible pointer-events-none",
                            )}
                        >
                            <MapCanvas
                                nodes={nodes}
                                speakerNames={speakerNames}
                                selectedId={selectedId}
                                onSelect={setSelectedId}
                                onMoveNode={(id, position) =>
                                    updateNode(id, { position })
                                }
                                onAddChild={addChild}
                            />
                        </div>
                        <div
                            className={cn(
                                "absolute inset-0",
                                view === "graph"
                                    ? "visible"
                                    : "invisible pointer-events-none",
                            )}
                        >
                            <ObsidianGraphView
                                nodes={nodes}
                                selectedId={selectedId}
                                onSelect={setSelectedId}
                                paused={view !== "graph"}
                            />
                        </div>
                    </div>
                    <div className="w-[30%] min-w-0 flex flex-col">
                        <DetailPane
                            node={selected}
                            nodes={nodes}
                            speakerNames={speakerNames}
                            onRenameSpeaker={onRenameSpeaker}
                            onChange={updateNode}
                            onDelete={deleteBranch}
                            onSelect={setSelectedId}
                        />
                    </div>
                </div>
            ) : (
                <DocumentView
                    nodes={nodes}
                    speakerNames={speakerNames}
                    onChange={updateNode}
                    onDelete={deleteBranch}
                />
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

function WorkspaceHeader({
    view,
    onViewChange,
    nodeCount,
    onClose,
    onRebuild,
}: {
    view: ViewMode;
    onViewChange: (v: ViewMode) => void;
    nodeCount: number;
    onClose?: () => void;
    onRebuild?: () => void;
}) {
    const [confirmRebuild, setConfirmRebuild] = useState(false);
    return (
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5 shrink-0">
            <div className="flex items-baseline gap-2 min-w-0">
                <h3 className="text-sm font-semibold truncate">
                    Transcription Workspace
                </h3>
                <span className="text-[11px] text-muted-foreground/70 font-mono shrink-0">
                    {nodeCount} section{nodeCount === 1 ? "" : "s"}
                </span>
            </div>

            <div
                className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5 shrink-0"
                role="tablist"
                aria-label="Workspace view"
            >
                {(
                    [
                        { id: "map", label: "Mind Map", icon: Network },
                        { id: "graph", label: "Graph", icon: Share2 },
                        { id: "document", label: "Document", icon: FileText },
                    ] as const
                ).map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={view === id}
                        onClick={() => onViewChange(id)}
                        className={cn(
                            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                            view === id
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground",
                        )}
                    >
                        <Icon className="size-3.5" />
                        {label}
                    </button>
                ))}
            </div>

            {onRebuild &&
                (confirmRebuild ? (
                    <span className="flex shrink-0 items-center gap-1">
                        <button
                            type="button"
                            onClick={() => {
                                setConfirmRebuild(false);
                                onRebuild();
                            }}
                            className="rounded-md bg-destructive px-2 py-1 text-[10px] font-semibold text-white"
                        >
                            Discard edits & rebuild
                        </button>
                        <button
                            type="button"
                            aria-label="Cancel rebuild"
                            onClick={() => setConfirmRebuild(false)}
                            className="rounded-md border border-border/60 p-1 text-muted-foreground hover:text-foreground"
                        >
                            <X className="size-3" />
                        </button>
                    </span>
                ) : (
                    <button
                        type="button"
                        onClick={() => setConfirmRebuild(true)}
                        title="Regenerate the workspace from the current summary and transcript"
                        className="flex shrink-0 items-center gap-1 rounded-lg border border-border/60 px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <RefreshCw className="size-3" />
                        Rebuild
                    </button>
                ))}

            {onClose && (
                <button
                    type="button"
                    aria-label="Close workspace"
                    onClick={onClose}
                    className="shrink-0 rounded-lg border border-border/60 p-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                    <X className="size-4" />
                </button>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Map canvas — pan, zoom, node drag                                   */
/* ------------------------------------------------------------------ */

const MIN_SCALE = 0.35;
const MAX_SCALE = 2;

function MapCanvas({
    nodes,
    speakerNames,
    selectedId,
    onSelect,
    onMoveNode,
    onAddChild,
}: {
    nodes: SummaryNode[];
    speakerNames?: Record<string, string> | null;
    selectedId: string | null;
    onSelect: (id: string) => void;
    onMoveNode: (id: string, position: { x: number; y: number }) => void;
    onAddChild: (parentId: string) => void;
}) {
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });

    // Pan and drag both live in refs: pointer handlers run far more often
    // than React can usefully re-render, and the values are read, not shown.
    const panRef = useRef<{
        pointerId: number;
        startX: number;
        startY: number;
        originX: number;
        originY: number;
    } | null>(null);
    const dragRef = useRef<{
        pointerId: number;
        id: string;
        startX: number;
        startY: number;
        originX: number;
        originY: number;
    } | null>(null);

    // Fit the tree into view: once when the canvas first has a measurable
    // size, and again whenever `fitRequest` is bumped by the Fit button.
    //
    // `fitRequest` is state, not a ref, and IS in the dependency array —
    // an effect cannot be re-triggered by mutating a ref it merely reads,
    // and leaving a ref flag armed makes the fit fire later during an
    // unrelated edit (mid-drag, the canvas would jump out from under the
    // pointer).
    const [fitRequest, setFitRequest] = useState(0);
    const servedFit = useRef(-1);

    useLayoutEffect(() => {
        if (servedFit.current === fitRequest) return;
        if (nodes.length === 0) return;
        const viewport = viewportRef.current;
        if (!viewport) return;
        const { width, height } = viewport.getBoundingClientRect();
        if (width === 0 || height === 0) return;
        servedFit.current = fitRequest;

        const minX = Math.min(...nodes.map((n) => n.position.x));
        const maxX = Math.max(...nodes.map((n) => n.position.x + NODE_WIDTH));
        const minY = Math.min(...nodes.map((n) => n.position.y));
        const maxY = Math.max(...nodes.map((n) => n.position.y + NODE_HEIGHT));

        // Scale down when the tree is wider/taller than the viewport, but
        // never magnify past 1:1 — a two-node map blown up to 200% reads
        // as broken rather than helpful.
        const margin = 48;
        const scale = Math.min(
            1,
            Math.max(
                MIN_SCALE,
                Math.min(
                    (width - margin) / Math.max(1, maxX - minX),
                    (height - margin) / Math.max(1, maxY - minY),
                ),
            ),
        );
        setTransform({
            x: width / 2 - ((minX + maxX) / 2) * scale,
            y: height / 2 - ((minY + maxY) / 2) * scale,
            scale,
        });
    }, [nodes, fitRequest]);

    const zoomBy = useCallback((factor: number) => {
        setTransform((t) => {
            const scale = Math.min(
                MAX_SCALE,
                Math.max(MIN_SCALE, t.scale * factor),
            );
            const viewport = viewportRef.current;
            if (!viewport) return { ...t, scale };
            // Keep the viewport centre fixed while zooming.
            const { width, height } = viewport.getBoundingClientRect();
            const cx = width / 2;
            const cy = height / 2;
            const ratio = scale / t.scale;
            return {
                scale,
                x: cx - (cx - t.x) * ratio,
                y: cy - (cy - t.y) * ratio,
            };
        });
    }, []);

    const fitToView = useCallback(() => setFitRequest((n) => n + 1), []);

    const onBackgroundPointerDown = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            panRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                originX: transform.x,
                originY: transform.y,
            };
        },
        [transform.x, transform.y],
    );

    const onPointerMove = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            const drag = dragRef.current;
            if (drag && drag.pointerId === event.pointerId) {
                // Screen delta -> canvas delta: undo the zoom.
                const dx = (event.clientX - drag.startX) / transform.scale;
                const dy = (event.clientY - drag.startY) / transform.scale;
                onMoveNode(drag.id, {
                    x: drag.originX + dx,
                    y: drag.originY + dy,
                });
                return;
            }
            const pan = panRef.current;
            if (pan && pan.pointerId === event.pointerId) {
                setTransform((t) => ({
                    ...t,
                    x: pan.originX + (event.clientX - pan.startX),
                    y: pan.originY + (event.clientY - pan.startY),
                }));
            }
        },
        [onMoveNode, transform.scale],
    );

    const endPointer = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (panRef.current?.pointerId === event.pointerId) {
                panRef.current = null;
            }
            if (dragRef.current?.pointerId === event.pointerId) {
                dragRef.current = null;
            }
        },
        [],
    );

    const beginNodeDrag = useCallback(
        (event: React.PointerEvent<HTMLDivElement>, node: SummaryNode) => {
            event.stopPropagation();
            if (event.button !== 0) return;
            // Capture on the viewport so the pointer can leave the small card
            // mid-drag without the gesture stalling.
            viewportRef.current?.setPointerCapture(event.pointerId);
            dragRef.current = {
                pointerId: event.pointerId,
                id: node.id,
                startX: event.clientX,
                startY: event.clientY,
                originX: node.position.x,
                originY: node.position.y,
            };
            onSelect(node.id);
        },
        [onSelect],
    );

    const isPanning = panRef.current !== null;

    return (
        <div
            ref={viewportRef}
            onPointerDown={onBackgroundPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            className={cn(
                "relative h-full w-full overflow-hidden touch-none select-none",
                "bg-[radial-gradient(circle,var(--dot)_1px,transparent_1px)] [background-size:22px_22px]",
                isPanning ? "cursor-grabbing" : "cursor-grab",
            )}
            style={
                {
                    "--dot": "color-mix(in srgb, var(--foreground) 14%, transparent)",
                    backgroundPosition: `${transform.x}px ${transform.y}px`,
                } as React.CSSProperties
            }
        >
            <div
                className="absolute left-0 top-0 origin-top-left"
                style={{
                    transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
                }}
            >
                <EdgeLayer nodes={nodes} />
                {nodes.map((node) => (
                    <NodeCard
                        key={node.id}
                        node={node}
                        speakerNames={speakerNames}
                        selected={node.id === selectedId}
                        onPointerDown={(e) => beginNodeDrag(e, node)}
                        onSelect={() => onSelect(node.id)}
                        onAddChild={() => onAddChild(node.id)}
                    />
                ))}
            </div>

            <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-lg border border-border/60 bg-card/90 p-1 shadow-sm backdrop-blur">
                <IconButton label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
                    <Minus className="size-3.5" />
                </IconButton>
                <span className="w-11 text-center text-[11px] font-mono text-muted-foreground tabular-nums">
                    {Math.round(transform.scale * 100)}%
                </span>
                <IconButton label="Zoom in" onClick={() => zoomBy(1.2)}>
                    <Plus className="size-3.5" />
                </IconButton>
                <div className="mx-0.5 h-4 w-px bg-border/60" />
                <IconButton label="Fit to view" onClick={fitToView}>
                    <Maximize2 className="size-3.5" />
                </IconButton>
            </div>
        </div>
    );
}

function IconButton({
    label,
    onClick,
    children,
}: {
    label: string;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClick}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
            {children}
        </button>
    );
}

/* ------------------------------------------------------------------ */
/* SVG edges                                                           */
/* ------------------------------------------------------------------ */

function EdgeLayer({ nodes }: { nodes: SummaryNode[] }) {
    const byId = useMemo(
        () => new Map(nodes.map((n) => [n.id, n])),
        [nodes],
    );

    const paths = useMemo(() => {
        const out: { id: string; d: string; stroke: string }[] = [];
        for (const node of nodes) {
            if (!node.parentId) continue;
            const parent = byId.get(node.parentId);
            if (!parent) continue;
            // Anchor on the vertical centre of each card's right/left edge.
            const x1 = parent.position.x + NODE_WIDTH;
            const y1 = parent.position.y + NODE_HEIGHT / 2;
            const x2 = node.position.x;
            const y2 = node.position.y + NODE_HEIGHT / 2;
            // Horizontal control points give a clean S-curve regardless of
            // vertical offset; the 0.45 factor keeps the bend gentle.
            const dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
            out.push({
                id: node.id,
                d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
                stroke: THEME_CLASSES[node.colorTheme].stroke,
            });
        }
        return out;
    }, [nodes, byId]);

    return (
        <svg
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
            width={1}
            height={1}
        >
            <title>Connections between sections</title>
            {paths.map((p) => (
                <path
                    key={p.id}
                    d={p.d}
                    fill="none"
                    stroke={p.stroke}
                    strokeOpacity={0.45}
                    strokeWidth={2}
                    strokeLinecap="round"
                />
            ))}
        </svg>
    );
}

/* ------------------------------------------------------------------ */
/* Node card                                                           */
/* ------------------------------------------------------------------ */

function NodeCard({
    node,
    speakerNames,
    selected,
    onPointerDown,
    onSelect,
    onAddChild,
}: {
    node: SummaryNode;
    speakerNames?: Record<string, string> | null;
    selected: boolean;
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    onSelect: () => void;
    onAddChild: () => void;
}) {
    const theme = THEME_CLASSES[node.colorTheme];
    return (
        // Focusable and operable by keyboard: selecting a card is the only
        // way to reach the detail pane, so a pointer-only card would make
        // reading, editing and deleting a section keyboard-unreachable.
        <div
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            aria-label={`Section: ${node.label}`}
            onPointerDown={onPointerDown}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect();
                }
            }}
            style={{
                left: node.position.x,
                top: node.position.y,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
            }}
            className={cn(
                "group absolute flex cursor-grab flex-col gap-1 rounded-xl border bg-card p-3 text-left shadow-sm transition-shadow active:cursor-grabbing",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                theme.border,
                selected ? cn("ring-2 shadow-md", theme.ring) : "hover:shadow-md",
            )}
        >
            <div className="flex items-start gap-1.5">
                <span
                    className={cn(
                        "mt-1 size-2 shrink-0 rounded-full",
                        theme.dot,
                    )}
                />
                <p className="line-clamp-2 flex-1 text-xs font-semibold leading-snug">
                    {resolveSpeakerTokens(node.label, speakerNames)}
                </p>
            </div>

            <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                {resolveSpeakerTokens(node.sectionSummary, speakerNames) ||
                    "No summary yet"}
            </p>

            <div className="mt-auto flex items-center gap-1 overflow-hidden">
                {node.tags.slice(0, 3).map((tag) => (
                    <span
                        key={tag}
                        className={cn(
                            "truncate rounded px-1.5 py-0.5 text-[9px] font-medium",
                            theme.bg,
                            theme.text,
                        )}
                    >
                        {resolveSpeakerLabel(tag, speakerNames)}
                    </span>
                ))}
                {node.detailedTranscript.length > 0 && (
                    <span className="ml-auto shrink-0 text-[9px] font-mono text-muted-foreground/60">
                        {node.detailedTranscript.length} chunk
                        {node.detailedTranscript.length === 1 ? "" : "s"}
                    </span>
                )}
            </div>

            {/* Add-child affordance, revealed on hover. */}
            <button
                type="button"
                aria-label={`Add child section under ${node.label}`}
                title="Add child section"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                    e.stopPropagation();
                    onAddChild();
                }}
                className={cn(
                    "absolute -right-3 top-1/2 -translate-y-1/2 rounded-full border bg-card p-1 opacity-0 shadow-sm transition-opacity",
                    "group-hover:opacity-100 focus-visible:opacity-100",
                    theme.border,
                )}
            >
                <Plus className="size-3" />
            </button>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Detail pane                                                         */
/* ------------------------------------------------------------------ */

function DetailPane({
    node,
    nodes,
    speakerNames,
    onRenameSpeaker,
    onChange,
    onDelete,
    onSelect,
}: {
    node: SummaryNode | null;
    nodes: SummaryNode[];
    speakerNames?: Record<string, string> | null;
    onRenameSpeaker?: (speakerId: string, name: string) => void;
    onChange: (id: string, patch: Partial<SummaryNode>) => void;
    onDelete: (id: string) => void;
    onSelect: (id: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const descendantCount = node ? branchIds(nodes, node.id).size - 1 : 0;

    // Leaving edit/confirm state armed while switching nodes would apply the
    // next click to a different section than the user was looking at.
    const lastIdRef = useRef(node?.id ?? null);
    if (node?.id !== lastIdRef.current) {
        lastIdRef.current = node?.id ?? null;
        if (editing) setEditing(false);
        if (confirmDelete) setConfirmDelete(false);
    }

    if (!node) {
        return (
            <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
                Select a section on the map to see its details.
            </div>
        );
    }

    const theme = THEME_CLASSES[node.colorTheme];

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2 shrink-0">
                <span
                    className={cn(
                        "truncate rounded px-1.5 py-0.5 text-[10px] font-medium",
                        theme.bg,
                        theme.text,
                    )}
                >
                    {node.metadata.duration || "Section"}
                </span>
                <button
                    type="button"
                    onClick={() => setEditing((v) => !v)}
                    className="flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                    {editing ? (
                        <>
                            <Check className="size-3" /> Done
                        </>
                    ) : (
                        <>
                            <Pencil className="size-3" /> Edit Content
                        </>
                    )}
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {editing ? (
                    <EditForm node={node} onChange={onChange} />
                ) : (
                    <ReadView
                        node={node}
                        nodes={nodes}
                        speakerNames={speakerNames}
                        onRenameSpeaker={onRenameSpeaker}
                        onSelect={onSelect}
                    />
                )}
            </div>

            <div className="border-t border-border/60 p-3 shrink-0">
                {confirmDelete ? (
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => onDelete(node.id)}
                            className="flex-1 rounded-lg bg-destructive px-2 py-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-90"
                        >
                            {descendantCount > 0
                                ? `Delete this section and ${descendantCount} nested below it`
                                : "Delete this section"}
                        </button>
                        <button
                            type="button"
                            aria-label="Cancel delete"
                            onClick={() => setConfirmDelete(false)}
                            className="rounded-lg border border-border/60 p-1.5 text-muted-foreground hover:text-foreground"
                        >
                            <X className="size-3.5" />
                        </button>
                    </div>
                ) : (
                    <button
                        type="button"
                        onClick={() => setConfirmDelete(true)}
                        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-destructive/30 px-2 py-1.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10"
                    >
                        <Trash2 className="size-3" /> Delete Branch
                    </button>
                )}
            </div>
        </div>
    );
}

function ReadView({
    node,
    nodes,
    speakerNames,
    onRenameSpeaker,
    onSelect,
}: {
    node: SummaryNode;
    nodes: SummaryNode[];
    speakerNames?: Record<string, string> | null;
    onRenameSpeaker?: (speakerId: string, name: string) => void;
    onSelect: (id: string) => void;
}) {
    const theme = THEME_CLASSES[node.colorTheme];
    const trail = pathTo(nodes, node.id);
    const parent = node.parentId
        ? (nodes.find((n) => n.id === node.parentId) ?? null)
        : null;
    const children = childrenOf(nodes, node.id);
    // Evidence for this whole part of the conversation, not just the node
    // itself — a branch's segments live on its leaves.
    const groups = collectSegments(nodes, node.id);
    const total = groups.reduce((n, g) => n + g.chunks.length, 0);

    return (
        <div className="space-y-3">
            {/* Where am I? Each crumb walks back up the tree. */}
            {trail.length > 1 && (
                <nav
                    aria-label="Section path"
                    className="flex flex-wrap items-center gap-0.5 text-[10px] text-muted-foreground/70"
                >
                    {trail.slice(0, -1).map((step) => (
                        <span key={step.id} className="flex items-center gap-0.5">
                            <button
                                type="button"
                                onClick={() => onSelect(step.id)}
                                className="max-w-28 truncate rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
                            >
                                {resolveSpeakerTokens(step.label, speakerNames)}
                            </button>
                            <ChevronRight className="size-2.5 shrink-0 opacity-50" />
                        </span>
                    ))}
                </nav>
            )}

            <h4 className="text-sm font-semibold leading-snug">
                {resolveSpeakerTokens(node.label, speakerNames)}
            </h4>

            {(node.metadata.startTime || node.metadata.endTime) && (
                <p className="font-mono text-[10px] text-muted-foreground/70">
                    {node.metadata.startTime || "—"} →{" "}
                    {node.metadata.endTime || "—"}
                </p>
            )}

            <p className="text-xs leading-relaxed text-foreground/90">
                {resolveSpeakerTokens(node.sectionSummary, speakerNames) || (
                    <span className="text-muted-foreground italic">
                        No summary yet.
                    </span>
                )}
            </p>

            {node.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {node.tags.map((tag) => (
                        <span
                            key={tag}
                            className={cn(
                                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                                theme.bg,
                                theme.text,
                            )}
                        >
                            {resolveSpeakerLabel(tag, speakerNames)}
                        </span>
                    ))}
                </div>
            )}

            {/* Connections: every link this node has, drillable. This is the
                "6 links" the graph reports — the parent plus each child. */}
            {(parent || children.length > 0) && (
                <Disclosure
                    label="Connections"
                    count={(parent ? 1 : 0) + children.length}
                    defaultOpen
                >
                    <div className="space-y-1">
                        {parent && (
                            <ConnectionRow
                                node={parent}
                                nodes={nodes}
                                direction="up"
                                onSelect={onSelect}
                            />
                        )}
                        {children.map((child) => (
                            <ConnectionRow
                                key={child.id}
                                node={child}
                                nodes={nodes}
                                direction="down"
                                onSelect={onSelect}
                            />
                        ))}
                    </div>
                </Disclosure>
            )}

            {/* Transcript evidence, grouped by which section owns it. */}
            <Disclosure label="Transcript" count={total} defaultOpen>
                {groups.length === 0 ? (
                    <p className="text-[11px] italic text-muted-foreground">
                        No transcript segments matched this section.
                    </p>
                ) : (
                    <div className="space-y-3">
                        {groups.map((group) => (
                            <div key={group.node.id} className="space-y-1.5">
                                {group.node.id !== node.id && (
                                    <button
                                        type="button"
                                        onClick={() => onSelect(group.node.id)}
                                        className="flex w-full items-center gap-1 text-left"
                                    >
                                        <span
                                            className={cn(
                                                "size-1.5 shrink-0 rounded-full",
                                                THEME_CLASSES[
                                                    group.node.colorTheme
                                                ].dot,
                                            )}
                                        />
                                        <span className="truncate font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60 hover:text-foreground">
                                            {group.node.label}
                                        </span>
                                    </button>
                                )}
                                {group.chunks.map((chunk, i) => (
                                    <div
                                        key={`${group.node.id}-${i}`}
                                        className="rounded-lg bg-muted/50 p-2"
                                    >
                                        <div className="mb-0.5 flex items-baseline justify-between gap-2">
                                            <SpeakerChip
                                                speaker={chunk.speaker}
                                                speakerNames={speakerNames}
                                                onRename={onRenameSpeaker}
                                            />
                                            {chunk.timestamp && (
                                                <span className="shrink-0 font-mono text-[9px] text-muted-foreground/60">
                                                    {chunk.timestamp}
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-[11px] leading-relaxed text-foreground/85">
                                            {resolveSpeakerTokens(
                                                chunk.text,
                                                speakerNames,
                                            )}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                )}
            </Disclosure>
        </div>
    );
}

/**
 * A speaker label that doubles as a rename control.
 *
 * Renaming here writes to the same per-recording speaker map the Sources
 * transcript and the summary read from, so the new name appears on every
 * surface at once — this pane, the cards, the document view, the graph, and
 * the generated summary prose.
 */
function SpeakerChip({
    speaker,
    speakerNames,
    onRename,
}: {
    speaker: string;
    speakerNames?: Record<string, string> | null;
    onRename?: (speakerId: string, name: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const isRenameable = Boolean(onRename) && /^(?:SPEAKER|speaker)_\d+$/.test(speaker);
    const shown = resolveSpeakerLabel(speaker, speakerNames) || "Unattributed";

    if (editing) {
        return (
            <input
                // biome-ignore lint/a11y/noAutofocus: appears on explicit click
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                    setEditing(false);
                    onRename?.(speaker, draft.trim());
                }}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        setEditing(false);
                        onRename?.(speaker, draft.trim());
                    }
                    if (e.key === "Escape") setEditing(false);
                }}
                maxLength={60}
                placeholder={speaker}
                aria-label={`Rename ${shown}`}
                className="w-28 rounded border border-border/60 bg-background px-1 py-0.5 text-[10px] font-semibold outline-none focus:ring-1 focus:ring-ring"
            />
        );
    }

    if (!isRenameable) {
        return (
            <span className="truncate text-[10px] font-semibold">{shown}</span>
        );
    }

    return (
        <button
            type="button"
            title="Rename this speaker everywhere"
            onClick={() => {
                setDraft(speakerNames?.[speaker] ?? "");
                setEditing(true);
            }}
            className="group/spk flex min-w-0 items-center gap-1 truncate text-[10px] font-semibold hover:text-primary"
        >
            <span className="truncate">{shown}</span>
            <Pencil className="size-2.5 shrink-0 opacity-0 transition-opacity group-hover/spk:opacity-60" />
        </button>
    );
}

/** One clickable link to a related section, with its own evidence count. */
function ConnectionRow({
    node,
    nodes,
    direction,
    onSelect,
}: {
    node: SummaryNode;
    nodes: SummaryNode[];
    direction: "up" | "down";
    onSelect: (id: string) => void;
}) {
    const theme = THEME_CLASSES[node.colorTheme];
    const segments = segmentCount(nodes, node.id);
    const kids = childrenOf(nodes, node.id).length;
    return (
        <button
            type="button"
            onClick={() => onSelect(node.id)}
            className="flex w-full items-start gap-1.5 rounded-lg border border-border/50 p-1.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
        >
            {direction === "up" ? (
                <CornerLeftUp className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" />
            ) : (
                <span
                    className={cn(
                        "mt-1 size-1.5 shrink-0 rounded-full",
                        theme.dot,
                    )}
                />
            )}
            <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium">
                    {node.label}
                </span>
                {node.sectionSummary && (
                    <span className="line-clamp-2 block text-[10px] leading-snug text-muted-foreground">
                        {node.sectionSummary}
                    </span>
                )}
                <span className="mt-0.5 block font-mono text-[9px] text-muted-foreground/60">
                    {direction === "up" ? "parent" : `${kids} sub`}
                    {segments > 0 && ` · ${segments} segments`}
                </span>
            </span>
        </button>
    );
}

/** Collapsible section with a count badge. */
function Disclosure({
    label,
    count,
    defaultOpen = false,
    children,
}: {
    label: string;
    count?: number;
    defaultOpen?: boolean;
    children: React.ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="border-t border-border/50 pt-2.5">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="mb-1.5 flex w-full items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60 hover:text-foreground"
            >
                <ChevronRight
                    className={cn(
                        "size-3 transition-transform",
                        open && "rotate-90",
                    )}
                />
                {label}
                {count !== undefined && (
                    <span className="ml-auto tabular-nums">{count}</span>
                )}
            </button>
            {open && children}
        </div>
    );
}


const FIELD =
    "w-full rounded-lg border border-border/60 bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring";

function EditForm({
    node,
    onChange,
}: {
    node: SummaryNode;
    onChange: (id: string, patch: Partial<SummaryNode>) => void;
}) {
    const patchChunk = (index: number, patch: Partial<TranscriptChunk>) => {
        const next = node.detailedTranscript.map((chunk, i) =>
            i === index ? { ...chunk, ...patch } : chunk,
        );
        onChange(node.id, { detailedTranscript: next });
    };

    return (
        <div className="space-y-3">
            <Field label="Title">
                <input
                    className={FIELD}
                    value={node.label}
                    onChange={(e) =>
                        onChange(node.id, { label: e.target.value })
                    }
                />
            </Field>

            <Field label="Summary">
                <textarea
                    className={cn(FIELD, "min-h-20 resize-y leading-relaxed")}
                    value={node.sectionSummary}
                    onChange={(e) =>
                        onChange(node.id, { sectionSummary: e.target.value })
                    }
                />
            </Field>

            <div className="grid grid-cols-2 gap-2">
                <Field label="Start">
                    <input
                        className={cn(FIELD, "font-mono")}
                        placeholder="00:00:00"
                        value={node.metadata.startTime}
                        onChange={(e) =>
                            onChange(node.id, {
                                metadata: {
                                    ...node.metadata,
                                    startTime: e.target.value,
                                },
                            })
                        }
                    />
                </Field>
                <Field label="End">
                    <input
                        className={cn(FIELD, "font-mono")}
                        placeholder="00:00:00"
                        value={node.metadata.endTime}
                        onChange={(e) =>
                            onChange(node.id, {
                                metadata: {
                                    ...node.metadata,
                                    endTime: e.target.value,
                                },
                            })
                        }
                    />
                </Field>
            </div>

            <Field label="Tags (comma separated)">
                <TagsInput
                    key={node.id}
                    tags={node.tags}
                    onCommit={(tags) => onChange(node.id, { tags })}
                />
            </Field>

            <Field label="Colour">
                <div className="flex flex-wrap gap-1.5">
                    {COLOR_THEMES.map((theme) => (
                        <button
                            key={theme}
                            type="button"
                            aria-label={theme}
                            title={theme}
                            onClick={() =>
                                onChange(node.id, {
                                    colorTheme: theme as ColorTheme,
                                })
                            }
                            className={cn(
                                "size-6 rounded-full border-2 transition-transform hover:scale-110",
                                THEME_CLASSES[theme].dot,
                                node.colorTheme === theme
                                    ? "border-foreground"
                                    : "border-transparent",
                            )}
                        />
                    ))}
                </div>
            </Field>

            <div className="space-y-2 border-t border-border/50 pt-3">
                <div className="flex items-center justify-between">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
                        Transcript chunks
                    </p>
                    <button
                        type="button"
                        onClick={() =>
                            onChange(node.id, {
                                detailedTranscript: [
                                    ...node.detailedTranscript,
                                    { speaker: "", timestamp: "", text: "" },
                                ],
                            })
                        }
                        className="flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                    >
                        <Plus className="size-3" /> Add
                    </button>
                </div>

                {node.detailedTranscript.map((chunk, index) => (
                    <div
                        // Index-keyed on purpose: chunks have no stable id and
                        // are edited in place, so a content-derived key would
                        // remount the input on every keystroke.
                        key={`chunk-${index}`}
                        className="space-y-1.5 rounded-lg border border-border/50 p-2"
                    >
                        <div className="flex gap-1.5">
                            <input
                                className={cn(FIELD, "flex-1")}
                                placeholder="Speaker"
                                value={chunk.speaker}
                                onChange={(e) =>
                                    patchChunk(index, {
                                        speaker: e.target.value,
                                    })
                                }
                            />
                            <input
                                className={cn(FIELD, "w-24 font-mono")}
                                placeholder="00:00"
                                value={chunk.timestamp}
                                onChange={(e) =>
                                    patchChunk(index, {
                                        timestamp: e.target.value,
                                    })
                                }
                            />
                            <button
                                type="button"
                                aria-label="Remove chunk"
                                onClick={() =>
                                    onChange(node.id, {
                                        detailedTranscript:
                                            node.detailedTranscript.filter(
                                                (_, i) => i !== index,
                                            ),
                                    })
                                }
                                className="rounded-md border border-border/60 px-1.5 text-muted-foreground hover:text-destructive"
                            >
                                <Trash2 className="size-3" />
                            </button>
                        </div>
                        <textarea
                            className={cn(FIELD, "min-h-14 resize-y")}
                            placeholder="What was said…"
                            value={chunk.text}
                            onChange={(e) =>
                                patchChunk(index, { text: e.target.value })
                            }
                        />
                    </div>
                ))}
            </div>
        </div>
    );
}

/**
 * Comma-separated tag editor.
 *
 * Keeps the raw text in local draft state and only parses it into the
 * tags array on blur/Enter. Normalising on every keystroke instead would
 * delete the separator the moment it is typed — `"a,".split(",")` yields a
 * trailing empty segment, filtering it drops it, and the controlled value
 * regenerates without the comma, so a second tag can never be started.
 *
 * Keyed by node id at the call site so the draft resets between sections.
 */
function TagsInput({
    tags,
    onCommit,
}: {
    tags: string[];
    onCommit: (tags: string[]) => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);

    const commit = (raw: string) => {
        const parsed = raw
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
        // Deduplicate: two identical tags render as identical React keys.
        onCommit([...new Set(parsed)]);
        setDraft(null);
    };

    return (
        <input
            className={FIELD}
            placeholder="meeting, product"
            value={draft ?? tags.join(", ")}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    commit(e.currentTarget.value);
                } else if (e.key === "Escape") {
                    setDraft(null);
                }
            }}
        />
    );
}

function Field({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <label className="block space-y-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
                {label}
            </span>
            {children}
        </label>
    );
}

/* ------------------------------------------------------------------ */
/* Document view                                                       */
/* ------------------------------------------------------------------ */

function DocumentView({
    nodes,
    speakerNames,
    onChange,
    onDelete,
}: {
    nodes: SummaryNode[];
    speakerNames?: Record<string, string> | null;
    onChange: (id: string, patch: Partial<SummaryNode>) => void;
    onDelete: (id: string) => void;
}) {
    const roots = useMemo(() => rootNodes(nodes), [nodes]);

    return (
        <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-6 py-8">
                {roots.length === 0 ? (
                    <p className="text-center text-xs text-muted-foreground">
                        Nothing to show — every section has been deleted.
                    </p>
                ) : (
                    roots.map((root) => (
                        <DocumentSection
                            key={root.id}
                            node={root}
                            nodes={nodes}
                            speakerNames={speakerNames}
                            onChange={onChange}
                            onDelete={onDelete}
                        />
                    ))
                )}
            </div>
        </div>
    );
}

function DocumentSection({
    node,
    nodes,
    speakerNames,
    onChange,
    onDelete,
}: {
    node: SummaryNode;
    nodes: SummaryNode[];
    speakerNames?: Record<string, string> | null;
    onChange: (id: string, patch: Partial<SummaryNode>) => void;
    onDelete: (id: string) => void;
}) {
    const [confirmDelete, setConfirmDelete] = useState(false);
    const children = useMemo(
        () => childrenOf(nodes, node.id),
        [nodes, node.id],
    );
    // Every descendant, not just direct children — the delete is recursive,
    // so counting one level would understate an irreversible action.
    const descendantCount = useMemo(
        () => branchIds(nodes, node.id).size - 1,
        [nodes, node.id],
    );
    const depth = depthOf(nodes, node.id);
    const theme = THEME_CLASSES[node.colorTheme];

    return (
        <section
            className={cn(
                "group/section relative py-3",
                depth > 0 && "ml-8 border-l border-border/50 pl-5",
            )}
        >
            {depth > 0 && (
                <span
                    className={cn(
                        "absolute -left-[5px] top-6 size-2.5 rounded-full ring-2 ring-card",
                        theme.dot,
                    )}
                />
            )}

            <div className="flex items-start gap-2">
                <input
                    value={node.label}
                    onChange={(e) =>
                        onChange(node.id, { label: e.target.value })
                    }
                    aria-label="Section title"
                    className={cn(
                        "min-w-0 flex-1 border-0 bg-transparent p-0 font-semibold outline-none focus:ring-0",
                        depth === 0
                            ? "text-xl"
                            : depth === 1
                              ? "text-base"
                              : "text-sm",
                    )}
                />

                {confirmDelete ? (
                    <span className="flex shrink-0 items-center gap-1">
                        <button
                            type="button"
                            onClick={() => onDelete(node.id)}
                            className="rounded-md bg-destructive px-2 py-0.5 text-[10px] font-semibold text-white"
                        >
                            {descendantCount > 0
                                ? `Delete + ${descendantCount} nested`
                                : "Delete section"}
                        </button>
                        <button
                            type="button"
                            aria-label="Cancel delete"
                            onClick={() => setConfirmDelete(false)}
                            className="rounded-md border border-border/60 p-1 text-muted-foreground hover:text-foreground"
                        >
                            <X className="size-3" />
                        </button>
                    </span>
                ) : (
                    <button
                        type="button"
                        aria-label={`Delete ${node.label}`}
                        onClick={() => setConfirmDelete(true)}
                        className="shrink-0 rounded-md p-1 text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive group-hover/section:opacity-100 focus-visible:opacity-100"
                    >
                        <Trash2 className="size-3.5" />
                    </button>
                )}
            </div>

            {node.tags.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                    {node.tags.map((tag) => (
                        <span
                            key={tag}
                            className={cn(
                                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                                theme.bg,
                                theme.text,
                            )}
                        >
                            {tag}
                        </span>
                    ))}
                </div>
            )}

            <AutoTextarea
                value={node.sectionSummary}
                placeholder="Add a summary for this section…"
                onChange={(value) =>
                    onChange(node.id, { sectionSummary: value })
                }
            />

            {children.map((child) => (
                <DocumentSection
                    key={child.id}
                    node={child}
                    nodes={nodes}
                    speakerNames={speakerNames}
                    onChange={onChange}
                    onDelete={onDelete}
                />
            ))}
        </section>
    );
}

/** Borderless textarea that grows to fit its content. */
function AutoTextarea({
    value,
    placeholder,
    onChange,
}: {
    value: string;
    placeholder?: string;
    onChange: (value: string) => void;
}) {
    const ref = useRef<HTMLTextAreaElement | null>(null);

    // useLayoutEffect, not useEffect: measuring after paint makes every
    // textarea render at rows={1} and snap to full height a frame later —
    // a visible reflow flash each time Document view mounts. Depending on
    // `value` also keeps the height right when the text changes from
    // outside this component (e.g. edits made in the map's detail pane).
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    }, [value]);

    return (
        <textarea
            ref={ref}
            value={value}
            placeholder={placeholder}
            aria-label="Section summary"
            rows={1}
            onChange={(e) => {
                e.target.style.height = "auto";
                e.target.style.height = `${e.target.scrollHeight}px`;
                onChange(e.target.value);
            }}
            className="mt-1.5 w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-sm leading-relaxed text-foreground/85 outline-none placeholder:text-muted-foreground/50 focus:ring-0"
        />
    );
}
