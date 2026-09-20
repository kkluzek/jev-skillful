import { describe, expect, it, vi } from "vitest";
import { CapabilityRefreshMarkerError } from "../core/discovery/cache.js";
import { refreshCommand } from "./refresh.js";

describe("refreshCommand", () => {
  it("does not recurse when Codex app-server starts an ephemeral discovery thread", async () => {
    const refresh = vi.fn();

    const exitCode = await refreshCommand(
      {
        runtimes: ["codex"],
        includeCli: true,
        includeMcp: true,
        json: false,
        quiet: true,
        managed: true,
        env: { SKILLFUL_DISCOVERY_NESTED: "1" },
      },
      { refresh },
    );

    expect(exitCode).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("skips managed discovery entirely when Skillful is disabled", async () => {
    const refresh = vi.fn();
    for (const value of ["1", "true", "yes", "on"]) {
      await expect(
        refreshCommand(
          {
            runtimes: ["codex"],
            includeCli: true,
            includeMcp: true,
            json: false,
            quiet: true,
            managed: true,
            env: { SKILLFUL_DISABLE: value },
          },
          { refresh },
        ),
      ).resolves.toBe(0);
    }
    expect(refresh).not.toHaveBeenCalled();
  });

  it("returns a nonzero status for explicit incomplete refreshes but not managed hooks", async () => {
    const refresh = async () => ({
      cachePath: "/cache",
      refreshedAt: "2026-09-20T10:00:00.000Z",
      partitionsUpdated: 1,
      entriesWritten: 0,
      warnings: [],
      failures: [
        {
          partition: "mcp:codex:inventory",
          runtime: "codex" as const,
          code: "config" as const,
          message: "incomplete",
        },
      ],
    });
    const base = {
      runtimes: ["codex"] as const,
      includeCli: true,
      includeMcp: true,
      json: false,
      quiet: true,
    };
    await expect(refreshCommand({ ...base, managed: false }, { refresh })).resolves.toBe(2);
    await expect(refreshCommand({ ...base, managed: true }, { refresh })).resolves.toBe(0);
  });

  it("contains unexpected background refresh exceptions but fails explicit refreshes", async () => {
    const refresh = async (): Promise<never> => {
      throw new Error("cache lock failed");
    };
    const base = {
      runtimes: ["codex"] as const,
      includeCli: true,
      includeMcp: true,
      json: false,
      quiet: true,
    };

    await expect(refreshCommand({ ...base, managed: true }, { refresh })).resolves.toBe(0);
    await expect(refreshCommand({ ...base, managed: false }, { refresh })).resolves.toBe(2);
  });

  it("never reports managed success when fail-closed intent could not be published", async () => {
    const refresh = async (): Promise<never> => {
      throw new CapabilityRefreshMarkerError("marker unavailable");
    };
    await expect(
      refreshCommand(
        {
          runtimes: ["codex"],
          includeCli: true,
          includeMcp: true,
          json: false,
          quiet: true,
          managed: true,
        },
        { refresh },
      ),
    ).resolves.toBe(2);
  });

  it("queues a managed refresh for most of the SessionStart hook budget", async () => {
    const refresh = vi.fn(async () => ({
      cachePath: "/cache",
      refreshedAt: "2026-09-20T10:00:00.000Z",
      partitionsUpdated: 0,
      entriesWritten: 0,
      warnings: [],
      failures: [],
    }));

    await refreshCommand(
      {
        runtimes: ["codex"],
        includeCli: true,
        includeMcp: true,
        json: false,
        quiet: true,
        managed: true,
      },
      { refresh },
    );

    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ lockWaitMs: 600_000 }));
  });
});
