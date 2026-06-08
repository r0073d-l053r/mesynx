import { describe, expect, it } from "vitest";
import {
    formatDuration,
    formatDurationMs,
    formatHoursCompact,
    formatTimeLike,
} from "../lib/format-duration";

describe("formatDuration", () => {
    it("collapses non-finite / negative inputs", () => {
        expect(formatDuration(Number.NaN)).toBe("0:00");
        expect(formatDuration(-5)).toBe("0:00");
    });

    it("uses M:SS under an hour", () => {
        expect(formatDuration(0)).toBe("0:00");
        expect(formatDuration(42)).toBe("0:42");
        expect(formatDuration(323)).toBe("5:23");
    });

    it("switches to H:MM:SS at the hour boundary", () => {
        expect(formatDuration(3599)).toBe("59:59");
        expect(formatDuration(3600)).toBe("1:00:00");
        expect(formatDuration(3923)).toBe("1:05:23");
    });
});

describe("formatTimeLike", () => {
    it("falls back to formatDuration when reference is unknown", () => {
        expect(formatTimeLike(42, 0)).toBe("0:42");
        expect(formatTimeLike(42, Number.NaN)).toBe("0:42");
        expect(formatTimeLike(42, -1)).toBe("0:42");
    });

    it("keeps M:SS when reference is under 10 minutes", () => {
        expect(formatTimeLike(0, 323)).toBe("0:00");
        expect(formatTimeLike(42, 323)).toBe("0:42");
        expect(formatTimeLike(323, 323)).toBe("5:23");
    });

    it("zero-pads minutes when reference is >= 10 minutes", () => {
        expect(formatTimeLike(0, 1500)).toBe("00:00");
        expect(formatTimeLike(42, 1500)).toBe("00:42");
        expect(formatTimeLike(323, 1500)).toBe("05:23");
        expect(formatTimeLike(1499, 1500)).toBe("24:59");
    });

    it("pads to H:MM:SS when reference crosses the hour", () => {
        // ref 1:12:38 -> single-digit hours
        const ref = 1 * 3600 + 12 * 60 + 38;
        expect(formatTimeLike(0, ref)).toBe("0:00:00");
        expect(formatTimeLike(10 * 60 + 13, ref)).toBe("0:10:13");
        expect(formatTimeLike(ref, ref)).toBe("1:12:38");
    });

    it("widens hour field for multi-digit hour references", () => {
        const ref = 12 * 3600; // 12:00:00
        expect(formatTimeLike(0, ref)).toBe("00:00:00");
        expect(formatTimeLike(5 * 60 + 23, ref)).toBe("00:05:23");
        expect(formatTimeLike(ref, ref)).toBe("12:00:00");
    });

    it("does not truncate current when it overflows the reference", () => {
        // duration metadata may lag behind currentTime briefly.
        expect(formatTimeLike(3700, 1500)).toBe("1:01:40");
    });

    it("handles non-finite / negative current as zero", () => {
        expect(formatTimeLike(Number.NaN, 1500)).toBe("00:00");
        expect(formatTimeLike(-10, 3 * 3600)).toBe("0:00:00");
    });
});

describe("formatDurationMs", () => {
    it("collapses non-finite / negative inputs", () => {
        expect(formatDurationMs(Number.NaN)).toBe("0:00");
        expect(formatDurationMs(-5000)).toBe("0:00");
    });

    it("converts ms to seconds and formats correctly", () => {
        expect(formatDurationMs(0)).toBe("0:00");
        expect(formatDurationMs(42000)).toBe("0:42");
        expect(formatDurationMs(323000)).toBe("5:23");
        expect(formatDurationMs(3600000)).toBe("1:00:00");
    });
});

describe("formatHoursCompact", () => {
    it("handles non-finite, zero, and negative inputs", () => {
        expect(formatHoursCompact(Number.NaN)).toBe("0 min");
        expect(formatHoursCompact(0)).toBe("0 min");
        expect(formatHoursCompact(-1000)).toBe("0 min");
    });

    it("formats minutes under an hour", () => {
        expect(formatHoursCompact(30 * 60_000)).toBe("30 min");
        expect(formatHoursCompact(59.4 * 60_000)).toBe("59 min");
        expect(formatHoursCompact(59.6 * 60_000)).toBe("60 min");
    });

    it("formats with one decimal place for 1 to 10 hours", () => {
        expect(formatHoursCompact(60 * 60_000)).toBe("1.0 h");
        expect(formatHoursCompact(90 * 60_000)).toBe("1.5 h");
        expect(formatHoursCompact(9.9 * 60 * 60_000)).toBe("9.9 h");
    });

    it("formats with no decimal places for 10 hours and above", () => {
        expect(formatHoursCompact(10 * 60 * 60_000)).toBe("10 h");
        expect(formatHoursCompact(10.4 * 60 * 60_000)).toBe("10 h");
        expect(formatHoursCompact(10.6 * 60 * 60_000)).toBe("11 h");
        expect(formatHoursCompact(100 * 60 * 60_000)).toBe("100 h");
    });
});
