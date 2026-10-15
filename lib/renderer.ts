import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  Spacer,
  Text,
  type Component,
  type MarkdownOptions,
  type TUI,
} from "@earendil-works/pi-tui";
import type { CompactThinking } from "./compact-thinking.ts";
import { config } from "./config.ts";
import { formatThoughtDuration, ThinkingPreview } from "./preview.ts";
import {
  getLatestOpenAiSummary,
  isOpenAiResponsesMessage,
  parseLatestStreamingSummary,
} from "./summaries.ts";
import type {
  ActiveThinking,
  MarkdownTransformer,
  MessageComponentInternals,
  PatchedPrototype,
  SummaryPart,
} from "./types.ts";

const DUMMY_WIDGET_ID = "compact-thinking-render-dummy";

export interface RenderOptions {
  activeThinking?: ActiveThinking;
  theme?: Theme;
  animationFrame: number;
  isStreaming: boolean;
}

interface ThinkingHeadingContext {
  activeThinking: ActiveThinking | undefined;
  completedMs: number | undefined;
  isActive: boolean;
  latestSummary: SummaryPart | undefined;
  hiddenThinkingLabel: string;
  theme: Theme | undefined;
}

interface ActiveThinkingText {
  text: Text;
  headingContext: ThinkingHeadingContext;
}

interface ThinkingRun {
  startIndex: number;
  endIndex: number;
  thinkingBlocks: string[];
  latestSummary?: SummaryPart;
}

type AssistantContent = AssistantMessage["content"][number];

export class ThinkingRenderer {
  private readonly prototype = AssistantMessageComponent.prototype as PatchedPrototype;
  private readonly originalUpdateContent = this.prototype.updateContent;
  private readonly patchedUpdateContent: PatchedPrototype["updateContent"];
  private readonly renderedComponents = new Set<AssistantMessageComponent>();
  private activeThinkingText: ActiveThinkingText | undefined;
  private activeTheme: Theme | undefined;
  private activeTui: TUI | undefined;
  private activeUi: ExtensionUIContext | undefined;
  private latestComponent: AssistantMessageComponent | undefined;
  private latestComponentTimestamp: number | undefined;
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  private animationFrame = 0;
  private patchInstalled = false;

  constructor(private readonly compactThinking: CompactThinking) {
    const renderer = this;

    this.patchedUpdateContent = function (
      this: AssistantMessageComponent,
      message: AssistantMessage,
      isStreaming?: boolean,
    ) {
      renderer.updateContent(this, message, isStreaming);
    };
  }

  start(ui: ExtensionUIContext) {
    this.prototype.updateContent = this.patchedUpdateContent;
    this.patchInstalled = true;
    this.activeTheme = ui.theme;
    this.activeUi = ui;

    // An empty widget gives the animation loop access to requestRender without
    // enabling terminal mouse reporting or intercepting native scrollback input.
    ui.setWidget(DUMMY_WIDGET_ID, (tui): Component => {
      this.activeTui = tui;
      return { render: (): string[] => [], invalidate() {} };
    });

    this.refresh();
  }

  refresh() {
    if (this.activeTui) {
      // Pi can render a resumed session before rebinding extensions. Invalidate
      // the component tree so those prebuilt components run updateContent again.
      this.activeTui.invalidate();
      this.activeTui.requestRender(true);
      return;
    }

    for (const component of this.renderedComponents) {
      const self = component as unknown as MessageComponentInternals;
      if (self.lastMessage) self.updateContent(self.lastMessage);
    }
  }

  startThinking(message: AssistantMessage) {
    this.activeThinkingText = undefined;
    this.animationFrame = 0;

    // Pi may have rendered the empty thinking_start partial just before this
    // extension receives the event. Re-render it before the first delta arrives.
    if (this.latestComponent && this.latestComponentTimestamp === message.timestamp) {
      const self = this.latestComponent as unknown as MessageComponentInternals;
      self.updateContent(message);
      this.activeTui?.requestRender();
    }

    if (this.animationTimer) {
      clearInterval(this.animationTimer);
    }

    this.animationTimer = setInterval(() => {
      this.animationFrame++;

      if (this.activeThinkingText) {
        this.activeThinkingText.text.setText(
          renderThinkingHeading(this.activeThinkingText.headingContext, this.animationFrame),
        );
      }

      this.activeTui?.requestRender();
    }, config.animationIntervalMs);
  }

