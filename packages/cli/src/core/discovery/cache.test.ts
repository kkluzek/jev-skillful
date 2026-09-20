import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CatalogEntry } from "../catalog/types.js";
import {
  beginCapabilityRefreshMarker,
  CAPABILITY_CACHE_VERSION,
  CapabilityRefreshMarkerError,
  completeCapabilityRefreshMarkers,
  emptyCapabilityCache,
  loadCapabilityCache,
  readCapabilityEntries,
  saveCapabilityCache,
  updateCapabilityPartition,
} from "./cache.js";

const roots: string[] = [];

function tempFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), "skillful-cap-cache-"));
  roots.push(root);
  return path.join(root, "nested", "capabilities-v2.json");
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tool(runtime: "codex" | "claude-code", sourcePath: string): CatalogEntry {
  return {
    id: `${runtime}:mcp-tool:global:github/search_issues:${sourcePath}`,
    kind: "mcp-tool",
    name: "github/search_issues",
    description: "Search issues",
    runtime,
    scope: "global",
    sourcePath,
    details: {
      type: "mcp-tool",
      client: runtime,
      server: "github",
      tool: "search_issues",
      scopeKey: "user",
      configOrigin: sourcePath,
      canonicalName: `mcp__github__search_issues`,
      availability: "available",
      observedAt: "2026-09-20T10:00:00.000Z",
    },
  };
}

function cli(runtime: "codex" | "claude-code"): CatalogEntry {
  return {
    id: `${runtime}:cli-command:global:demo`,
    kind: "cli-command",
    name: "demo",
    description: "Demo command",
    runtime,
    scope: "global",
    sourcePath: "/opt/bin/demo",
    details: {
      type: "cli-command",
      commandPath: ["demo"],
      invocationHint: "demo",
      executablePath: "/opt/bin/demo",
      executableRealPath: "/opt/bin/demo",
      installManager: "homebrew",
      packageName: "demo",
      metadataSource: "carapace",
      availability: "available",
      observedAt: "2026-09-20T10:00:00.000Z",
    },
  };
}

