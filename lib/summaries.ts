import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SummaryPart } from "./types.ts";

function parseSummaryPart(text: string): SummaryPart | undefined {
  const match = /^\s*\*\*([^\n]+?)\*\*[ \t]*(?:\r?\n(?:\r?\n)?([\s\S]*))?\s*$/.exec(
    text,
  );
  if (!match) return undefined;
  return { title: match[1].trim(), body: (match[2] ?? "").trim() };
}

export function parseLatestStreamingSummary(
  text: string,
): SummaryPart | undefined {
  // Providers do not consistently insert a blank line between streamed
  // summary parts, so accept a bold title at the start of any source line.
  const titlePattern = /(?:^|\r?\n)\s*\*\*([^\n*]+?)\*\*[ \t]*(?:\r?\n)?/g;
  let latest: RegExpExecArray | undefined;
  let match: RegExpExecArray | null;
  while ((match = titlePattern.exec(text))) latest = match;
  if (!latest) return parseSummaryPart(text);

  return {
    title: latest[1].trim(),
    body: text.slice(latest.index + latest[0].length).trim(),
  };
}

export function isOpenAiResponsesMessage(message: AssistantMessage) {
  return (
    message.api === "openai-responses" ||
    message.api === "openai-codex-responses" ||
    message.api === "azure-openai-responses"
  );
}

export function getLatestOpenAiSummary(
  thinkingSignature: string | undefined,
): SummaryPart | undefined {
  if (!thinkingSignature) return undefined;

  try {
    const item = JSON.parse(thinkingSignature) as {
      type?: unknown;
      summary?: Array<{ type?: unknown; text?: unknown }>;
    };
    if (item.type !== "reasoning" || !Array.isArray(item.summary)) {
      return undefined;
    }

    for (let i = item.summary.length - 1; i >= 0; i--) {
      const part = item.summary[i];
      if (part.type !== "summary_text" || typeof part.text !== "string") {
        continue;
      }
      const parsed = parseSummaryPart(part.text);
      if (parsed) return parsed;
    }
  } catch {
    // Invalid or provider-specific signatures use the generic fallback.
  }
  return undefined;
}
