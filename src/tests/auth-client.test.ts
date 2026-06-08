import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateAuthClient = vi.fn().mockReturnValue({
    useSession: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    signUp: vi.fn(),
    resetPassword: vi.fn(),
    requestPasswordReset: vi.fn(),
});

vi.mock("better-auth/react", () => ({
    createAuthClient: mockCreateAuthClient,
}));

describe("auth-client", () => {
    const originalWindow = global.window;

    beforeEach(() => {
        vi.resetModules();
        mockCreateAuthClient.mockClear();
    });

    afterEach(() => {
        if (originalWindow === undefined) {
            // @ts-expect-error vitest node environment
            delete global.window;
        } else {
            global.window = originalWindow;
        }
    });

    it("should use window.location.origin when window is defined", async () => {
        global.window = {
            location: { origin: "https://example.com" },
        } as unknown as Window & typeof globalThis;

        const mod = await import("../lib/auth-client");

        expect(mockCreateAuthClient).toHaveBeenCalledWith({
            baseURL: "https://example.com",
        });

        // Use the authClient to avoid unused variable warning
        expect(mod.authClient).toBeDefined();
    });

    it("should use localhost:3000 when window is undefined", async () => {
        // @ts-expect-error vitest node environment
        delete global.window;

        const mod = await import("../lib/auth-client");

        expect(mockCreateAuthClient).toHaveBeenCalledWith({
            baseURL: "http://localhost:3000",
        });

        // Use the authClient to avoid unused variable warning
        expect(mod.authClient).toBeDefined();
    });

    it("should export methods from authClient", async () => {
        const mod = await import("../lib/auth-client");

        expect(mod.useSession).toBeDefined();
        expect(mod.signIn).toBeDefined();
        expect(mod.signOut).toBeDefined();
        expect(mod.signUp).toBeDefined();
        expect(mod.resetPassword).toBeDefined();
        expect(mod.forgetPassword).toBeDefined();
    });
});
