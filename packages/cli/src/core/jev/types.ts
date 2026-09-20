/**
 * Wire types shared by the TypeSafe-compatible Jev endpoints.
 *
 * These mirror the published request and response shapes exactly. The distinction that
 * matters most for routing is that `noul` returns a bare probability with **no separate
 * confidence**, while `choice` returns a distribution plus a confidence. Runner-up
 * ranking therefore uses the `noul` value directly, and only the primary decision has a
 * confidence to report.
 */

/** Yes/no question. High means yes. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option name to description. `null` when the option name is self-explanatory. */
  criteria: Record<string, string | null>;
}

export type Question = NoulQuestion | ChoiceQuestion;

export interface SystemOneRequest {
  /** The content to evaluate. A string or structured data. */
  state: unknown;
  /** Required by the API. `jev-latest` is the flagship alias. */
  model: string;
  questions: Record<string, Question>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer;

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type JevProvider = "typesafe" | "vercel" | "openrouter";

export interface JevProviderDefinition {
  apiKeyEnv: "TYPESAFE_API_KEY" | "AI_GATEWAY_API_KEY" | "OPENROUTER_API_KEY";
  baseUrl: string;
  model: string;
}

/** Explicit provider selector. Credentials remain environment-only. */
export const PROVIDER_ENV = "SKILLFUL_PROVIDER";

/**
 * Provider routes mirrored from the evaluate/typesafe-mcp connector.
 *
 * Vercel exposes a TypeSafe-compatible System One endpoint, not its ordinary
 * OpenAI-compatible endpoint. OpenRouter's Decisions API is still alpha.
 */
export const JEV_PROVIDERS: Readonly<Record<JevProvider, JevProviderDefinition>> = {
  typesafe: {
    apiKeyEnv: "TYPESAFE_API_KEY",
    baseUrl: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
  },
  vercel: {
    apiKeyEnv: "AI_GATEWAY_API_KEY",
    baseUrl: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    model: "typesafe-ai/jev",
  },
  openrouter: {
    apiKeyEnv: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/alpha/decisions",
    model: "~typesafe/jev-latest",
  },
};

export const JEV_PROVIDER_ORDER: readonly JevProvider[] = ["typesafe", "vercel", "openrouter"];

/** Backward-compatible TypeSafe defaults. Provider-aware callers use `JEV_PROVIDERS`. */
export const DEFAULT_MODEL = JEV_PROVIDERS.typesafe.model;
export const DEFAULT_BASE_URL = JEV_PROVIDERS.typesafe.baseUrl;
export const API_KEY_ENV = JEV_PROVIDERS.typesafe.apiKeyEnv;

export function isJevProvider(value: string): value is JevProvider {
  return value === "typesafe" || value === "vercel" || value === "openrouter";
}

/** Pick the first configured provider without ever returning a credential. */
export function autoJevProvider(
  env: Readonly<Record<string, string | undefined>>,
): JevProvider | undefined {
  return JEV_PROVIDER_ORDER.find((provider) => {
    const value = env[JEV_PROVIDERS[provider].apiKeyEnv];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function isNoulAnswer(answer: Answer | undefined): answer is NoulAnswer {
  return answer !== undefined && answer.type === "noul";
}

export function isChoiceAnswer(answer: Answer | undefined): answer is ChoiceAnswer {
  return answer !== undefined && answer.type === "choice";
}