describe("capability cache", () => {
  it("keeps Codex and Claude MCP tools in separate runtime partitions", () => {
    const file = tempFile();
    const cache = emptyCapabilityCache("2026-09-20T10:00:00.000Z");
    updateCapabilityPartition(cache, {
      key: "mcp:codex:user:github",
      runtime: "codex",
      source: "mcp",
      status: "fresh",
      refreshedAt: "2026-09-20T10:00:00.000Z",
      entries: [tool("codex", "/home/u/.codex/config.toml")],
    });
    updateCapabilityPartition(cache, {
      key: "mcp:claude-code:user:github",
      runtime: "claude-code",
      source: "mcp",
      status: "fresh",
      refreshedAt: "2026-09-20T10:00:00.000Z",
      entries: [tool("claude-code", "/home/u/.claude.json")],
    });
    saveCapabilityCache(file, cache);

    expect(readCapabilityEntries(file, { runtimes: ["codex"] }).entries).toEqual([
      expect.objectContaining({ runtime: "codex", name: "github/search_issues" }),
    ]);
    expect(readCapabilityEntries(file, { runtimes: ["claude-code"] }).entries).toEqual([
      expect.objectContaining({ runtime: "claude-code", name: "github/search_issues" }),
    ]);
  });

  it("preserves last-known-good entries as stale after a failed refresh", () => {
    const cache = emptyCapabilityCache("2026-09-20T10:00:00.000Z");
    const key = "mcp:codex:user:github";
    updateCapabilityPartition(cache, {
      key,
      runtime: "codex",
      source: "mcp",
      status: "fresh",
      refreshedAt: "2026-09-20T10:00:00.000Z",
      entries: [tool("codex", "/home/u/.codex/config.toml")],
    });
    updateCapabilityPartition(cache, {
      key,
      runtime: "codex",
      source: "mcp",
      status: "failed",
      refreshedAt: "2026-09-20T10:05:00.000Z",
      entries: [],
      error: { code: "timeout", message: "timed out", at: "2026-09-20T10:05:00.000Z" },
    });

    const partition = cache.partitions[key];
    expect(partition?.status).toBe("stale");
    expect(partition?.entries).toHaveLength(1);
    expect(partition?.entries[0]?.details).toEqual(
      expect.objectContaining({ availability: "stale" }),
    );
    expect(partition?.error?.code).toBe("timeout");

    const file = tempFile();
    saveCapabilityCache(file, cache);
    const read = readCapabilityEntries(file, { runtimes: ["codex"] });
    expect(read.entries).toEqual([]);
    expect(read.warnings.join("\n")).toContain("timed out");
  });

  it("never leaks project capabilities into another or projectless workspace", () => {
    const file = tempFile();
    const cache = emptyCapabilityCache("2026-09-20T10:00:00.000Z");
    updateCapabilityPartition(cache, {
      key: "mcp:codex:project-a:github",
      runtime: "codex",
      source: "mcp",
      workspaceKey: "project-a",
      status: "fresh",
      refreshedAt: "2026-09-20T10:00:00.000Z",
      entries: [tool("codex", "/project-a/.codex/config.toml")],
    });
    saveCapabilityCache(file, cache);

    expect(readCapabilityEntries(file, { runtimes: ["codex"] }).entries).toEqual([]);
    expect(
      readCapabilityEntries(file, { runtimes: ["codex"], workspaceKey: "project-b" }).entries,
    ).toEqual([]);
    expect(
      readCapabilityEntries(file, { runtimes: ["codex"], workspaceKey: "project-a" }).entries,
    ).toHaveLength(1);
  });

  it("hides exact MCP tools during refresh without enabling broad MCP fallback", () => {
    const file = tempFile();
    const cache = emptyCapabilityCache("2026-09-20T10:00:00.000Z");
    updateCapabilityPartition(cache, {
      key: "mcp:codex:user:github",
      runtime: "codex",
      source: "mcp",
      status: "fresh",
      refreshedAt: "2026-09-20T10:00:00.000Z",
      entries: [tool("codex", "/home/u/.codex/config.toml")],
    });
    saveCapabilityCache(file, cache);
    beginCapabilityRefreshMarker(file, {
      startedAt: "2026-09-20T10:01:00.000Z",
      runtimes: ["codex"],
      includeCli: false,
      includeMcp: true,
    });

    const read = readCapabilityEntries(file, { runtimes: ["codex"] });
    expect(read.entries).toEqual([]);
    expect(read.mcpInventoryRuntimes).toEqual(["codex"]);
    expect(read.warnings.join("\n")).toContain("refresh in progress");
  });

  it("suppresses broad MCP fallback during the first refresh before any partition exists", () => {
    const file = tempFile();
    saveCapabilityCache(file, emptyCapabilityCache("2026-09-20T10:00:00.000Z"));
    beginCapabilityRefreshMarker(file, {
      startedAt: "2026-09-20T10:01:00.000Z",
      runtimes: ["codex"],
      includeCli: false,
      includeMcp: true,
      workspaceKey: "workspace-a",
    });

    const read = readCapabilityEntries(file, {
      runtimes: ["codex"],
      workspaceKey: "workspace-a",
    });
    expect(read.entries).toEqual([]);
    expect(read.mcpInventoryRuntimes).toEqual(["codex"]);
  });

  it("fails closed and reports marker publication failure instead of leaving old cache fresh", () => {
    const file = tempFile();
    const cache = emptyCapabilityCache("2026-09-20T10:00:00.000Z");
    updateCapabilityPartition(cache, {
      key: "mcp:codex:user:github",
      runtime: "codex",
      source: "mcp",
      status: "fresh",
      refreshedAt: "2026-09-20T10:00:00.000Z",
      entries: [tool("codex", "/codex")],
    });
    saveCapabilityCache(file, cache);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.refreshing`, "path collision", "utf8");

    expect(() =>
      beginCapabilityRefreshMarker(file, {
        startedAt: "2026-09-20T10:01:00.000Z",
        runtimes: ["codex"],
        includeCli: false,
        includeMcp: true,
      }),
    ).toThrow(CapabilityRefreshMarkerError);
    const read = readCapabilityEntries(file, { runtimes: ["codex"] });
    expect(read.entries).toEqual([]);
    expect(read.mcpInventoryRuntimes).toEqual(["codex"]);
    expect(read.warnings.join("\n")).toContain("markers are unreadable");
  });

  it("retires covered dimensions of an abandoned combined marker independently", () => {
    const file = tempFile();
    const cache = emptyCapabilityCache("2026-09-20T10:00:00.000Z");
    for (const runtime of ["codex", "claude-code"] as const) {
      updateCapabilityPartition(cache, {
        key: `cli:installed:${runtime}`,
        runtime,
        source: "cli-installed",
        status: "fresh",
        refreshedAt: "2026-09-20T10:00:00.000Z",
        entries: [cli(runtime)],
      });
      updateCapabilityPartition(cache, {
        key: `mcp:${runtime}:inventory:global`,
        runtime,
        source: "mcp",
        status: "fresh",
        refreshedAt: "2026-09-20T10:00:00.000Z",
        entries: [tool(runtime, `/${runtime}`)],
      });
    }
    saveCapabilityCache(file, cache);
    beginCapabilityRefreshMarker(file, {
      startedAt: "2026-09-20T10:01:00.000Z",
      runtimes: ["codex", "claude-code"],
      includeCli: true,
      includeMcp: true,
    });

    const codexCli = beginCapabilityRefreshMarker(file, {
      startedAt: "2026-09-20T10:02:00.000Z",
      runtimes: ["codex"],
      includeCli: true,
      includeMcp: false,
    });
    completeCapabilityRefreshMarkers(file, codexCli);

    const codex = readCapabilityEntries(file, { runtimes: ["codex"] });
    expect(codex.entries.map((entry) => entry.kind)).toEqual(["cli-command"]);
    const claude = readCapabilityEntries(file, { runtimes: ["claude-code"] });
    expect(claude.entries).toEqual([]);
  });

  it("keeps an aggregate guard when publishing an uncovered dimension fails", () => {
    const file = tempFile();
    const cache = emptyCapabilityCache("2026-09-20T10:00:00.000Z");
    updateCapabilityPartition(cache, {
      key: "cli:installed:codex",
      runtime: "codex",
      source: "cli-installed",
      status: "fresh",
      refreshedAt: "2026-09-20T10:00:00.000Z",
      entries: [cli("codex")],
    });
    updateCapabilityPartition(cache, {
      key: "mcp:codex:inventory:global",
      runtime: "codex",
      source: "mcp",
      status: "fresh",
      refreshedAt: "2026-09-20T10:00:00.000Z",
      entries: [tool("codex", "/codex")],
    });
    saveCapabilityCache(file, cache);
    const markerDir = `${file}.refreshing`;
    mkdirSync(markerDir, { recursive: true });
    const aggregate = {
      version: 1 as const,
      id: "old-aggregate",
      startedAt: "2026-09-20T10:01:00.000Z",
      runtimes: ["codex" as const],
      includeCli: true,
      includeMcp: true,
    };
    writeFileSync(path.join(markerDir, `${aggregate.id}.json`), JSON.stringify(aggregate));

    expect(() =>
      completeCapabilityRefreshMarkers(
        file,
        {
          markers: [
            {
              ...aggregate,
              id: "completed-cli",
              includeMcp: false,
              cliScope: "installed",
            },
          ],
        },
        {
          writeMarker: () => {
            throw new Error("disk full");
          },
        },
      ),
    ).toThrow("disk full");

    expect(readFileSync(path.join(markerDir, "old-aggregate.json"), "utf8")).toContain(
      '"includeMcp":true',
    );
    const read = readCapabilityEntries(file, { runtimes: ["codex"] });
    expect(read.entries).toEqual([]);
    expect(read.mcpInventoryRuntimes).toEqual(["codex"]);
  });

  it("writes versioned private JSON atomically and rejects corrupt versions", () => {
    const file = tempFile();
    saveCapabilityCache(file, emptyCapabilityCache("2026-09-20T10:00:00.000Z"));
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(CAPABILITY_CACHE_VERSION);
    expect(loadCapabilityCache(file).cache.version).toBe(CAPABILITY_CACHE_VERSION);

    const wrong = JSON.stringify({ version: 999, partitions: {} });
    writeFileSync(file, wrong, "utf8");
    const loaded = loadCapabilityCache(file);
    expect(Object.keys(loaded.cache.partitions)).toHaveLength(0);
    expect(loaded.warnings[0]).toContain("version");
    expect(readCapabilityEntries(file, { runtimes: ["codex"] }).mcpInventoryRuntimes).toEqual([
      "codex",
    ]);
  });

  it("rejects malformed partitions and runtime-mismatched entries", () => {
    const file = tempFile();
    saveCapabilityCache(file, emptyCapabilityCache("2026-09-20T10:00:00.000Z"));
    writeFileSync(
      file,
      JSON.stringify({
        version: CAPABILITY_CACHE_VERSION,
        updatedAt: "2026-09-20T10:00:00.000Z",
        partitions: { broken: null },
      }),
      "utf8",
    );
    expect(loadCapabilityCache(file).warnings[0]).toContain("shape");

    const cache = emptyCapabilityCache("2026-09-20T10:00:00.000Z");
    cache.partitions.bad = {
      key: "bad",
      runtime: "codex",
      source: "mcp",
      status: "fresh",
      refreshedAt: "2026-09-20T10:00:00.000Z",
      entries: [tool("claude-code", "/wrong-runtime")],
    };
    saveCapabilityCache(file, cache);
    expect(loadCapabilityCache(file).warnings[0]).toContain("shape");

    const malformedDetails = emptyCapabilityCache("2026-09-20T10:00:00.000Z");
    const entry = tool("codex", "/codex");
    malformedDetails.partitions.bad = {
      key: "bad",
      runtime: "codex",
      source: "mcp",
      status: "fresh",
      refreshedAt: "2026-09-20T10:00:00.000Z",
      entries: [{ ...entry, details: {} } as CatalogEntry],
    };
    saveCapabilityCache(file, malformedDetails);
    expect(loadCapabilityCache(file).warnings[0]).toContain("shape");
  });
});
