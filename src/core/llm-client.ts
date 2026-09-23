/**
 * Injectable LLM client, mirroring the pattern already used for HttpClient
 * and Clock in fetcher.ts: an interface the core logic depends on, a real
 * implementation for production, and a fake for tests -- so scientist.ts
 * and reviewer.ts never make a real network call in the test suite.
 *
 * Scope decision (confirmed with Andres): the Scientist (§8.3) and the
 * Reviewer/Critic (§8.4) both reason in natural language over the Evidence
 * Packet -- that is not a deterministic-rules task like the extractor, so
 * both are implemented as calls to the Claude API (Anthropic), each with a
 * prompt that forces the response into the v0 contract shape, validated
 * with Zod exactly like the Evidence Packet itself.
 */
import { readFileSync } from "node:fs";
import { Agent as HttpsAgent } from "node:https";
import { rootCertificates } from "node:tls";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmCallOptions {
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
}

export interface LlmClient {
  /** Returns the raw text of the model's response. Throws on transport/API failure. */
  complete(options: LlmCallOptions): Promise<string>;
}

export class LlmCallError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmCallError";
  }
}

const DEFAULT_MODEL = "claude-sonnet-5";
// Found against a real call, not guessed: this model spends some of its
// budget on an internal "thinking" block before the final text block. At
// 4096 the real run hit stop_reason "max_tokens" having produced only a
// thinking block and zero text -- our installed SDK version (0.32.1)
// predates the `thinking` API parameter, so we can't request it disabled
// through typed options; raising the ceiling is the safe fix instead of
// guessing at an unsupported/mistyped parameter.
const DEFAULT_MAX_TOKENS = 16000;

/**
 * Builds the https.Agent the Anthropic SDK is told to use, so this works
 * behind a corporate TLS-intercepting proxy (Cisco Umbrella and similar --
 * confirmed against a real one during Build Order #2's smoke test).
 *
 * Why not just rely on NODE_EXTRA_CA_CERTS (the env var Node itself reads)?
 * That env var is only guaranteed to be honored by Node's own `https`
 * module; whether every code path the SDK's fetch/undici usage takes
 * respects it is not guaranteed across Node/undici versions. Passing the
 * combined CA list straight to an explicit httpAgent (which the SDK
 * explicitly supports for proxy/custom-TLS scenarios) is unambiguous.
 *
 * https.Agent's own `ca` option REPLACES Node's bundled trust store rather
 * than appending to it -- unlike the env var, which appends. We reproduce
 * the env var's append semantics explicitly (rootCertificates + the extra
 * PEM file's contents) so a machine with no interception at all still
 * trusts every public CA it always did.
 */
function buildHttpAgent(): HttpsAgent | undefined {
  const extraCaCertsPath = process.env["NODE_EXTRA_CA_CERTS"];
  if (!extraCaCertsPath) {
    // Nothing configured -- let the SDK use its own default agent.
    return undefined;
  }
  let extraCaCerts: string;
  try {
    extraCaCerts = readFileSync(extraCaCertsPath, "utf-8");
  } catch (err) {
    throw new LlmCallError(
      `NODE_EXTRA_CA_CERTS is set to "${extraCaCertsPath}" but that file could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return new HttpsAgent({ keepAlive: true, ca: [...rootCertificates, extraCaCerts] });
}

/**
 * Walks err.cause (and, for a Node AggregateError, err.errors) to build a
 * "top message <- cause message <- cause message" trail. Bounded depth so a
 * cyclical or pathological cause chain can never hang the process.
 */
function describeErrorChain(err: unknown, depth = 0): string {
  if (depth > 5 || err === undefined || err === null) return "";
  if (!(err instanceof Error)) return String(err);

  const parts = [err.message];
  if (err instanceof AggregateError && err.errors.length > 0) {
    parts.push(`[${err.errors.map((e) => describeErrorChain(e, depth + 1)).join("; ")}]`);
  } else if ("cause" in err && err.cause !== undefined) {
    const causeText = describeErrorChain(err.cause, depth + 1);
    if (causeText) parts.push(causeText);
  }
  return parts.join(" <- ");
}

/**
 * Real implementation over @anthropic-ai/sdk. Reads the API key from
 * ANTHROPIC_API_KEY -- never hardcode it, never log it, never include it in
 * an error message (see the try/catch below: only the SDK's own error
 * message/status is surfaced, not request internals).
 */
export function createAnthropicLlmClient(options?: { apiKey?: string; model?: string }): LlmClient {
  const apiKey = options?.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new LlmCallError(
      "ANTHROPIC_API_KEY is not set. Export it in your shell or pass { apiKey } explicitly -- never commit a key to the repo.",
    );
  }
  const model = options?.model ?? DEFAULT_MODEL;

  return {
    async complete({ system, messages, maxTokens }: LlmCallOptions): Promise<string> {
      // Lazy import so tests that only use the fake client never need the
      // SDK installed/mocked, and so a missing API key fails fast above
      // rather than at import time.
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const httpAgent = buildHttpAgent();
      const client = new Anthropic(httpAgent ? { apiKey, httpAgent } : { apiKey });
      try {
        const response = await client.messages.create({
          model,
          max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
          system,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });
        const textBlock = response.content.find((block) => block.type === "text");
        if (!textBlock || textBlock.type !== "text") {
          // Self-diagnosing rather than a dead end: the two real causes are
          // (a) max_tokens was too low and the model was cut off before any
          // text block, or (b) the response was only a non-text block type
          // (e.g. thinking). Both are visible from stop_reason + the block
          // types actually returned -- surface them instead of guessing.
          const blockTypes = response.content.map((b) => b.type).join(", ") || "(none)";
          throw new LlmCallError(
            `Claude API response contained no text block. stop_reason: "${response.stop_reason}", block types returned: [${blockTypes}]. If stop_reason is "max_tokens", raise maxTokens.`,
          );
        }
        return textBlock.text;
      } catch (err) {
        if (err instanceof LlmCallError) throw err;
        // The SDK's own top-level message (e.g. "Connection error.") is
        // often just a wrapper -- the actually diagnosable detail (DNS
        // failure, proxy refusal, TLS error, timeout) lives one or more
        // levels down in `.cause`. Surface the whole chain so a failure
        // here is debuggable from the CLI's stderr alone, not a dead end.
        throw new LlmCallError(`Claude API call failed: ${describeErrorChain(err)}`, err);
      }
    },
  };
}

/**
 * Test double: returns pre-scripted responses in order, or a function of
 * the call options if the caller needs to vary the response by prompt
 * content. Never touches the network.
 */
export function fakeLlmClient(
  responses: string[] | ((options: LlmCallOptions, callIndex: number) => string),
): LlmClient {
  let callIndex = 0;
  return {
    async complete(options: LlmCallOptions): Promise<string> {
      const result = Array.isArray(responses) ? responses[callIndex] : responses(options, callIndex);
      callIndex += 1;
      if (result === undefined) {
        throw new LlmCallError(`fakeLlmClient: no scripted response for call #${callIndex}`);
      }
      return result;
    },
  };
}