  finishThinking(messageTimestamp: number) {
    const component =
      this.latestComponentTimestamp === messageTimestamp ? this.latestComponent : undefined;

    this.activeThinkingText = undefined;
    if (this.animationTimer) clearInterval(this.animationTimer);
    this.animationTimer = undefined;

    if (component) {
      const self = component as unknown as MessageComponentInternals;
      if (self.lastMessage) self.updateContent(self.lastMessage);
    }

    this.activeTui?.requestRender();
  }

  stop() {
    if (this.animationTimer) clearInterval(this.animationTimer);
    this.animationTimer = undefined;
    this.activeUi?.setWidget(DUMMY_WIDGET_ID, undefined);
    this.activeUi = undefined;
    this.activeTui = undefined;
    this.activeTheme = undefined;
    this.latestComponent = undefined;
    this.latestComponentTimestamp = undefined;
    this.renderedComponents.clear();
    this.activeThinkingText = undefined;

    if (this.patchInstalled) {
      this.prototype.updateContent = this.originalUpdateContent;
      this.patchInstalled = false;
    }
  }

  private updateContent(
    component: AssistantMessageComponent,
    message: AssistantMessage,
    isStreaming?: boolean,
  ) {
    const self = component as unknown as MessageComponentInternals;
    const currentIsStreaming = isStreaming ?? self.isStreaming ?? false;
    self.isStreaming = currentIsStreaming;
    self.lastMessage = message;
    this.renderedComponents.add(component);
    this.latestComponent = component;
    this.latestComponentTimestamp = message.timestamp;

    // Visible mode is intentionally untouched: Shift+Tab restores Pi's exact
    // built-in Thinking Markdown renderer, including every OpenAI summary stage.
    if (!self.hideThinkingBlock) {
      if (this.compactThinking.currentThinking?.messageTimestamp === message.timestamp) {
        this.activeThinkingText = undefined;
      }

      this.originalUpdateContent.call(component, message);
      return;
    }

    const renderedThinkingText = renderAssistantMessage(component, this.compactThinking, message, {
      activeThinking: this.compactThinking.currentThinking,
      theme: this.activeTheme,
      animationFrame: this.animationFrame,
      isStreaming: currentIsStreaming,
    });

    if (this.compactThinking.currentThinking?.messageTimestamp === message.timestamp) {
      this.activeThinkingText = renderedThinkingText;
    }
  }
}

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

function animateText(text: string, theme: Theme | undefined, frame: number, bold: boolean): string {
  const style = bold ? styleSummaryTitle : styleThinkingText;

  if (!theme) {
    return style(theme, text);
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

  return style(theme, before) + styledHighlight + style(theme, after);
}

function renderThinkingHeading(context: ThinkingHeadingContext, frame: number): string {
  const { activeThinking, completedMs, isActive, latestSummary, hiddenThinkingLabel, theme } =
    context;
  const elapsedMs = activeThinking ? Math.max(1, Date.now() - activeThinking.startedAt) : undefined;
  const durationMs = isActive ? elapsedMs : completedMs;
  const durationText = durationMs === undefined ? undefined : formatThoughtDuration(durationMs);
  const durationSuffix = durationText ? styleThinkingText(theme, ` · ${durationText}`) : "";

  if (isActive && latestSummary) {
    return animateText(latestSummary.title, theme, frame, true) + durationSuffix;
  }

  if (isActive) {
    const label = hiddenThinkingLabel || "Thinking...";
    return animateText(label, theme, frame, false) + durationSuffix;
  }

  const label = durationText ? `Thought for ${durationText}` : hiddenThinkingLabel || "Thinking...";

  return styleThinkingText(theme, label);
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

function renderThinking(
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
  const headingContext: ThinkingHeadingContext = {
    activeThinking,
    completedMs,
    isActive,
    latestSummary: thinkingRun.latestSummary,
    hiddenThinkingLabel: self.hiddenThinkingLabel,
    theme,
  };
  const headingText = new Text(
    renderThinkingHeading(headingContext, animationFrame),
    self.outputPad,
    0,
  );

  self.contentContainer.addChild(headingText);
  const previewSource = thinkingRun.latestSummary?.body ?? thinkingRun.thinkingBlocks.join("\n\n");

  if (config.previewLines > 0 && previewSource.trim()) {
    self.contentContainer.addChild(
      new ThinkingPreview(previewSource.trim(), self.outputPad, thinkingStyle),
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
    headingContext,
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
    const renderedThinkingText = renderThinking(
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
