import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseCodexMcpList,
  parseCodexPluginList,
  resolveCodexPluginCatalogEntries,
} from "./codex-plugins.js";

let root: string;
let codexHome: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skillful-codex-plugins-"));
  codexHome = path.join(root, "codex-home");
  await mkdir(codexHome, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Codex plugin inventory", () => {
  it("resolves local and remote active install paths from Codex's JSON inventory", () => {
    const installs = parseCodexPluginList(
      JSON.stringify({
        installed: [
          {
            pluginId: "local-tools@personal",
            name: "local-tools",
            marketplaceName: "personal",
            version: "local",
            installed: true,
            enabled: true,
            source: { source: "local", path: path.join(root, "local-tools") },
          },
          {
            pluginId: "drive@remote",
            name: "drive",
            marketplaceName: "remote",
            version: "1.2.3",
            installed: true,
            enabled: true,
            source: { source: "remote", id: "plugin_remote" },
          },
          {
            pluginId: "disabled@remote",
            name: "disabled",
            marketplaceName: "remote",
            version: "9.9.9",
            installed: true,
            enabled: false,
            source: { source: "remote", id: "plugin_disabled" },
          },
        ],
        available: [],
      }),
      codexHome,
    );

    expect(installs).toEqual([
      expect.objectContaining({
        id: "local-tools@personal",
        enabled: true,
        installPath: path.join(root, "local-tools"),
      }),
      expect.objectContaining({
        id: "drive@remote",
        enabled: true,
        installPath: path.join(codexHome, "plugins", "cache", "remote", "drive", "1.2.3"),
      }),
      expect.objectContaining({ id: "disabled@remote", enabled: false }),
    ]);
  });

  it("fails closed when an installed plugin record is malformed", () => {
    expect(() =>
      parseCodexPluginList(JSON.stringify({ installed: [{ pluginId: "broken" }] }), codexHome),
    ).toThrow(/missing required fields/);
  });

  it("caches skills only from installed and enabled Codex plugins", async () => {
    const activeRoot = path.join(root, "active");
    const disabledRoot = path.join(root, "disabled");
    await mkdir(path.join(activeRoot, "skills", "triage"), { recursive: true });
    await writeFile(
      path.join(activeRoot, "plugin.json"),
      JSON.stringify({ name: "issue-tools", version: "1.0.0" }),
      "utf8",
    );
    await writeFile(
      path.join(activeRoot, "skills", "triage", "SKILL.md"),
      "---\nname: triage\ndescription: Triage an issue in Codex\n---\n",
      "utf8",
    );
    await mkdir(path.join(disabledRoot, "skills", "unsafe"), { recursive: true });
    await writeFile(
      path.join(disabledRoot, "skills", "unsafe", "SKILL.md"),
      "---\nname: unsafe\ndescription: Must not be cached\n---\n",
      "utf8",
    );

    const result = await resolveCodexPluginCatalogEntries([
      {
        id: "issue-tools@personal",
        name: "issue-tools",
        marketplaceName: "personal",
        version: "1.0.0",
        installed: true,
        enabled: true,
        source: "local",
        installPath: activeRoot,
      },
      {
        id: "disabled@personal",
        name: "disabled",
        marketplaceName: "personal",
        version: "1.0.0",
        installed: true,
        enabled: false,
        source: "local",
        installPath: disabledRoot,
      },
    ]);

    expect(result.entries).toEqual([
      expect.objectContaining({
        runtime: "codex",
        kind: "skill",
        name: "issue-tools:triage",
        description: "Triage an issue in Codex",
      }),
    ]);
  });
});

describe("Codex effective MCP inventory", () => {
  it("parses the transport without interpreting disabled entries as available", () => {
    expect(
      parseCodexMcpList(
        JSON.stringify([
          {
            name: "docs",
            enabled: true,
            transport: { type: "streamable_http", url: "https://example.test/mcp" },
          },
          {
            name: "off",
            enabled: false,
            transport: { type: "stdio", command: "off", args: [] },
          },
        ]),
      ),
    ).toEqual([
      expect.objectContaining({
        name: "docs",
        enabled: true,
        transport: expect.objectContaining({ url: "https://example.test/mcp" }),
      }),
      expect.objectContaining({ name: "off", enabled: false }),
    ]);
  });
});
