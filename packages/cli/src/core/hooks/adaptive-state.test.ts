import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADAPTIVE_STATE_VERSION,
  adaptiveSessionDir,
  adaptiveStatePath,
  pruneAdaptiveSessions,
  readAdaptiveState,
  writeAdaptiveState,
} from "./adaptive-state.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "skillful-adaptive-"));
  tempDirs.push(directory);
  return directory;
}

describe("adaptive session state", () => {
  it("stores private state and prunes a crashed session after the retention window", () => {
    const root = tempRoot();
    const file = adaptiveStatePath(root, "session-old");
    writeAdaptiveState(file, {
      version: ADAPTIVE_STATE_VERSION,
      promptId: "prompt-old",
      goal: "private user goal",
      updatedAt: 1_000,
      batchCount: 0,
      phase: "intent",
      normalInterventions: 0,
      recoveryInterventions: 0,
      shownIds: [],
      usedIds: [],
    });

    expect(readAdaptiveState(file)?.goal).toBe("private user goal");
    expect(statSync(file).mode & 0o077).toBe(0);

    const sessionDirectory = adaptiveSessionDir(root, "session-old");
    utimesSync(sessionDirectory, new Date(0), new Date(0));
    pruneAdaptiveSessions(root, 10_000, 1_000);

    expect(existsSync(sessionDirectory)).toBe(false);
  });
});
