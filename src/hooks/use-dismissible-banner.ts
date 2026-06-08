import { useCallback, useEffect, useState } from "react";

/**
 * A custom hook to handle the state and localStorage interactions for a dismissible banner.
 * Gracefully handles localStorage exceptions (e.g., in privacy/incognito modes).
 *
 * @param storageKey The localStorage key used to store the dismissal state.
 * @returns A tuple containing the boolean `dismissed` state and a `dismiss` function.
 */
export function useDismissibleBanner(
    storageKey: string,
): [boolean, () => void] {
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
        try {
            if (localStorage.getItem(storageKey) === "dismissed") {
                setDismissed(true);
            }
        } catch {
            // localStorage can throw in privacy/incognito modes -- treat
            // as "not dismissed" and render the banner. Functional fallback.
        }
    }, [storageKey]);

    const dismiss = useCallback(() => {
        setDismissed(true);
        try {
            localStorage.setItem(storageKey, "dismissed");
        } catch {
            // Best-effort -- if storage is unavailable the
            // banner simply reappears next visit. Acceptable.
        }
    }, [storageKey]);

    return [dismissed, dismiss];
}
