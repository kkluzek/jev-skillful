import { describe, expect, it } from "vitest";
import { parseCliHelp } from "./cli.js";

describe("parseCliHelp", () => {
  it("extracts bounded subcommands from common Commands sections", () => {
    const parsed = parseCliHelp(
      `demo 1.0\n\nCommands:\n  init       Create a project\n  deploy     Deploy it\n  help       Print help\n\nOptions:\n  --json     JSON output\n`,
    );
    expect(parsed.description).toBe("demo 1.0");
    expect(parsed.subcommands).toEqual([
      { name: "init", description: "Create a project" },
      { name: "deploy", description: "Deploy it" },
    ]);
  });

  it("treats control characters and oversized descriptions as bounded data", () => {
    const parsed = parseCliHelp(`tool\u0000 title\nCommands:\n  run ${"x".repeat(1000)}\n`);
    expect(parsed.description).not.toContain("\u0000");
    expect(parsed.subcommands[0]?.description.length).toBeLessThanOrEqual(200);
  });
});
