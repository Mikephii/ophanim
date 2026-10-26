// The one place Ophan calls Claude: model choice, retries, and reading the reply.
import Anthropic from "@anthropic-ai/sdk";
import pRetry from "p-retry";

/** Default model for function analysis and community summaries. Override with OPHAN_MODEL. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

export function getModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPHAN_MODEL?.trim() || DEFAULT_MODEL;
}

/** Claude declined the request (stop_reason "refusal"); nothing usable came back. */
export class ClaudeRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`Claude declined to analyze this code${category ? ` (${category})` : ""}`);
    this.name = "ClaudeRefusalError";
  }
}

type Reply = Pick<Anthropic.Message, "content" | "stop_reason"> & {
  stop_details?: { category?: string | null } | null;
};

/**
 * The reply's text. Current models may return thinking blocks before the text,
 * so never assume the first block is text.
 */
export function extractText(reply: Reply): string {
  if (reply.stop_reason === "refusal") {
    throw new ClaudeRefusalError(reply.stop_details?.category ?? null);
  }
  if (reply.stop_reason === "max_tokens") {
    throw new Error("Claude's reply was cut off at max_tokens");
  }
  return reply.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Rate limits, overload and server errors are worth retrying; bad requests are not. */
export function isRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" && (status === 429 || status === 529 || status >= 500);
}

export interface CallOptions {
  prompt: string;
  maxTokens: number;
  client?: Pick<Anthropic, "messages">;
  onRetry?: (attemptNumber: number, error: Error) => void;
}

let defaultClient: Anthropic | undefined;

export async function callClaude({ prompt, maxTokens, client, onRetry }: CallOptions): Promise<string> {
  const anthropic = client ?? (defaultClient ??= new Anthropic());
  const reply = await pRetry(
    () =>
      anthropic.messages.create({
        model: getModel(),
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    {
      retries: 4,
      minTimeout: 2000,
      shouldRetry: ({ error }) => isRetryable(error),
      onFailedAttempt: ({ error, attemptNumber }) => {
        if (isRetryable(error)) onRetry?.(attemptNumber, error);
      },
    }
  );
  return extractText(reply);
}
