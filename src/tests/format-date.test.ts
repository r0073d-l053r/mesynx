import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDateTime, dateGroupLabel } from "../lib/format-date";

describe("formatDateTime", () => {
    beforeEach(() => {
        // Set a fixed date for deterministic testing of relative time
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("formats Date object with default (relative) format", () => {
        const date = new Date("2024-01-15T11:00:00Z");
        expect(formatDateTime(date)).toBe("about 1 hour ago");
    });

    it("formats string with relative format", () => {
        expect(formatDateTime("2024-01-15T11:00:00Z", "relative")).toBe("about 1 hour ago");
    });

    it("formats Date object with absolute format", () => {
        const date = new Date("2024-01-15T12:30:00Z");
        // Using local format string from format: "MMM d, yyyy h:mm a"
        // In UTC this would be "Jan 15, 2024 12:30 PM", but it relies on local timezone.
        // Let's test with a regex or exact match depending on local timezone setup,
        // or we can test relative to local time.
        // We will mock timezone to UTC by setting process.env.TZ = 'UTC' if needed,
        // or just accept local time output and test for structure.
        // For simplicity, we'll test the structure
        expect(formatDateTime(date, "absolute")).toMatch(/Jan 15, 2024 \d{1,2}:\d{2} [AP]M/);
    });

    it("formats string with absolute format", () => {
        expect(formatDateTime("2024-01-15T12:30:00Z", "absolute")).toMatch(/Jan 15, 2024 \d{1,2}:\d{2} [AP]M/);
    });

    it("formats Date object with iso format", () => {
        const date = new Date("2024-01-15T12:30:00.000Z");
        expect(formatDateTime(date, "iso")).toBe("2024-01-15T12:30:00.000Z");
    });

    it("formats string with iso format", () => {
        expect(formatDateTime("2024-01-15T12:30:00.000Z", "iso")).toBe("2024-01-15T12:30:00.000Z");
    });

    it("falls back to relative for unknown format type", () => {
        const date = new Date("2024-01-15T11:00:00Z");
        // @ts-expect-error Testing invalid format type
        expect(formatDateTime(date, "unknown")).toBe("about 1 hour ago");
    });
});

describe("dateGroupLabel", () => {
    beforeEach(() => {
        // Fix the current date to an arbitrary date for predictable calculations.
        // Let's use May 20th, 2024 at 12:00:00 UTC
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2024-05-20T12:00:00Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns 'Today' for today's date", () => {
        const today = new Date("2024-05-20T10:00:00Z");
        expect(dateGroupLabel(today)).toBe("Today");
        expect(dateGroupLabel("2024-05-20T15:00:00Z")).toBe("Today");
    });

    it("returns 'Yesterday' for yesterday's date", () => {
        const yesterday = new Date("2024-05-19T10:00:00Z");
        expect(dateGroupLabel(yesterday)).toBe("Yesterday");
        expect(dateGroupLabel("2024-05-19T15:00:00Z")).toBe("Yesterday");
    });

    it("returns 'This week' for dates within the last 7 days (excluding today/yesterday)", () => {
        // May 20 is today, May 19 is yesterday
        // May 18 is 2 days ago
        const twoDaysAgo = new Date("2024-05-18T10:00:00Z");
        expect(dateGroupLabel(twoDaysAgo)).toBe("This week");

        // May 14 is 6 days ago
        const sixDaysAgo = new Date("2024-05-14T10:00:00Z");
        expect(dateGroupLabel(sixDaysAgo)).toBe("This week");
    });

    it("returns 'Earlier this month' for dates in the same month > 7 days ago", () => {
        // May 10 is 10 days ago (same month)
        const tenDaysAgo = new Date("2024-05-10T10:00:00Z");
        expect(dateGroupLabel(tenDaysAgo)).toBe("Earlier this month");

        // May 1 is same month
        const startOfMonth = new Date("2024-05-01T10:00:00Z");
        expect(dateGroupLabel(startOfMonth)).toBe("Earlier this month");
    });

    it("returns month name for dates in different month but same year", () => {
        const april = new Date("2024-04-15T10:00:00Z");
        expect(dateGroupLabel(april)).toBe("April");

        const january = new Date("2024-01-01T10:00:00Z");
        expect(dateGroupLabel(january)).toBe("January");
    });

    it("returns month and year for dates in a different year", () => {
        const lastYear = new Date("2023-12-15T10:00:00Z");
        expect(dateGroupLabel(lastYear)).toBe("December 2023");

        const longAgo = new Date("2020-05-20T10:00:00Z");
        expect(dateGroupLabel(longAgo)).toBe("May 2020");
    });
});
