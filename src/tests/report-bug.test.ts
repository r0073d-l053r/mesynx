import { describe, expect, it } from "vitest";
import {
    buildReportBugBodyPreview,
    buildReportBugDiscordUrl,
    buildReportBugUrl,
} from "../lib/report-bug";
import { APP_VERSION_TAG } from "../lib/version";

describe("report-bug", () => {
    describe("buildReportBugUrl", () => {
        it("returns the basic URL without options", () => {
            const urlStr = buildReportBugUrl({});
            const url = new URL(urlStr);

            expect(url.origin).toBe("https://github.com");
            expect(url.pathname).toBe("/r0073d-l053r/mesynx/issues/new");
            expect(url.searchParams.get("template")).toBe("bug_report.yml");
            expect(url.searchParams.get("version")).toBe(APP_VERSION_TAG);
            expect(url.searchParams.has("description")).toBe(false);
            expect(url.searchParams.has("deployment")).toBe(false);
            expect(url.searchParams.get("additional")).toBe(
                `Version: ${APP_VERSION_TAG}`,
            );
        });

        it("includes description when errorContext is provided", () => {
            const urlStr = buildReportBugUrl({ errorContext: "logging in" });
            const url = new URL(urlStr);

            expect(url.searchParams.get("description")).toBe(
                "While trying to: logging in",
            );
        });

        it("includes description when errorId is provided", () => {
            const urlStr = buildReportBugUrl({ errorId: "12345" });
            const url = new URL(urlStr);

            expect(url.searchParams.get("description")).toBe(
                "Error id: `12345`",
            );
        });

        it("includes description when both errorContext and errorId are provided", () => {
            const urlStr = buildReportBugUrl({
                errorContext: "logging in",
                errorId: "12345",
            });
            const url = new URL(urlStr);

            expect(url.searchParams.get("description")).toBe(
                "While trying to: logging in\n\nError id: `12345`",
            );
        });

        it("includes deployment and additional when isHosted is true", () => {
            const urlStr = buildReportBugUrl({ isHosted: true });
            const url = new URL(urlStr);

            expect(url.searchParams.get("deployment")).toBe(
                "Hosted (mesynx.r0073dl053r.com)",
            );
            expect(url.searchParams.get("additional")).toBe(
                `Version: ${APP_VERSION_TAG}\nMode: Hosted (mesynx.r0073dl053r.com)`,
            );
        });

        it("includes deployment and additional when isHosted is false", () => {
            const urlStr = buildReportBugUrl({ isHosted: false });
            const url = new URL(urlStr);

            expect(url.searchParams.get("deployment")).toBe("Self-hosted");
            expect(url.searchParams.get("additional")).toBe(
                `Version: ${APP_VERSION_TAG}\nMode: Self-hosted`,
            );
        });

        it("includes page in additional when provided", () => {
            const urlStr = buildReportBugUrl({ page: "/login" });
            const url = new URL(urlStr);

            expect(url.searchParams.get("additional")).toBe(
                `Page: \`/login\`\nVersion: ${APP_VERSION_TAG}`,
            );
        });

        it("combines all options correctly", () => {
            const urlStr = buildReportBugUrl({
                errorContext: "saving file",
                errorId: "ERR_123",
                page: "/dashboard",
                isHosted: true,
            });
            const url = new URL(urlStr);

            expect(url.searchParams.get("description")).toBe(
                "While trying to: saving file\n\nError id: `ERR_123`",
            );
            expect(url.searchParams.get("deployment")).toBe(
                "Hosted (mesynx.r0073dl053r.com)",
            );
            expect(url.searchParams.get("additional")).toBe(
                `Page: \`/dashboard\`\nVersion: ${APP_VERSION_TAG}\nMode: Hosted (mesynx.r0073dl053r.com)`,
            );
        });
    });

    describe("buildReportBugDiscordUrl", () => {
        it("returns the correct discord URL", () => {
            expect(buildReportBugDiscordUrl()).toBe(
                "https://discord.gg/mgBKaEGUvc",
            );
        });
    });

    describe("buildReportBugBodyPreview", () => {
        it("returns basic preview without options", () => {
            const body = buildReportBugBodyPreview({});
            expect(body).toBe(`Version: ${APP_VERSION_TAG}`);
        });

        it("returns preview with all options", () => {
            const body = buildReportBugBodyPreview({
                errorContext: "saving file",
                errorId: "ERR_123",
                page: "/dashboard",
                isHosted: false,
            });

            expect(body).toBe(
                `While trying to: saving file\n\nError id: \`ERR_123\`\nPage: \`/dashboard\`\nVersion: ${APP_VERSION_TAG}\nMode: Self-hosted`,
            );
        });
    });
});
