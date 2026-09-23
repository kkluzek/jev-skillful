import { describe, expect, it } from "vitest";
import { parseHookInput } from "./hook.js";

describe("hook command input", () => {
  it("preserves the Claude PostToolBatch correlation and tool-call fields", () => {
    const input = parseHookInput(
      JSON.stringify({
        hook_event_name: "PostToolBatch",
        session_id: "session-1",
        prompt_id: "prompt-2",
        agent_id: "agent-3",
        agent_type: "Explore",
        cwd: "/workspace",
        tool_calls: [
          {
            tool_name: "Bash",
            tool_use_id: "tool-4",
            tool_input: { command: "pnpm test" },
            tool_response: { exit_code: 1, output: "tests failed" },
          },
        ],
      }),
    );

    expect(input).toEqual({
      prompt: "",
      hook_event_name: "PostToolBatch",
      session_id: "session-1",
      prompt_id: "prompt-2",
      agent_id: "agent-3",
      agent_type: "Explore",
      cwd: "/workspace",
      tool_calls: [
        {
          tool_name: "Bash",
          tool_use_id: "tool-4",
          tool_input: { command: "pnpm test" },
          tool_response: { exit_code: 1, output: "tests failed" },
        },
      ],
    });
  });
});
