/**
 * HTTP client for TypeSafe-compatible Jev decision endpoints.
 *
 * Two rules shape this file. The API key never appears in an error message, a log line,
 * or a returned value — it is attached to exactly one request header and referenced
 * nowhere else. And nothing throws past this boundary: every failure is converted into a
 * typed error whose `code` the router maps onto a degraded routing result.
 */

import {
  autoJevProvider,
  isJevProvider,
  JEV_PROVIDERS,
  type JevProvider,
  PROVIDER_ENV,
  type SystemOneRequest,
  type SystemOneResponse,
} from "./types.js";

/** Failure modes the router can act on. Each maps to a `degraded` reason. */
export type JevErrorCode = "auth" | "upstream" | "network" | "timeout" | "malformed" | "config";

export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly status?: number;

  constructor(code: JevErrorCode, message: string, status?: number) {
    super(message);
    this.name = "JevError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface JevClientOptions {
  /** Explicit billing route. Defaults to `SKILLFUL_PROVIDER`, then key precedence. */
  provider?: string;
  /** Overrides the selected provider's environment key. For tests and embedding. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Timeout for a single HTTP attempt, not for the whole retry sequence. */
  requestTimeoutMs?: number;
  /** Retries after the first attempt. Applied to 429 and 529 only. */
  maxRetries?: number;
  /** Backoff before the first retry, doubled each time. */
  retryBaseDelayMs?: number;
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Injected so tests do not wait for real backoff. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Environment snapshot. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Caller-owned deadline signal, aborted when the overall routing budget expires.
   *
   * The per-attempt timeout bounds one HTTP attempt; this bounds the entire retry
   * sequence, so a budget can be enforced rather than merely approximated.
   */
  signal?: AbortSignal;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 1800;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;

/** Statuses worth retrying: rate limit and upstream overload. 401 and 422 are not. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 529]);

export interface JevTarget {
  provider: JevProvider;
  apiKey: string;
  apiKeyEnv: string;
  baseUrl: string;
  model: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Read the abort state through a call rather than a property access.
 *
 * Control-flow analysis narrows `signal.aborted` to `false` after the first guard, and
 * that narrowing survives into later iterations of the retry loop, which makes the second
 * check look unreachable. A call boundary keeps the check honest.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** Resolve the provider, endpoint, default model and credential without exposing the key. */
export function resolveJevTarget(options: JevClientOptions = {}): JevTarget {
  const env = options.env ?? process.env;
  const requested = (options.provider ?? env[PROVIDER_ENV])?.trim().toLowerCase();
  let provider: JevProvider | undefined;

  if (requested !== undefined && requested.length > 0) {
    if (!isJevProvider(requested)) {
      throw new JevError(
        "config",
        `Unknown ${PROVIDER_ENV}=${JSON.stringify(requested)}; expected typesafe, vercel, or openrouter`,
      );
    }
    provider = requested;
  } else if ((options.apiKey?.trim().length ?? 0) > 0) {
    // Preserve the public embedding/test contract: an explicit key with no provider means
    // the original direct TypeSafe route.
    provider = "typesafe";
  } else {
    provider = autoJevProvider(env);
  }

  if (provider === undefined) {
    throw new JevError(
      "config",
      `No Jev provider credential found. Set ${PROVIDER_ENV} and its key, or one of TYPESAFE_API_KEY, AI_GATEWAY_API_KEY, OPENROUTER_API_KEY.`,
    );
  }

  const definition = JEV_PROVIDERS[provider];
  const apiKey = options.apiKey?.trim() || env[definition.apiKeyEnv]?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new JevError("config", `${PROVIDER_ENV}=${provider} requires ${definition.apiKeyEnv}`);
  }

  return {
    provider,
    apiKey,
    apiKeyEnv: definition.apiKeyEnv,
    baseUrl: options.baseUrl ?? definition.baseUrl,
    model: options.model ?? definition.model,
  };
}

/** Backward-compatible key probe. Prefer `resolveJevTarget` for provider-aware code. */
export function resolveApiKey(options: JevClientOptions = {}): string | undefined {
  try {
    return resolveJevTarget(options).apiKey;
  } catch {
    return undefined;
  }
}

