import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/lib/auth";
import { ErrorCode } from "@/lib/errors";

const mockLimit = vi.fn();
const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

vi.mock("@/db", () => ({
    db: {
        select: vi.fn((...args: unknown[]) => mockSelect(...args)),
    },
}));

vi.mock("drizzle-orm", () => ({
    eq: vi.fn(),
}));

vi.mock("@/db/schema", () => ({
    users: {
        id: "users.id",
        suspendedAt: "users.suspendedAt",
    },
}));

vi.mock("next/headers", () => ({
    headers: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    redirect: vi.fn(() => {
        throw new Error("NEXT_REDIRECT");
    }),
}));

vi.mock("@/lib/auth", () => ({
    auth: {
        api: {
            getSession: vi.fn(),
        },
    },
}));

import {
    getSession,
    redirectIfAuthenticated,
    requireApiSession,
    requireAuth,
} from "@/lib/auth-server";

describe("auth-server", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("getSession", () => {
        it("returns session from auth.api.getSession using headers()", async () => {
            const mockHeaders = new Headers();
            vi.mocked(headers).mockResolvedValue(mockHeaders);
            const mockSession = { user: { id: "1" } };
            vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

            const result = await getSession();

            expect(headers).toHaveBeenCalled();
            expect(auth.api.getSession).toHaveBeenCalledWith({
                headers: mockHeaders,
            });
            expect(result).toBe(mockSession);
        });
    });

    describe("requireAuth", () => {
        it("redirects to /login if no session exists", async () => {
            vi.mocked(headers).mockResolvedValue(new Headers());
            vi.mocked(auth.api.getSession).mockResolvedValue(null);

            await expect(requireAuth()).rejects.toThrow("NEXT_REDIRECT");

            expect(redirect).toHaveBeenCalledWith("/login");
        });

        it("redirects to /suspended if user is suspended", async () => {
            vi.mocked(headers).mockResolvedValue(new Headers());
            vi.mocked(auth.api.getSession).mockResolvedValue({
                user: { id: "1" },
            });
            mockLimit.mockResolvedValue([{ suspendedAt: new Date() }]);

            await expect(requireAuth()).rejects.toThrow("NEXT_REDIRECT");

            expect(redirect).toHaveBeenCalledWith("/suspended");
        });

        it("returns session if authenticated and not suspended", async () => {
            vi.mocked(headers).mockResolvedValue(new Headers());
            const mockSession = { user: { id: "1" } };
            vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
            mockLimit.mockResolvedValue([{}]);

            const result = await requireAuth();

            expect(redirect).not.toHaveBeenCalled();
            expect(result).toBe(mockSession);
        });
    });

    describe("redirectIfAuthenticated", () => {
        it("redirects to /dashboard if session exists", async () => {
            vi.mocked(headers).mockResolvedValue(new Headers());
            vi.mocked(auth.api.getSession).mockResolvedValue({
                user: { id: "1" },
            });

            await expect(redirectIfAuthenticated()).rejects.toThrow(
                "NEXT_REDIRECT",
            );

            expect(redirect).toHaveBeenCalledWith("/dashboard");
        });

        it("does not redirect if no session exists", async () => {
            vi.mocked(headers).mockResolvedValue(new Headers());
            vi.mocked(auth.api.getSession).mockResolvedValue(null);

            await redirectIfAuthenticated();

            expect(redirect).not.toHaveBeenCalled();
        });
    });

    describe("requireApiSession", () => {
        it("throws 401 if no session exists", async () => {
            vi.mocked(auth.api.getSession).mockResolvedValue(null);
            const request = new Request("http://localhost");

            await expect(requireApiSession(request)).rejects.toMatchObject({
                code: ErrorCode.AUTH_SESSION_MISSING,
                statusCode: 401,
            });
        });

        it("throws 403 if user is suspended", async () => {
            vi.mocked(auth.api.getSession).mockResolvedValue({
                user: { id: "1" },
            });
            mockLimit.mockResolvedValue([{ suspendedAt: new Date() }]);
            const request = new Request("http://localhost");

            await expect(requireApiSession(request)).rejects.toMatchObject({
                code: ErrorCode.ACCOUNT_SUSPENDED,
                statusCode: 403,
            });
        });

        it("returns session if authenticated and not suspended", async () => {
            const mockSession = { user: { id: "1" } };
            vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
            mockLimit.mockResolvedValue([{}]);
            const request = new Request("http://localhost");

            const result = await requireApiSession(request);

            expect(result).toBe(mockSession);
        });
    });
});
