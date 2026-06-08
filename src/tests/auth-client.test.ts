import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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
            // @ts-ignore
            delete global.window;
        } else {
            global.window = originalWindow;
        }
    });

    it("should use window.location.origin when window is defined", async () => {
        global.window = {
            location: { origin: "https://example.com" }
        } as any;

        const { authClient } = await import("../lib/auth-client");

        expect(mockCreateAuthClient).toHaveBeenCalledWith({
            baseURL: "https://example.com",
        });
    });

    it("should use localhost:3000 when window is undefined", async () => {
        // @ts-ignore
        delete global.window;

        const { authClient } = await import("../lib/auth-client");

        expect(mockCreateAuthClient).toHaveBeenCalledWith({
            baseURL: "http://localhost:3000",
        });
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
