import { describe, expect, it, vi } from "vitest";
import { callSystemOne, JevError, resolveJevTarget } from "./client.js";

describe("Jev provider routing", () => {
  it.each([
    [
      { TYPESAFE_API_KEY: "typesafe-key" },
      "typesafe",
      "TYPESAFE_API_KEY",
      "https://api.typesafe.ai/v1/systemone",
      "jev-latest",
    ],
    [
      { AI_GATEWAY_API_KEY: "vercel-key" },
      "vercel",
      "AI_GATEWAY_API_KEY",
      "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
      "typesafe-ai/jev",
    ],
    [
      { OPENROUTER_API_KEY: "openrouter-key" },
      "openrouter",
      "OPENROUTER_API_KEY",
      "https://openrouter.ai/api/alpha/decisions",
      "~typesafe/jev-latest",
    ],
  ])("auto-selects %s", (env, provider, apiKeyEnv, baseUrl, model) => {
    expect(resolveJevTarget({ env })).toMatchObject({ provider, apiKeyEnv, baseUrl, model });
  });

  it("uses TypeSafe, Vercel, OpenRouter key precedence for compatibility", () => {
    expect(
      resolveJevTarget({
        env: {
          TYPESAFE_API_KEY: "typesafe-key",
          AI_GATEWAY_API_KEY: "vercel-key",
          OPENROUTER_API_KEY: "openrouter-key",
        },
      }).provider,
    ).toBe("typesafe");
    expect(
      resolveJevTarget({
        env: { AI_GATEWAY_API_KEY: "vercel-key", OPENROUTER_API_KEY: "openrouter-key" },
      }).provider,
    ).toBe("vercel");
  });

  it("honours an explicit provider so inherited keys cannot change the billing route", () => {
    const target = resolveJevTarget({
      provider: " VERCEL ",
      env: {
        TYPESAFE_API_KEY: "typesafe-key",
        AI_GATEWAY_API_KEY: "vercel-key",
        OPENROUTER_API_KEY: "openrouter-key",
      },
    });

    expect(target.provider).toBe("vercel");
    expect(target.apiKey).toBe("vercel-key");
  });

  it("fails closed for an unknown provider or a missing selected-provider key", () => {
    expect(() => resolveJevTarget({ provider: "other", env: {} })).toThrow(
      "Unknown SKILLFUL_PROVIDER",
    );
    expect(() =>
      resolveJevTarget({ provider: "vercel", env: { TYPESAFE_API_KEY: "unrelated" } }),
    ).toThrow("AI_GATEWAY_API_KEY");
  });

  it("never includes a credential value in a provider error", () => {
    const secret = "secret-that-must-not-appear";
    let error: unknown;
    try {
      resolveJevTarget({ provider: "other", env: { AI_GATEWAY_API_KEY: secret } });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(JevError);
    expect(String(error)).not.toContain(secret);
  });

  it("posts the TypeSafe request shape to Vercel with its model and key", async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ answers: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const fetchImpl = fetchSpy as unknown as typeof fetch;

    const response = await callSystemOne(
      { state: "safe synthetic state", model: "", questions: {} },
      {
        provider: "vercel",
        env: { AI_GATEWAY_API_KEY: "vercel-key" },
        fetchImpl,
        maxRetries: 0,
      },
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init).toBeDefined();
    expect(url).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer vercel-key",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "typesafe-ai/jev" });
    expect(response.model).toBe("typesafe-ai/jev");
  });

  it("keeps explicit model and endpoint overrides on the selected provider", async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ answers: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const fetchImpl = fetchSpy as unknown as typeof fetch;

    await callSystemOne(
      { state: "state", model: "custom-model", questions: {} },
      {
        provider: "vercel",
        env: { AI_GATEWAY_API_KEY: "vercel-key" },
        baseUrl: "https://proxy.invalid/systemone",
        fetchImpl,
        maxRetries: 0,
      },
    );

    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://proxy.invalid/systemone");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)).model).toBe("custom-model");
  });

  it("classifies the per-attempt abort as a timeout instead of a network failure", async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as unknown as typeof fetch;

    await expect(
      callSystemOne(
        { state: "state", model: "", questions: {} },
        {
          provider: "vercel",
          env: { AI_GATEWAY_API_KEY: "vercel-key" },
          fetchImpl,
          requestTimeoutMs: 20,
          maxRetries: 0,
        },
      ),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});
