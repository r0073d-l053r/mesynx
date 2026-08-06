"use client";

import { ChevronDown, Maximize2, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    type SummaryNode,
    subtreeSize,
    THEME_CLASSES,
} from "@/lib/transcription/summary-nodes";
import { cn } from "@/lib/utils";

/**
 * Obsidian-style force-directed graph.
 *
 * Recreates the interaction model of Obsidian's graph view: a live physics
 * simulation with tunable centre/repel/link forces, nodes scaled by degree,
 * neighbour highlighting on hover, zoom-gated labels, and drag-to-pin.
 *
 * Rendered to <canvas> rather than DOM: the simulation repaints every frame
 * and Obsidian's look (soft link strokes, radial glow on the active node,
 * cross-fading labels) is far cheaper to draw than to style.
 *
 * Node positions here are ephemeral and intentionally NOT written back to
 * `node.position` — that field belongs to the mind-map layout, which the
 * user arranges by hand and which is persisted. Obsidian likewise does not
 * save graph coordinates.
 */

interface GraphSettings {
    centerForce: number;
    repelForce: number;
    linkForce: number;
    linkDistance: number;
    nodeSize: number;
    linkThickness: number;
    /** Zoom level below which labels fade out entirely. */
    textFadeThreshold: number;
    arrows: boolean;
}

const DEFAULT_SETTINGS: GraphSettings = {
    centerForce: 0.35,
    repelForce: 9,
    linkForce: 0.8,
    linkDistance: 130,
    nodeSize: 5,
    linkThickness: 1,
    // Below the zoom that auto-fit typically lands on, so labels are
    // visible the moment the graph settles rather than only after the
    // user zooms in.
    textFadeThreshold: 0.3,
    arrows: false,
};

/** Changing these disturbs the layout; the display-only ones must not. */
const FORCE_KEYS = new Set<keyof GraphSettings>([
    "centerForce",
    "repelForce",
    "linkForce",
    "linkDistance",
]);

interface Particle {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** Link count — used by the spring normalisation, not by rendering. */
    degree: number;
    /** Subtree size — what the radius encodes, so the root reads largest. */
    weight: number;
    /** Dropped by the user: stays exactly where it was put. */
    pinned: boolean;
}

const MIN_SCALE = 0.15;
const MAX_SCALE = 4;
const ALPHA_DECAY = 0.0165;
const ALPHA_MIN = 0.0015;
const VELOCITY_DECAY = 0.62;
const REHEAT = 0.45;
/** Heat below which the layout is considered readable enough to frame. */
const SETTLED_ALPHA = 0.06;
/** Per-frame velocity ceiling; a divergence guard, not a physical limit. */
const MAX_VELOCITY = 80;
/** Heat held constant while a node is being dragged. */
const DRAG_ALPHA = 0.3;
/** After release, bleed off fast so the graph comes to rest promptly. */
const RELEASE_DECAY = 0.12;

