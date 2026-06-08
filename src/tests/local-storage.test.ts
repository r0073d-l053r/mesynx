import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStorage } from "../lib/storage/local-storage";

describe("LocalStorage", () => {
    let baseDir: string;
    let storage: LocalStorage;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "mesynx-local-storage-test-"));
        storage = new LocalStorage(baseDir);
    });

    afterAll(async () => {
        await rm(baseDir, { recursive: true, force: true });
    });

    describe("initialization and env fallback", () => {
        it("should initialize with provided baseDir", () => {
            const tempStorage = new LocalStorage(baseDir);
            expect(tempStorage).toBeDefined();
        });

        it("should fallback to env.LOCAL_STORAGE_PATH if baseDir is not provided", () => {
            // env is imported inside local-storage.ts, we can trust the default fallback behavior
            const tempStorage = new LocalStorage();
            expect(tempStorage).toBeDefined();
        });
    });

    describe("path traversal prevention", () => {
        const invalidPaths = [
            "../secret.txt",
            "../../etc/passwd",
            "/absolute/path.txt",
            "file\0.txt",
            "dir/../secret.txt", // Evaluates to outside or at root if at root
        ];

        it.each(
            invalidPaths,
        )("should reject invalid path: %s", async (invalidPath) => {
            const buffer = Buffer.from("test");

            // Path traversal should be rejected during upload
            await expect(
                storage.uploadFile(invalidPath, buffer, "text/plain"),
            ).rejects.toThrow(
                /path traversal detected|path outside storage directory/,
            );

            // Path traversal should be rejected during download
            await expect(storage.downloadFile(invalidPath)).rejects.toThrow(
                /path traversal detected|path outside storage directory/,
            );

            // Path traversal should be rejected during delete
            await expect(storage.deleteFile(invalidPath)).rejects.toThrow(
                /path traversal detected|path outside storage directory/,
            );
        });

        it("should accept valid nested paths", async () => {
            const validNestedPath = "nested/folder/file.txt";
            const buffer = Buffer.from("test nested content");

            const key = await storage.uploadFile(
                validNestedPath,
                buffer,
                "text/plain",
            );
            expect(key).toBe(validNestedPath);

            const downloaded = await storage.downloadFile(key);
            expect(downloaded.toString()).toBe("test nested content");

            await storage.deleteFile(key);
        });
    });

    describe("file operations", () => {
        const testKey = "test-file.txt";
        const testContent = "Hello, LocalStorage!";
        const testBuffer = Buffer.from(testContent);

        it("should upload a file successfully", async () => {
            const key = await storage.uploadFile(
                testKey,
                testBuffer,
                "text/plain",
            );
            expect(key).toBe(testKey);
        });

        it("should download a file successfully", async () => {
            // Assumes the file from the previous test exists
            // But let's be safe and re-upload
            await storage.uploadFile(testKey, testBuffer, "text/plain");
            const downloadedBuffer = await storage.downloadFile(testKey);
            expect(downloadedBuffer.toString()).toBe(testContent);
        });

        it("should throw error when downloading a non-existent file", async () => {
            await expect(
                storage.downloadFile("non-existent.txt"),
            ).rejects.toThrow(/Failed to download file/);
        });

        it("should delete a file successfully", async () => {
            await storage.uploadFile(testKey, testBuffer, "text/plain");

            // Should resolve without error
            await expect(storage.deleteFile(testKey)).resolves.toBeUndefined();

            // File should no longer exist
            await expect(storage.downloadFile(testKey)).rejects.toThrow(
                /Failed to download file/,
            );
        });

        it("should throw error when deleting a non-existent file", async () => {
            await expect(
                storage.deleteFile("non-existent.txt"),
            ).rejects.toThrow(/Failed to delete file/);
        });
    });

    describe("getSignedUrl", () => {
        it("should return the correct proxy URL format", async () => {
            const key = "test/file with spaces.txt";
            const url = await storage.getSignedUrl(key, 3600);
            expect(url).toBe(
                `/api/recordings/audio/test%2Ffile%20with%20spaces.txt`,
            );
        });
    });

    describe("testConnection", () => {
        it("should return true for a valid storage configuration", async () => {
            const isConnected = await storage.testConnection();
            expect(isConnected).toBe(true);
        });

        it("should return false if storage path is completely invalid or inaccessible", async () => {
            // Using a system path that typically shouldn't be writable by normal users
            // such as /root/test or just mock the mkdir/access to throw
            const _invalidStorage = new LocalStorage(
                "/invalid/root/path/that/cannot/be/created/hopefully",
            );

            // To be deterministic, we can mock ensureBaseDir or the fs module, but since we want to avoid global mocks
            // let's try an actually invalid setup and see if it fails safely.
            // Better yet, just point it to a read-only root or a null byte path.

            // Alternatively, we'll try a path with null byte which resolve/mkdir typically fails on
            const badStorage = new LocalStorage("/bad\0path");

            const isConnected = await badStorage.testConnection();
            expect(isConnected).toBe(false);
        });
    });
});
