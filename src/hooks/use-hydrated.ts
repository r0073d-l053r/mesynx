"use client";

import { useEffect, useState } from "react";

/**
 * False during SSR and the first client render, true afterwards.
 *
 * Use it to gate values that cannot agree between server and client:
 * anything derived from `Date.now()` (relative timestamps drift between
 * the SSR moment and hydration) or from the local timezone (the server
 * runs UTC, so `isToday()` can disagree with the browser either side of
 * midnight). Reading such a value during the first client render is what
 * produces React's "text content does not match" hydration error.
 *
 * Pair it with `suppressHydrationWarning` on the element holding the
 * text: the attribute silences the unavoidable first-paint mismatch, and
 * the extra render this hook triggers replaces the server's value with
 * the browser's correct one. Neither alone is sufficient —
 * `suppressHydrationWarning` on its own leaves the stale server text in
 * place, because React deliberately does not patch what it was told to
 * ignore.
 */
export function useHydrated(): boolean {
    const [hydrated, setHydrated] = useState(false);
    useEffect(() => setHydrated(true), []);
    return hydrated;
}
