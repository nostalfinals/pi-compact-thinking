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
  MarkdownTransformer,
  MessageComponentInternals,
  SummaryPart,
} from "./types.ts";

export interface RenderOptions {
  activeThinking?: ActiveThinking;
  theme?: Theme;
  animationFrame: number;
  isStreaming: boolean;
}

export interface ActiveThinkingText {
  text: Text;
  render(animationFrame: number): string;
}

interface ThinkingRun {
  startIndex: number;
  endIndex: number;
  thinkingBlocks: string[];
  latestSummary?: SummaryPart;
}

type AssistantContent = AssistantMessage["content"][number];

function getAssistantMarkdownOptions(
  self: MessageComponentInternals,
  isStreaming: boolean,
): MarkdownOptions | undefined {
  const transformers = self.markdownTransformers;

  if (!transformers || transformers.length === 0) {
    return undefined;
  }

  return {
    transform(markdown: string, availableWidth: number): string {
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

function hasVisibleContent(content: AssistantContent): boolean {
  return (
    (content.type === "text" && Boolean(content.text.trim())) ||
    (content.type === "thinking" && Boolean(content.thinking.trim()))
  );
}

function styleThinkingText(theme: Theme | undefined, text: string): string {
  if (!theme) {
    return text;
  }

  return theme.italic(theme.fg("thinkingText", text));
}

function styleSummaryTitle(theme: Theme | undefined, text: string): string {
  if (!theme) {
    return text;
  }

  return theme.italic(theme.bold(theme.fg("thinkingText", text)));
}

function animateText(
  text: string,
  style: (value: string) => string,
  theme: Theme | undefined,
  frame: number,
): string {
  if (!theme) {
    return style(text);
  }

  const characters = Array.from(text);

  if (characters.length === 0) {
    return "";
  }

  const highlightWidth = Math.max(1, Math.min(5, Math.ceil(characters.length * 0.28)));
  const start = (frame % (characters.length + highlightWidth)) - highlightWidth;
  const end = start + highlightWidth;
  const before = characters.slice(0, Math.max(0, start)).join("");
  const highlighted = characters
    .slice(Math.max(0, start), Math.min(characters.length, end))
    .join("");
  const after = characters.slice(Math.max(0, end)).join("");

  let styledHighlight = "";

  if (highlighted) {
    styledHighlight = theme.italic(theme.bold(theme.fg("text", highlighted)));
  }

  return style(before) + styledHighlight + style(after);
}

function collectThinkingRun(
  message: AssistantMessage,
  startIndex: number,
  activeThinking: ActiveThinking | undefined,
): ThinkingRun {
  const thinkingBlocks: string[] = [];
  let latestSummary: SummaryPart | undefined;
  let index = startIndex;

  for (; index < message.content.length; index++) {
    const content = message.content[index];

    if (content.type !== "thinking") {
      break;
    }

    const thinking = content.thinking.trim();

    if (!thinking) {
      continue;
    }

    thinkingBlocks.push(thinking);

    if (!config.useSummaryTitlesAsThinkingTitle || !isOpenAiResponsesMessage(message)) {
      continue;
    }

    const isActive =
      activeThinking?.messageTimestamp === message.timestamp &&
      activeThinking.contentIndex === index;

    if (isActive) {
      latestSummary =
        parseLatestStreamingSummary(thinking) ??
        getLatestOpenAiSummary(content.thinkingSignature) ??
        latestSummary;
    } else {
      latestSummary =
        getLatestOpenAiSummary(content.thinkingSignature) ??
        parseLatestStreamingSummary(thinking) ??
        latestSummary;
    }
  }

  return {
    startIndex,
    endIndex: index - 1,
    thinkingBlocks,
    latestSummary,
  };
}

function renderText(
  self: MessageComponentInternals,
  content: Extract<AssistantContent, { type: "text" }>,
  isStreaming: boolean,
) {
  const markdownOptions = getAssistantMarkdownOptions(self, isStreaming);

  self.contentContainer.addChild(
    new Markdown(
      content.text.trim(),
      self.outputPad,
      0,
      self.markdownTheme,
      undefined,
      markdownOptions,
    ),
  );
}

function renderThinkingRun(
  self: MessageComponentInternals,
  compactThinking: CompactThinking,
  message: AssistantMessage,
  thinkingRun: ThinkingRun,
  options: RenderOptions,
): ActiveThinkingText | undefined {
  const { activeThinking, animationFrame, theme } = options;
  const isActive =
    activeThinking?.messageTimestamp === message.timestamp &&
    activeThinking.contentIndex >= thinkingRun.startIndex &&
    activeThinking.contentIndex <= thinkingRun.endIndex;

  if (thinkingRun.thinkingBlocks.length === 0 && !isActive) {
    return;
  }

  const hasVisibleContentBefore = message.content
    .slice(0, thinkingRun.startIndex)
    .some(hasVisibleContent);

  if (hasVisibleContentBefore) {
    self.contentContainer.addChild(new Spacer(1));
  }

  const completedMs = compactThinking.findDurationsInRange(
    message.timestamp,
    thinkingRun.startIndex,
    thinkingRun.endIndex,
  );
  const thinkingStyle = (text: string): string => styleThinkingText(theme, text);
  const renderHeading = (frame: number): string => {
    const elapsedMs = activeThinking
      ? Math.max(1, Date.now() - activeThinking.startedAt)
      : undefined;
    const durationMs = isActive ? elapsedMs : completedMs;
    const durationText = durationMs === undefined ? undefined : formatThoughtDuration(durationMs);
    const durationSuffix = durationText ? thinkingStyle(` · ${durationText}`) : "";

    if (isActive && thinkingRun.latestSummary) {
      const animatedTitle = animateText(
        thinkingRun.latestSummary.title,
        (text): string => styleSummaryTitle(theme, text),
        theme,
        frame,
      );

      return animatedTitle + durationSuffix;
    }

    if (isActive) {
      const label = self.hiddenThinkingLabel || "Thinking...";
      const animatedLabel = animateText(label, thinkingStyle, theme, frame);

      return animatedLabel + durationSuffix;
    }

    const label = durationText
      ? `Thought for ${durationText}`
      : self.hiddenThinkingLabel || "Thinking...";

    return thinkingStyle(label);
  };
  const headingText = new Text(renderHeading(animationFrame), self.outputPad, 0);

  self.contentContainer.addChild(headingText);

  const previewSource = thinkingRun.latestSummary?.body ?? thinkingRun.thinkingBlocks.join("\n\n");

  if (config.previewLines > 0 && previewSource.trim()) {
    self.contentContainer.addChild(
      new StrictThinkingPreview(previewSource.trim(), self.outputPad, thinkingStyle),
    );
  }

  const hasVisibleContentAfter = message.content
    .slice(thinkingRun.endIndex + 1)
    .some(hasVisibleContent);

  if (hasVisibleContentAfter) {
    self.contentContainer.addChild(new Spacer(1));
  }

  if (!isActive) {
    return undefined;
  }

  return {
    text: headingText,
    render: renderHeading,
  };
}

function renderStopReason(
  self: MessageComponentInternals,
  message: AssistantMessage,
  theme: Theme | undefined,
  hasToolCalls: boolean,
) {
  let errorMessage: string | undefined;

  if (message.stopReason === "length") {
    errorMessage =
      "Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.";
  } else if (!hasToolCalls && message.stopReason === "aborted") {
    errorMessage =
      message.errorMessage && message.errorMessage !== "Request was aborted"
        ? message.errorMessage
        : "Operation aborted";
  } else if (!hasToolCalls && message.stopReason === "error") {
    errorMessage = `Error: ${message.errorMessage || "Unknown error"}`;
  }

  if (!errorMessage) {
    return;
  }

  const styledError = theme ? theme.fg("error", errorMessage) : errorMessage;

  self.contentContainer.addChild(new Spacer(1));
  self.contentContainer.addChild(new Text(styledError, self.outputPad, 0));
}

export function renderAssistantMessage(
  component: AssistantMessageComponent,
  compactThinking: CompactThinking,
  message: AssistantMessage,
  options: RenderOptions,
): ActiveThinkingText | undefined {
  const self = component as unknown as MessageComponentInternals;
  self.contentContainer.clear();

  const hasActiveThinking =
    options.activeThinking?.messageTimestamp === message.timestamp &&
    message.content.some((content): boolean => content.type === "thinking");
  const shouldAddLeadingSpace = hasActiveThinking || message.content.some(hasVisibleContent);

  if (shouldAddLeadingSpace) {
    self.contentContainer.addChild(new Spacer(1));
  }

  let activeThinkingText: ActiveThinkingText | undefined;

  for (let index = 0; index < message.content.length; index++) {
    const content = message.content[index];

    if (content.type === "text" && content.text.trim()) {
      renderText(self, content, options.isStreaming);
      continue;
    }

    if (content.type !== "thinking") {
      continue;
    }

    const thinkingRun = collectThinkingRun(message, index, options.activeThinking);
    const renderedThinkingText = renderThinkingRun(
      self,
      compactThinking,
      message,
      thinkingRun,
      options,
    );

    if (renderedThinkingText) {
      activeThinkingText = renderedThinkingText;
    }

    index = thinkingRun.endIndex;
  }

  const hasToolCalls = message.content.some((content): boolean => content.type === "toolCall");

  self.hasToolCalls = hasToolCalls;
  renderStopReason(self, message, options.theme, hasToolCalls);

  return activeThinkingText;
}