/** Resolve only the non-secret provider defaults, including an explicit provider without a key. */
export function resolveJevDefaults(
  env: Readonly<Record<string, string | undefined>> = process.env,
  providerOverride?: string,
): { provider: string; baseUrl: string; model: string } {
  const requested = (providerOverride ?? env[PROVIDER_ENV])?.trim().toLowerCase();
  const provider =
    requested && requested.length > 0 ? requested : (autoJevProvider(env) ?? "typesafe");
  const definition = isJevProvider(provider) ? JEV_PROVIDERS[provider] : JEV_PROVIDERS.typesafe;

  return { provider, baseUrl: definition.baseUrl, model: definition.model };
}

/**
 * Convert a fetch rejection into a typed error.
 *
 * An aborted request and a timeout are the same thing here, and both are separated from
 * a genuine network failure because the router reports them differently.
 */
function classifyFetchFailure(error: unknown, timedOut: boolean): JevError {
  if (timedOut) {
    return new JevError("timeout", "Jev request exceeded its timeout");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new JevError("timeout", "Jev request was aborted");
  }
  // The message is built from the error name only. A thrown fetch error can carry the
  // request URL, and that URL is safe, but it must never be joined with a key or a body.
  const reason = error instanceof Error ? error.name : "unknown";
  return new JevError("network", `Jev request failed before a response (${reason})`);
}

/**
 * POST a question set and return the answers.
 *
 * Retries `maxRetries` times on 429 and 529 with exponential backoff. A 401 is returned
 * immediately as an `auth` error because retrying an invalid key cannot succeed and would
 * burn the caller's timeout budget.
 */
export async function callSystemOne(
  request: SystemOneRequest,
  options: JevClientOptions = {},
): Promise<SystemOneResponse> {
  const target = resolveJevTarget(options);

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new JevError("config", "No fetch implementation available in this runtime");
  }

  const sleep = options.sleepImpl ?? defaultSleep;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

  const model = request.model.trim() || target.model;
  const body = JSON.stringify({ ...request, model });

  const externalSignal = options.signal;
  let lastError: JevError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // A budget that expired before this attempt cannot be waited out; fail immediately so
    // the router can report a timeout instead of overrunning its ceiling.
    if (isAborted(externalSignal)) {
      throw new JevError("timeout", "Routing budget expired before the request was sent");
    }

    const controller = new AbortController();
    const onExternalAbort = (): void => {
      controller.abort();
    };
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchImpl(target.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${target.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = httpError(response.status);
        if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxRetries) {
          throw error;
        }
        lastError = error;
      } else {
        return await parseResponse(response, model);
      }
    } catch (error) {
      if (error instanceof JevError) {
        if (!RETRYABLE_STATUSES.has(error.status ?? 0) || attempt === maxRetries) throw error;
        lastError = error;
      } else {
        const classified = classifyFetchFailure(error, timedOut);
        // A timeout is retried as well: the request may have failed before leaving, and
        // the caller has already bounded the whole routing budget.
        if (attempt === maxRetries) throw classified;
        lastError = classified;
      }
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      timedOut = false;
    }

    // An expired external budget must not be retried, even if the failure looked
    // retryable, because there is no budget left to spend.
    if (isAborted(externalSignal)) {
      throw new JevError("timeout", "Routing budget expired during the request");
    }

    if (attempt < maxRetries) {
      await sleep(baseDelay * 2 ** attempt);
    }
  }

  throw lastError ?? new JevError("upstream", "Jev request failed for an unknown reason");
}

/** Map a non-2xx status onto a typed error. The body is never echoed, only the status. */
function httpError(status: number): JevError {
  if (status === 401 || status === 403) {
    return new JevError("auth", `The Jev provider rejected the API key (HTTP ${status})`, status);
  }
  if (status === 422) {
    return new JevError(
      "upstream",
      "The Jev provider rejected the request as invalid (HTTP 422)",
      status,
    );
  }
  return new JevError("upstream", `The Jev provider returned HTTP ${status}`, status);
}

/** Parse and shape-check a successful response. */
async function parseResponse(
  response: Response,
  fallbackModel: string,
): Promise<SystemOneResponse> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new JevError("malformed", "The Jev provider returned a body that is not JSON");
  }

  if (typeof payload !== "object" || payload === null) {
    throw new JevError("malformed", "The Jev provider returned a non-object body");
  }

  const candidate = payload as Partial<SystemOneResponse>;
  if (typeof candidate.answers !== "object" || candidate.answers === null) {
    throw new JevError("malformed", "The Jev provider response has no answers map");
  }

  return {
    model: typeof candidate.model === "string" ? candidate.model : fallbackModel,
    answers: candidate.answers,
    ...(candidate.usage === undefined ? {} : { usage: candidate.usage }),
  };
}
