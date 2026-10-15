import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type AssistantMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer, Text, type MarkdownOptions } from "@earendil-works/pi-tui";
import { CompactThinking } from "./compact-thinking.ts";
import { config } from "./config.ts";
import { formatThoughtDuration, StrictThinkingPreview } from "./preview.ts";
import {
  getLatestOpenAiSummary,
  isOpenAiResponsesMessage,
  parseLatestStreamingSummary,
} from "./summaries.ts";
import type {
  ActiveThinking,
  AssistantInternals,
  MarkdownTransformer,
  SummaryPart,
} from "./types.ts";

export interface RenderOptions {
  activeThinking?: ActiveThinking;
  theme?: Theme;
  animationFrame: number;
  isStreaming: boolean;
}

interface ThinkingRun {
  startIndex: number;
  endIndex: number;
  blocks: string[];
  latestSummary?: SummaryPart;
}

type AssistantContent = AssistantMessage["content"][number];

function getAssistantMarkdownOptions(
  self: AssistantInternals,
  isStreaming: boolean,
): MarkdownOptions | undefined {
  const transformers = self.markdownTransformers;
  if (!transformers || transformers.length === 0) return undefined;

  return {
    transform(markdown: string, availableWidth: number) {
      let transformedMarkdown = markdown;
      for (const transformer of transformers) {
        try {
          const transformed = transformer(transformedMarkdown, {
            messageType: "assistant",
            isStreaming,
            availableWidth,
          } satisfies Parameters<MarkdownTransformer>[1]);
          if (typeof transformed === "string") {
            transformedMarkdown = transformed;
          }
        } catch {
          // One broken transformer must not prevent the remaining Markdown from rendering.
        }
      }
      return transformedMarkdown;
    },
  };
}

function hasVisibleContent(content: AssistantContent) {
  return (
    (content.type === "text" && Boolean(content.text.trim())) ||
    (content.type === "thinking" && Boolean(content.thinking.trim()))
  );
}

function styleThinkingText(theme: Theme | undefined, text: string) {
  return theme ? theme.italic(theme.fg("thinkingText", text)) : text;
}

function styleSummaryTitle(theme: Theme | undefined, text: string) {
  return theme ? theme.italic(theme.bold(theme.fg("thinkingText", text))) : text;
}

function animateText(
  text: string,
  style: (value: string) => string,
  theme: Theme | undefined,
  frame: number,
) {
  if (!theme) return style(text);

  const characters = Array.from(text);
  if (characters.length === 0) return "";

  const highlightWidth = Math.max(1, Math.min(5, Math.ceil(characters.length * 0.28)));
  const start = (frame % (characters.length + highlightWidth)) - highlightWidth;
  const end = start + highlightWidth;
  const before = characters.slice(0, Math.max(0, start)).join("");
  const highlighted = characters
    .slice(Math.max(0, start), Math.min(characters.length, end))
    .join("");
  const after = characters.slice(Math.max(0, end)).join("");

  return (
    style(before) +
    (highlighted ? theme.italic(theme.bold(theme.fg("text", highlighted))) : "") +
    style(after)
  );
}

function collectThinkingRun(
  message: AssistantMessage,
  startIndex: number,
  activeThinking: ActiveThinking | undefined,
): ThinkingRun {
  const blocks: string[] = [];
  let latestSummary: SummaryPart | undefined;
  let index = startIndex;

  for (; index < message.content.length; index++) {
    const content = message.content[index];
    if (content.type !== "thinking") break;

    const thinking = content.thinking.trim();
    if (!thinking) continue;
    blocks.push(thinking);

    if (!config.useSummaryTitlesAsThinkingTitle || !isOpenAiResponsesMessage(message)) continue;

    const isActive =
      activeThinking?.messageTimestamp === message.timestamp &&
      activeThinking.contentIndex === index;
    latestSummary = isActive
      ? (parseLatestStreamingSummary(thinking) ??
        getLatestOpenAiSummary(content.thinkingSignature) ??
        latestSummary)
      : (getLatestOpenAiSummary(content.thinkingSignature) ??
        parseLatestStreamingSummary(thinking) ??
        latestSummary);
  }

  return {
    startIndex,
    endIndex: index - 1,
    blocks,
    latestSummary,
  };
}

function renderText(
  self: AssistantInternals,
  content: Extract<AssistantContent, { type: "text" }>,
  isStreaming: boolean,
) {
  self.contentContainer.addChild(
    new Markdown(
      content.text.trim(),
      self.outputPad,
      0,
      self.markdownTheme,
      undefined,
      getAssistantMarkdownOptions(self, isStreaming),
    ),
  );
}