export function ObsidianGraphView({
    nodes,
    selectedId,
    onSelect,
    paused = false,
}: {
    nodes: SummaryNode[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    /** Hidden by the view toggle: keep state, stop burning frames. */
    paused?: boolean;
}) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const [settings, setSettings] = useState<GraphSettings>(DEFAULT_SETTINGS);
    const [panelOpen, setPanelOpen] = useState(false);
    const [hoverId, setHoverId] = useState<string | null>(null);

    const particlesRef = useRef<Map<string, Particle>>(new Map());
    const viewRef = useRef({ x: 0, y: 0, k: 1 });
    const alphaRef = useRef(1);
    const settingsRef = useRef(settings);
    settingsRef.current = settings;
    const hoverRef = useRef<string | null>(null);
    const selectedRef = useRef<string | null>(selectedId);
    selectedRef.current = selectedId;
    const pausedRef = useRef(paused);
    pausedRef.current = paused;
    const dragRef = useRef<{ pointerId: number; id: string } | null>(null);
    // Incremental, not an absolute snapshot: a wheel zoom or arrow-key pan
    // mid-gesture mutates viewRef, and replaying an origin+delta would
    // silently revert it on the next pointermove.
    const panRef = useRef<{
        pointerId: number;
        lastX: number;
        lastY: number;
    } | null>(null);
    const [panning, setPanning] = useState(false);
    const fitRef = useRef<(() => void) | null>(null);
    /** Set whenever anything visible changes, so an idle graph can skip work. */
    const dirtyRef = useRef(true);
    /** Cleared once the user takes control of the viewport. */
    const autoFramingRef = useRef(true);
    /** Layout is stale: solve it to rest on the next frame, then freeze. */
    const needsSolveRef = useRef(true);

    const markDirty = useCallback(() => {
        dirtyRef.current = true;
    }, []);

    const links = useMemo(() => {
        const ids = new Set(nodes.map((n) => n.id));
        return nodes
            .filter((n) => n.parentId && ids.has(n.parentId))
            .map((n) => ({ source: n.parentId as string, target: n.id }));
    }, [nodes]);

    const adjacency = useMemo(() => {
        const map = new Map<string, Set<string>>();
        for (const n of nodes) map.set(n.id, new Set());
        for (const l of links) {
            map.get(l.source)?.add(l.target);
            map.get(l.target)?.add(l.source);
        }
        return map;
    }, [nodes, links]);

    const nodeById = useMemo(
        () => new Map(nodes.map((n) => [n.id, n])),
        [nodes],
    );

    // The loop reads graph data through refs rather than closing over it, so
    // a keystroke in the detail pane cannot tear down the rAF loop, blank
    // the canvas and reheat the simulation.
    const linksRef = useRef(links);
    linksRef.current = links;
    const adjacencyRef = useRef(adjacency);
    adjacencyRef.current = adjacency;
    const nodeByIdRef = useRef(nodeById);
    nodeByIdRef.current = nodeById;

    // Sync particles with the node array, seeding from the mind-map layout
    // so switching views starts from a recognisable shape.
    useEffect(() => {
        const particles = particlesRef.current;
        const live = new Set(nodes.map((n) => n.id));
        let changed = false;
        for (const id of particles.keys()) {
            if (!live.has(id)) {
                particles.delete(id);
                changed = true;
            }
        }
        nodes.forEach((node, index) => {
            const existing = particles.get(node.id);
            const degree = adjacency.get(node.id)?.size ?? 0;
            if (existing) {
                existing.degree = degree;
                existing.weight = subtreeSize(nodes, node.id);
                return;
            }
            changed = true;
            const angle = index * 2.399963;
            particles.set(node.id, {
                id: node.id,
                x: node.position.x * 0.45 + Math.cos(angle) * 12,
                y: node.position.y * 0.45 + Math.sin(angle) * 12,
                vx: 0,
                vy: 0,
                degree,
                weight: subtreeSize(nodes, node.id),
                pinned: false,
            });
        });
        // A shape change needs a fresh layout, but it is solved off-screen
        // (see needsSolveRef in the loop) rather than animated — the graph
        // should never be caught mid-drift when you switch to it. Renaming a
        // node changes no shape and must not disturb anything.
        if (changed) needsSolveRef.current = true;
        dirtyRef.current = true;
    }, [nodes, adjacency]);

    /* ---------------- colours ---------------- */
    const [colors, setColors] = useState({
        text: "#64748b",
        muted: "#94a3b8",
        link: "#94a3b8",
    });

    useEffect(() => {
        const read = () => {
            const wrap = wrapRef.current;
            if (!wrap) return;
            const probe = document.createElement("span");
            probe.style.display = "none";
            wrap.appendChild(probe);
            const resolve = (value: string, fallback: string) => {
                probe.style.color = "";
                probe.style.color = value;
                const computed = getComputedStyle(probe).color;
                return computed || fallback;
            };
            const next = {
                text: resolve("var(--foreground)", "#64748b"),
                muted: resolve("var(--muted-foreground)", "#94a3b8"),
                link: resolve("var(--muted-foreground)", "#94a3b8"),
            };
            wrap.removeChild(probe);
            setColors((prev) =>
                prev.text === next.text && prev.muted === next.muted
                    ? prev
                    : next,
            );
            dirtyRef.current = true;
        };
        read();
        const observer = new MutationObserver(read);
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "style", "data-theme"],
        });
        return () => observer.disconnect();
    }, []);

    const colorsRef = useRef(colors);
    colorsRef.current = colors;

    /* ---------------- simulation + render loop ---------------- */
    useEffect(() => {
        const canvas = canvasRef.current;
        const wrap = wrapRef.current;
        if (!canvas || !wrap) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        let raf = 0;
        let width = 0;
        let height = 0;
        let dpr = 1;

        const reducedMotion = window.matchMedia(
            "(prefers-reduced-motion: reduce)",
        ).matches;

        const resize = () => {
            const rect = wrap.getBoundingClientRect();
            // Re-sampled here (not once at mount) so moving the window to a
            // display with a different pixel ratio does not leave a blurry
            // canvas behind.
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            width = rect.width;
            height = rect.height;
            canvas.width = Math.max(1, Math.floor(width * dpr));
            canvas.height = Math.max(1, Math.floor(height * dpr));
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            dirtyRef.current = true;
        };
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(wrap);
        window.addEventListener("resize", resize);

        // Radius encodes SUBTREE SIZE, not link count. On a tree the root
        // has fewer links than its own branches, so degree-based sizing
        // renders the root smaller than the things hanging off it and
        // inverts the hierarchy the graph exists to show.
        const radiusOf = (p: Particle, s: GraphSettings) =>
            s.nodeSize * (1 + Math.log2(1 + p.weight) * 0.42);

        const fit = () => {
            const particles = [...particlesRef.current.values()];
            if (!particles.length || width === 0 || height === 0) return false;
            const xs = particles.map((p) => p.x);
            const ys = particles.map((p) => p.y);
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            const pad = 90;
            const k = Math.max(
                MIN_SCALE,
                Math.min(
                    1.6,
                    Math.min(
                        (width - pad) / Math.max(1, maxX - minX),
                        (height - pad) / Math.max(1, maxY - minY),
                    ),
                ),
            );
            viewRef.current = {
                k,
                x: width / 2 - ((minX + maxX) / 2) * k,
                y: height / 2 - ((minY + maxY) / 2) * k,
            };
            dirtyRef.current = true;
            return true;
        };
        fitRef.current = () => {
            autoFramingRef.current = true;
            fit();
        };

        const stepPhysics = () => {
            const s = settingsRef.current;
            const particles = [...particlesRef.current.values()];
            if (!particles.length) return;
            const alpha = alphaRef.current;
            const dragging = dragRef.current;

            for (let i = 0; i < particles.length; i++) {
                const a = particles[i];
                for (let j = i + 1; j < particles.length; j++) {
                    const b = particles[j];
                    let dx = b.x - a.x;
                    let dy = b.y - a.y;
                    let d2 = dx * dx + dy * dy;
                    if (d2 < 0.01) {
                        dx = (i % 2 === 0 ? 1 : -1) * 0.5;
                        dy = (j % 2 === 0 ? 1 : -1) * 0.5;
                        d2 = dx * dx + dy * dy;
                    }
                    const d = Math.sqrt(d2);
                    const f = (s.repelForce * 26 * alpha) / d2;
                    const ux = (dx / d) * f;
                    const uy = (dy / d) * f;
                    a.vx -= ux;
                    a.vy -= uy;
                    b.vx += ux;
                    b.vy += uy;
                }
            }

            // Link springs, normalised the way d3-force does it.
            //
            // Applying the full correction to both endpoints makes a node of
            // degree n accumulate n independent springs per frame, so the
            // effective stiffness grows with degree and the integrator
            // diverges — measured at 1.5e40 for a degree-20 hub at link
            // force 2, which a user reaches just by clicking "+" repeatedly.
            // Dividing by the smaller endpoint degree bounds the stiffness,
            // and the bias splits the correction so the heavier node moves
            // less.
            for (const link of linksRef.current) {
                const a = particlesRef.current.get(link.source);
                const b = particlesRef.current.get(link.target);
                if (!a || !b) continue;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
                const degA = Math.max(1, a.degree);
                const degB = Math.max(1, b.degree);
                const strength = s.linkForce / Math.min(degA, degB);
                const bias = degA / (degA + degB);
                const l = ((d - s.linkDistance) / d) * alpha * strength * 0.5;
                b.vx -= dx * l * bias;
                b.vy -= dy * l * bias;
                a.vx += dx * l * (1 - bias);
                a.vy += dy * l * (1 - bias);
            }

            for (const p of particles) {
                p.vx -= p.x * s.centerForce * 0.018 * alpha;
                p.vy -= p.y * s.centerForce * 0.018 * alpha;
            }

            for (const p of particles) {
                // A pinned node stays exactly where it was dropped, and the
                // node under the cursor is driven by the pointer, not physics.
                if (p.pinned || (dragging && dragging.id === p.id)) {
                    p.vx = 0;
                    p.vy = 0;
                    continue;
                }
                p.vx *= VELOCITY_DECAY;
                p.vy *= VELOCITY_DECAY;
                // Belt and braces: even with normalised springs, an extreme
                // slider combination must never be able to fling a node to
                // infinity in a single frame.
                p.vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, p.vx));
                p.vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, p.vy));
                p.x += p.vx;
                p.y += p.vy;
            }

            // While a node is held, keep the heat constant so the rest of
            // the graph keeps flowing around it. Once released, decay fast so
            // motion stops promptly instead of drifting for several seconds.
            alphaRef.current = dragging
                ? alpha
                : alpha + (0 - alpha) * RELEASE_DECAY;
            dirtyRef.current = true;
        };

        /**
         * Reduced motion means "don't animate", not "don't simulate".
         * Solving to convergence inside one frame keeps every force slider
         * functional while the user still never sees motion — disabling
         * stepPhysics outright would silently turn all four force controls
         * into no-ops.
         */
        const solveWithoutAnimating = () => {
            let guard = 0;
            while (alphaRef.current > SETTLED_ALPHA && guard++ < 600) {
                stepPhysics();
            }
            alphaRef.current = 0;
            dirtyRef.current = true;
        };

        const draw = () => {
            const s = settingsRef.current;
            const { x: tx, y: ty, k } = viewRef.current;
            const c = colorsRef.current;
            // Obsidian anchors highlighting on HOVER only. Anchoring on the
            // selection too would dim the whole graph from first paint,
            // because a node is always selected.
            const active = hoverRef.current;
            const neighbours = active ? adjacencyRef.current.get(active) : null;
            const particles = [...particlesRef.current.values()];

            ctx.save();
            ctx.clearRect(0, 0, width, height);
            ctx.translate(tx, ty);
            ctx.scale(k, k);

            const dimmed = (id: string) =>
                active !== null &&
                id !== active &&
                !(neighbours?.has(id) ?? false);

            ctx.lineCap = "round";
            for (const link of linksRef.current) {
                const a = particlesRef.current.get(link.source);
                const b = particlesRef.current.get(link.target);
                if (!a || !b) continue;
                const involved =
                    active === null ||
                    link.source === active ||
                    link.target === active;
                const linkAlpha = involved ? 0.55 : 0.07;
                ctx.globalAlpha = linkAlpha;
                ctx.strokeStyle = c.link;
                ctx.lineWidth = s.linkThickness / k;
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.stroke();

                if (s.arrows) {
                    // Dim with the link rather than vanishing — an arrow that
                    // disappears reads as the link having changed meaning.
                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    const d = Math.hypot(dx, dy) || 1;
                    const rb = radiusOf(b, s);
                    const hx = b.x - (dx / d) * rb;
                    const hy = b.y - (dy / d) * rb;
                    const size = 5 / k;
                    const angle = Math.atan2(dy, dx);
                    ctx.beginPath();
                    ctx.moveTo(hx, hy);
                    ctx.lineTo(
                        hx - size * Math.cos(angle - 0.4),
                        hy - size * Math.sin(angle - 0.4),
                    );
                    ctx.lineTo(
                        hx - size * Math.cos(angle + 0.4),
                        hy - size * Math.sin(angle + 0.4),
                    );
                    ctx.closePath();
                    ctx.fillStyle = c.link;
                    ctx.fill();
                }
            }

            for (const p of particles) {
                const node = nodeByIdRef.current.get(p.id);
                if (!node) continue;
                const r = radiusOf(p, s);
                const isActive = p.id === active;
                const isSelected = p.id === selectedRef.current;
                ctx.globalAlpha = dimmed(p.id) ? 0.18 : 1;
                ctx.fillStyle = THEME_CLASSES[node.colorTheme].stroke;

                if (isActive) {
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, r * 2.1, 0, Math.PI * 2);
                    ctx.globalAlpha = 0.16;
                    ctx.fill();
                    ctx.globalAlpha = 1;
                }

                ctx.beginPath();
                ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
                ctx.fill();

                if (isSelected) {
                    ctx.globalAlpha = dimmed(p.id) ? 0.3 : 1;
                    ctx.strokeStyle = c.text;
                    ctx.lineWidth = 1.5 / k;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, r + 3 / k, 0, Math.PI * 2);
                    ctx.stroke();
                }
            }

            const fade = Math.min(
                1,
                Math.max(0, (k - s.textFadeThreshold) / 0.35),
            );
            // The hovered node and its neighbours are always labelled, at
            // full strength, regardless of the fade threshold — that is what
            // makes zoomed-out exploration usable in Obsidian. Without it,
            // hovering while zoomed out reveals a slightly brighter dot and
            // no text at all.
            const highlighted = (id: string) =>
                active !== null &&
                (id === active || (neighbours?.has(id) ?? false));
            if (fade > 0.01 || active !== null) {
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.font = `${11 / k}px ui-sans-serif, system-ui, sans-serif`;
                for (const p of particles) {
                    const node = nodeByIdRef.current.get(p.id);
                    if (!node) continue;
                    const alpha = highlighted(p.id)
                        ? 1
                        : dimmed(p.id)
                          ? 0.12 * fade
                          : fade;
                    if (alpha < 0.01) continue;
                    ctx.globalAlpha = alpha;
                    ctx.fillStyle = p.id === active ? c.text : c.muted;
                    const label =
                        node.label.length > 28
                            ? `${node.label.slice(0, 27)}…`
                            : node.label;
                    ctx.fillText(label, p.x, p.y + radiusOf(p, s) + 4 / k);
                }
            }

            ctx.globalAlpha = 1;
            ctx.restore();
        };

        const tick = () => {
            raf = requestAnimationFrame(tick);
            if (pausedRef.current) return;

            // A stale layout is solved to rest inside a single frame and
            // then frozen, so the graph is already still the moment it
            // appears. Animating the settle is what made switching to this
            // view look like the whole graph was sliding away.
            if (needsSolveRef.current) {
                needsSolveRef.current = false;
                alphaRef.current = 1;
                solveWithoutAnimating();
                if (autoFramingRef.current) fit();
            }

            const running = alphaRef.current > ALPHA_MIN;
            if (running) {
                if (reducedMotion) solveWithoutAnimating();
                else stepPhysics();
            }

            // An idle, unchanged graph must not repaint at 60fps forever.
            if (!dirtyRef.current) return;
            dirtyRef.current = false;
            draw();
        };

        // First frame: get something on screen immediately.
        fit();
        raf = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(raf);
            observer.disconnect();
            window.removeEventListener("resize", resize);
            fitRef.current = null;
        };
    }, []);

    /* ---------------- pointer interaction ---------------- */
    const toWorld = useCallback((clientX: number, clientY: number) => {
        const wrap = wrapRef.current;
        if (!wrap) return { x: 0, y: 0 };
        const rect = wrap.getBoundingClientRect();
        const { x, y, k } = viewRef.current;
        return {
            x: (clientX - rect.left - x) / k,
            y: (clientY - rect.top - y) / k,
        };
    }, []);

    const hitTest = useCallback(
        (clientX: number, clientY: number) => {
            const world = toWorld(clientX, clientY);
            const s = settingsRef.current;
            const k = viewRef.current.k;
            let best: string | null = null;
            let bestDist = Infinity;
            for (const p of particlesRef.current.values()) {
                const r = s.nodeSize * (1 + Math.log2(1 + p.weight) * 0.42);
                const d = Math.hypot(p.x - world.x, p.y - world.y);
                // Slop is a screen-space allowance, so it must be divided by
                // the zoom — in world units the grab area would shrink to
                // nothing when zoomed out.
                if (d < r + 8 / k && d < bestDist) {
                    bestDist = d;
                    best = p.id;
                }
            }
            return best;
        },
        [toWorld],
    );

    const onPointerDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const hit = hitTest(e.clientX, e.clientY);
            if (hit) {
                dragRef.current = { pointerId: e.pointerId, id: hit };
                onSelect(hit);
                // Held constant while dragging so the rest of the graph keeps
                // flowing around the node under the cursor.
                alphaRef.current = DRAG_ALPHA;
                autoFramingRef.current = false;
            } else {
                panRef.current = {
                    pointerId: e.pointerId,
                    lastX: e.clientX,
                    lastY: e.clientY,
                };
                setPanning(true);
                autoFramingRef.current = false;
            }
            markDirty();
        },
        [hitTest, onSelect, markDirty],
    );

    const onPointerMove = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            const drag = dragRef.current;
            if (drag && drag.pointerId === e.pointerId) {
                const world = toWorld(e.clientX, e.clientY);
                const p = particlesRef.current.get(drag.id);
                if (p) {
                    p.x = world.x;
                    p.y = world.y;
                    p.vx = 0;
                    p.vy = 0;
                }
                alphaRef.current = DRAG_ALPHA;
                markDirty();
                return;
            }
            const pan = panRef.current;
            if (pan && pan.pointerId === e.pointerId) {
                const dx = e.clientX - pan.lastX;
                const dy = e.clientY - pan.lastY;
                pan.lastX = e.clientX;
                pan.lastY = e.clientY;
                viewRef.current = {
                    ...viewRef.current,
                    x: viewRef.current.x + dx,
                    y: viewRef.current.y + dy,
                };
                markDirty();
                return;
            }
            const hit = hitTest(e.clientX, e.clientY);
            if (hit !== hoverRef.current) {
                hoverRef.current = hit;
                setHoverId(hit);
                markDirty();
            }
        },
        [hitTest, toWorld, markDirty],
    );

    const endPointer = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (dragRef.current?.pointerId === e.pointerId) {
                // Dropped nodes stay put. Everything else settles and stops.
                const dropped = particlesRef.current.get(dragRef.current.id);
                if (dropped) dropped.pinned = true;
                dragRef.current = null;
                markDirty();
            }
            if (panRef.current?.pointerId === e.pointerId) {
                panRef.current = null;
                setPanning(false);
            }
        },
        [markDirty],
    );

    const zoomAt = useCallback(
        (px: number, py: number, factor: number) => {
            const { x, y, k } = viewRef.current;
            const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, k * factor));
            viewRef.current = {
                k: next,
                x: px - ((px - x) / k) * next,
                y: py - ((py - y) / k) * next,
            };
            autoFramingRef.current = false;
            markDirty();
        },
        [markDirty],
    );

    // Native, non-passive listener: React attaches wheel handlers passively,
    // so preventDefault() from onWheel is ignored and a trackpad pinch zooms
    // the whole page instead of the graph.
    useEffect(() => {
        const wrap = wrapRef.current;
        if (!wrap) return;
        const onWheel = (e: WheelEvent) => {
            // Let the settings list scroll on its own.
            if ((e.target as HTMLElement)?.closest("[data-graph-chrome]")) {
                return;
            }
            // Horizontal trackpad travel emits deltaY === 0; keying off the
            // sign alone would read every one of those as "zoom out" and
            // walk the graph down to the minimum scale in under a second.
            if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                return;
            }
            e.preventDefault();
            // deltaMode: 0 = pixel, 1 = line, 2 = page.
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
            const amount = Math.max(-160, Math.min(160, e.deltaY * unit));
            const rect = wrap.getBoundingClientRect();
            zoomAt(
                e.clientX - rect.left,
                e.clientY - rect.top,
                Math.exp(-amount / 420),
            );
        };
        wrap.addEventListener("wheel", onWheel, { passive: false });
        return () => wrap.removeEventListener("wheel", onWheel);
    }, [zoomAt]);

    const zoomBy = useCallback(
        (factor: number) => {
            const wrap = wrapRef.current;
            if (!wrap) return;
            const { width, height } = wrap.getBoundingClientRect();
            zoomAt(width / 2, height / 2, factor);
        },
        [zoomAt],
    );

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            // Arrow keys belong to whatever overlay control has focus —
            // preventDefault here would make every slider keyboard-inert.
            if ((e.target as HTMLElement)?.closest("[data-graph-chrome]")) {
                return;
            }
            const step = e.shiftKey ? 120 : 40;
            const pan = (dx: number, dy: number) => {
                viewRef.current = {
                    ...viewRef.current,
                    x: viewRef.current.x + dx,
                    y: viewRef.current.y + dy,
                };
                autoFramingRef.current = false;
                markDirty();
            };
            switch (e.key) {
                case "ArrowLeft":
                    e.preventDefault();
                    pan(step, 0);
                    break;
                case "ArrowRight":
                    e.preventDefault();
                    pan(-step, 0);
                    break;
                case "ArrowUp":
                    e.preventDefault();
                    pan(0, step);
                    break;
                case "ArrowDown":
                    e.preventDefault();
                    pan(0, -step);
                    break;
                case "+":
                case "=":
                    e.preventDefault();
                    zoomBy(1.2);
                    break;
                case "-":
                case "_":
                    e.preventDefault();
                    zoomBy(1 / 1.2);
                    break;
                case "0":
                    e.preventDefault();
                    fitRef.current?.();
                    break;
            }
        },
        [zoomBy, markDirty],
    );

    const update = <K extends keyof GraphSettings>(
        key: K,
        value: GraphSettings[K],
    ) => {
        setSettings((s) => ({ ...s, [key]: value }));
        // Only force changes disturb the layout. Reheating on node size or
        // link thickness would shake the whole graph for a display tweak.
        if (FORCE_KEYS.has(key)) needsSolveRef.current = true;
        dirtyRef.current = true;
    };

    const hoveredNode = hoverId ? nodeById.get(hoverId) : null;

    // Every overlay control lives under this: it stops pointer events from
    // reaching the canvas wrapper, which would otherwise capture the pointer
    // and swallow the click entirely.
    const chromeProps = {
        "data-graph-chrome": true,
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
        onPointerMove: (e: React.PointerEvent) => e.stopPropagation(),
        // Chrome swallows pointermove, so the canvas would never learn the
        // cursor left a node and the highlight would stay latched.
        onPointerEnter: () => {
            if (hoverRef.current !== null) {
                hoverRef.current = null;
                setHoverId(null);
                dirtyRef.current = true;
            }
        },
    } as const;

    return (
        <div
            ref={wrapRef}
            role="application"
            aria-label="Graph view of transcript sections. Arrow keys pan, plus and minus zoom, 0 fits the graph."
            // biome-ignore lint/a11y/noNoninteractiveTabindex: role=application is a widget role, not a non-interactive one, and the element must be focusable for the arrow/zoom key handling below to receive any events.
            tabIndex={0}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            onPointerLeave={(e) => {
                endPointer(e);
                if (hoverRef.current !== null) {
                    hoverRef.current = null;
                    setHoverId(null);
                    markDirty();
                }
            }}
            className={cn(
                "relative h-full w-full overflow-hidden touch-none select-none outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                panning
                    ? "cursor-grabbing"
                    : hoverId
                      ? "cursor-pointer"
                      : "cursor-grab",
            )}
        >
            <canvas ref={canvasRef} className="block" />

            <div
                {...chromeProps}
                className="absolute left-3 top-3 w-56 rounded-xl border border-border/60 bg-card/90 shadow-sm backdrop-blur"
            >
                <button
                    type="button"
                    onClick={() => setPanelOpen((v) => !v)}
                    aria-expanded={panelOpen}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-[11px] font-semibold"
                >
                    Graph settings
                    <ChevronDown
                        className={cn(
                            "size-3.5 text-muted-foreground transition-transform",
                            panelOpen && "rotate-180",
                        )}
                    />
                </button>

                {panelOpen && (
                    <div className="max-h-[60vh] space-y-3 overflow-y-auto border-t border-border/60 px-3 py-3">
                        <SettingsGroup label="Display">
                            <Range
                                label="Node size"
                                value={settings.nodeSize}
                                min={2}
                                max={14}
                                step={0.5}
                                onChange={(v) => update("nodeSize", v)}
                            />
                            <Range
                                label="Link thickness"
                                value={settings.linkThickness}
                                min={0.3}
                                max={4}
                                step={0.1}
                                onChange={(v) => update("linkThickness", v)}
                            />
                            <Range
                                label="Text fade threshold"
                                value={settings.textFadeThreshold}
                                min={0}
                                max={3}
                                step={0.05}
                                onChange={(v) => update("textFadeThreshold", v)}
                            />
                            <label className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                                Arrows
                                <input
                                    type="checkbox"
                                    checked={settings.arrows}
                                    onChange={(e) =>
                                        update("arrows", e.target.checked)
                                    }
                                    className="size-3.5 accent-current"
                                />
                            </label>
                        </SettingsGroup>

                        <SettingsGroup label="Forces">
                            <Range
                                label="Center force"
                                value={settings.centerForce}
                                min={0}
                                max={1}
                                step={0.01}
                                onChange={(v) => update("centerForce", v)}
                            />
                            <Range
                                label="Repel force"
                                value={settings.repelForce}
                                min={0}
                                max={30}
                                step={0.5}
                                onChange={(v) => update("repelForce", v)}
                            />
                            <Range
                                label="Link force"
                                value={settings.linkForce}
                                min={0}
                                max={2}
                                step={0.02}
                                onChange={(v) => update("linkForce", v)}
                            />
                            <Range
                                label="Link distance"
                                value={settings.linkDistance}
                                min={30}
                                max={400}
                                step={5}
                                onChange={(v) => update("linkDistance", v)}
                            />
                        </SettingsGroup>

                        <button
                            type="button"
                            onClick={() => {
                                // Dropping nodes pins them; without this the
                                // layout can only ever get more rigid.
                                for (const p of particlesRef.current.values()) {
                                    p.pinned = false;
                                }
                                needsSolveRef.current = true;
                                dirtyRef.current = true;
                            }}
                            className="w-full rounded-md border border-border/60 py-1 text-[10px] text-muted-foreground hover:text-foreground"
                        >
                            Release pinned & re-solve
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setSettings(DEFAULT_SETTINGS);
                                needsSolveRef.current = true;
                                dirtyRef.current = true;
                            }}
                            className="w-full rounded-md border border-border/60 py-1 text-[10px] text-muted-foreground hover:text-foreground"
                        >
                            Restore defaults
                        </button>
                    </div>
                )}
            </div>

            {hoveredNode && (
                <div className="pointer-events-none absolute bottom-3 right-3 max-w-[60%] truncate rounded-lg border border-border/60 bg-card/90 px-2.5 py-1 text-[11px] shadow-sm backdrop-blur">
                    {hoveredNode.label}
                    <span className="ml-2 text-muted-foreground">
                        {adjacency.get(hoveredNode.id)?.size ?? 0} link
                        {(adjacency.get(hoveredNode.id)?.size ?? 0) === 1
                            ? ""
                            : "s"}
                    </span>
                </div>
            )}

            <div
                {...chromeProps}
                className="absolute bottom-3 left-3 flex items-center gap-1 rounded-lg border border-border/60 bg-card/90 p-1 shadow-sm backdrop-blur"
            >
                <GraphIconButton
                    label="Zoom out"
                    onClick={() => zoomBy(1 / 1.2)}
                >
                    <Minus className="size-3.5" />
                </GraphIconButton>
                <GraphIconButton label="Zoom in" onClick={() => zoomBy(1.2)}>
                    <Plus className="size-3.5" />
                </GraphIconButton>
                <div className="mx-0.5 h-4 w-px bg-border/60" />
                <GraphIconButton
                    label="Fit graph"
                    onClick={() => fitRef.current?.()}
                >
                    <Maximize2 className="size-3.5" />
                </GraphIconButton>
            </div>
        </div>
    );
}

function GraphIconButton({
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
            onClick={onClick}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
            {children}
        </button>
    );
}

function SettingsGroup({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div className="space-y-1.5">
            <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
                {label}
            </p>
            {children}
        </div>
    );
}

function Range({
    label,
    value,
    min,
    max,
    step,
    onChange,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
}) {
    return (
        <label className="block space-y-0.5">
            <span className="flex items-center justify-between text-[10px] text-muted-foreground">
                {label}
                <span className="font-mono tabular-nums">{value}</span>
            </span>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                className="h-1 w-full cursor-pointer appearance-none rounded-full bg-border accent-current"
            />
        </label>
    );
}