function renderThinkingRun(
  self: AssistantInternals,
  compactThinking: CompactThinking,
  message: AssistantMessage,
  run: ThinkingRun,
  options: RenderOptions,
) {
  const { activeThinking, animationFrame, theme } = options;
  const active =
    activeThinking?.messageTimestamp === message.timestamp &&
    activeThinking.contentIndex >= run.startIndex &&
    activeThinking.contentIndex <= run.endIndex;

  if (run.blocks.length === 0 && !active) return;
  if (message.content.slice(0, run.startIndex).some(hasVisibleContent)) {
    self.contentContainer.addChild(new Spacer(1));
  }

  const elapsedMs = activeThinking ? Math.max(1, Date.now() - activeThinking.startedAt) : undefined;
  const completedMs = compactThinking.findDurationsInRange(
    message.timestamp,
    run.startIndex,
    run.endIndex,
  );
  const durationMs = active ? elapsedMs : completedMs;
  const durationText = durationMs === undefined ? undefined : formatThoughtDuration(durationMs);
  const thinkingStyle = (text: string) => styleThinkingText(theme, text);

  let heading: string;
  if (active && run.latestSummary) {
    heading =
      animateText(
        run.latestSummary.title,
        (text) => styleSummaryTitle(theme, text),
        theme,
        animationFrame,
      ) + (durationText ? thinkingStyle(` · ${durationText}`) : "");
  } else if (active) {
    heading =
      animateText(self.hiddenThinkingLabel || "Thinking...", thinkingStyle, theme, animationFrame) +
      (durationText ? thinkingStyle(` · ${durationText}`) : "");
  } else {
    heading = thinkingStyle(
      durationText ? `Thought for ${durationText}` : self.hiddenThinkingLabel || "Thinking...",
    );
  }
  self.contentContainer.addChild(new Text(heading, self.outputPad, 0));

  const previewSource = run.latestSummary?.body ?? run.blocks.join("\n\n");
  if (config.previewLines > 0 && previewSource.trim()) {
    self.contentContainer.addChild(
      new StrictThinkingPreview(previewSource.trim(), self.outputPad, thinkingStyle),
    );
  }

  if (message.content.slice(run.endIndex + 1).some(hasVisibleContent)) {
    self.contentContainer.addChild(new Spacer(1));
  }
}

function renderStopReason(
  self: AssistantInternals,
  message: AssistantMessage,
  theme: Theme | undefined,
  hasToolCalls: boolean,
) {
  let errorMessage: string | undefined;

  if (message.stopReason === "length") {
    errorMessage =
      "Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.";
  } else if (!hasToolCalls && message.stopReason === "aborted") {
    const reason =
      message.errorMessage && message.errorMessage !== "Request was aborted"
        ? message.errorMessage
        : "Operation aborted";
    errorMessage = reason;
  } else if (!hasToolCalls && message.stopReason === "error") {
    errorMessage = `Error: ${message.errorMessage || "Unknown error"}`;
  }

  if (!errorMessage) return;
  self.contentContainer.addChild(new Spacer(1));
  self.contentContainer.addChild(
    new Text(theme ? theme.fg("error", errorMessage) : errorMessage, self.outputPad, 0),
  );
}

export function renderAssistantMessage(
  component: AssistantMessageComponent,
  compactThinking: CompactThinking,
  message: AssistantMessage,
  options: RenderOptions,
) {
  const self = component as unknown as AssistantInternals;
  self.contentContainer.clear();

  const hasActiveThinking =
    options.activeThinking?.messageTimestamp === message.timestamp &&
    message.content.some((content) => content.type === "thinking");
  if (hasActiveThinking || message.content.some(hasVisibleContent)) {
    self.contentContainer.addChild(new Spacer(1));
  }

  for (let index = 0; index < message.content.length; index++) {
    const content = message.content[index];

    if (content.type === "text" && content.text.trim()) {
      renderText(self, content, options.isStreaming);
      continue;
    }
    if (content.type !== "thinking") continue;

    const run = collectThinkingRun(message, index, options.activeThinking);
    renderThinkingRun(self, compactThinking, message, run, options);
    index = run.endIndex;
  }

  const hasToolCalls = message.content.some((content) => content.type === "toolCall");
  self.hasToolCalls = hasToolCalls;
  renderStopReason(self, message, options.theme, hasToolCalls);
}
