import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { config } from "./lib/config.ts";
import {
  DURATION_ENTRY_TYPE,
  restoreDurationEntries,
} from "./lib/durations.ts";
import {
  formatThoughtDuration,
  StrictThinkingPreview,
} from "./lib/preview.ts";
import {
  getLatestOpenAiSummary,
  isOpenAiResponsesMessage,
  parseLatestStreamingSummary,
} from "./lib/summaries.ts";
import type {
  ActiveThinking,
  AssistantInternals,
  DurationEntryData,
  PatchedPrototype,
  SummaryPart,
} from "./lib/types.ts";

const WIDGET_ID = "compact-thinking-render-loop";

export default function compactThinking(pi: ExtensionAPI) {
  const prototype = AssistantMessageComponent.prototype as PatchedPrototype;
  const originalUpdateContent = prototype.updateContent;

  const completedDurations = new Map<number, Map<number, number>>();
  const renderedComponents = new Set<AssistantMessageComponent>();
  const streamingComponents = new Set<AssistantMessageComponent>();
  let activeThinking: ActiveThinking | undefined;
  let activeTheme: Theme | undefined;
  let activeTui: TUI | undefined;
  let latestComponent: AssistantMessageComponent | undefined;
  let latestComponentTimestamp: number | undefined;
  let animationTimer: ReturnType<typeof setInterval> | undefined;
  let animationFrame = 0;
  let patchInstalled = true;

  function refreshRenderedComponents() {
    for (const component of renderedComponents) {
      const self = component as unknown as AssistantInternals;
      if (self.lastMessage) self.updateContent(self.lastMessage);
    }
    activeTui?.requestRender(true);
  }

  function thinkingStyle(text: string) {
    return activeTheme
      ? activeTheme.italic(activeTheme.fg("thinkingText", text))
      : text;
  }

  function summaryTitleStyle(text: string) {
    return activeTheme
      ? activeTheme.italic(
          activeTheme.bold(activeTheme.fg("thinkingText", text)),
        )
      : text;
  }

  function animatedText(
    text: string,
    baseStyle: (value: string) => string,
    animate: boolean,
  ) {
    if (!animate || !activeTheme) return baseStyle(text);

    const characters = Array.from(text);
    if (characters.length === 0) return "";
    const highlightWidth = Math.max(
      1,
      Math.min(5, Math.ceil(characters.length * 0.28)),
    );
    const start =
      (animationFrame % (characters.length + highlightWidth)) - highlightWidth;
    const end = start + highlightWidth;
    const before = characters.slice(0, Math.max(0, start)).join("");
    const highlighted = characters
      .slice(Math.max(0, start), Math.min(characters.length, end))
      .join("");
    const after = characters.slice(Math.max(0, end)).join("");

    return (
      baseStyle(before) +
      (highlighted
        ? activeTheme.italic(
            activeTheme.bold(activeTheme.fg("text", highlighted)),
          )
        : "") +
      baseStyle(after)
    );
  }

  function getCompletedDuration(
    messageTimestamp: number,
    startIndex: number,
    endIndex: number,
  ) {
    const durations = completedDurations.get(messageTimestamp);
    if (!durations) return undefined;
    for (let index = endIndex; index >= startIndex; index--) {
      const duration = durations.get(index);
      if (duration !== undefined) return duration;
    }
    return undefined;
  }

  function isActiveRun(
    message: AssistantMessage,
    startIndex: number,
    endIndex: number,
  ) {
    return (
      activeThinking?.messageTimestamp === message.timestamp &&
      activeThinking.contentIndex >= startIndex &&
      activeThinking.contentIndex <= endIndex
    );
  }

  prototype.updateContent = function patchedUpdateContent(
    message: AssistantMessage,
  ) {
    const component = this as AssistantMessageComponent;
    const self = this as unknown as AssistantInternals;
    self.lastMessage = message;
    renderedComponents.add(component);
    latestComponent = component;
    latestComponentTimestamp = message.timestamp;

    // Visible mode is intentionally untouched: Shift+Tab restores Pi's exact
    // built-in Thinking Markdown renderer, including every OpenAI summary stage.
    if (!self.hideThinkingBlock) {
      originalUpdateContent.call(this, message);
      return;
    }

    if (activeThinking?.messageTimestamp === message.timestamp) {
      streamingComponents.add(component);
    }

    self.contentContainer.clear();
    const hasActiveThinking =
      activeThinking?.messageTimestamp === message.timestamp &&
      message.content.some((content) => content.type === "thinking");
    const hasVisibleContent =
      hasActiveThinking ||
      message.content.some(
        (content) =>
          (content.type === "text" && content.text.trim()) ||
          (content.type === "thinking" && content.thinking.trim()),
      );
    // Reserve Pi's normal leading spacer even before the first thinking token.
    // This prevents the placeholder heading from jumping down one row when
    // summary/body content begins streaming.
    if (hasVisibleContent) self.contentContainer.addChild(new Spacer(1));

    for (let i = 0; i < message.content.length; i++) {
      const content = message.content[i];

      if (content.type === "text" && content.text.trim()) {
        self.contentContainer.addChild(
          new Markdown(content.text.trim(), self.outputPad, 0, self.markdownTheme),
        );
        continue;
      }

      if (content.type !== "thinking") continue;

      const runStartIndex = i;
      const hasVisibleContentBefore = message.content
        .slice(0, runStartIndex)
        .some(
          (previous) =>
            (previous.type === "text" && previous.text.trim()) ||
            (previous.type === "thinking" && previous.thinking.trim()),
        );
      const thinkingBlocks: string[] = [];
      let latestSummary: SummaryPart | undefined;
      for (; i < message.content.length; i++) {
        const thinkingContent = message.content[i];
        if (thinkingContent.type !== "thinking") break;
        const thinking = thinkingContent.thinking.trim();
        if (!thinking) continue;
        thinkingBlocks.push(thinking);

        if (
          config.useSummaryTitlesAsThinkingTitle &&
          isOpenAiResponsesMessage(message)
        ) {
          const contentIsActive =
            activeThinking?.messageTimestamp === message.timestamp &&
            activeThinking.contentIndex === i;
          // During streaming, thinkingSignature may contain only the previously
          // completed summary parts. Prefer the live text so a newly arriving
          // title immediately replaces the old one instead of appearing in its
          // preview body. Once complete, the structured signature is canonical.
          latestSummary = contentIsActive
            ? parseLatestStreamingSummary(thinking) ??
              getLatestOpenAiSummary(thinkingContent.thinkingSignature) ??
              latestSummary
            : getLatestOpenAiSummary(thinkingContent.thinkingSignature) ??
              parseLatestStreamingSummary(thinking) ??
              latestSummary;
        }
      }
      const runEndIndex = i - 1;
      i--;
      const active = isActiveRun(message, runStartIndex, runEndIndex);
      // OpenAI can spend several seconds reasoning before it emits the first
      // summary token. Keep an empty active block visible as animated
      // "Thinking..." during that otherwise silent interval.
      if (thinkingBlocks.length === 0 && !active) continue;
      if (hasVisibleContentBefore) {
        self.contentContainer.addChild(new Spacer(1));
      }

      const elapsedMs = activeThinking
        ? Math.max(1, Date.now() - activeThinking.startedAt)
        : undefined;
      const completedMs = getCompletedDuration(
        message.timestamp,
        runStartIndex,
        runEndIndex,
      );
      const durationMs = active ? elapsedMs : completedMs;
      const durationText =
        durationMs === undefined ? undefined : formatThoughtDuration(durationMs);

      let heading: string;
      if (active && latestSummary) {
        heading =
          animatedText(latestSummary.title, summaryTitleStyle, true) +
          (durationText ? thinkingStyle(` · ${durationText}`) : "");
      } else if (active) {
        const label = self.hiddenThinkingLabel || "Thinking...";
        heading =
          animatedText(label, thinkingStyle, true) +
          (durationText ? thinkingStyle(` · ${durationText}`) : "");
      } else {
        // Completed compact blocks use one provider-independent status line.
        heading = thinkingStyle(
          durationText
            ? `Thought for ${durationText}`
            : self.hiddenThinkingLabel || "Thinking...",
        );
      }
      self.contentContainer.addChild(new Text(heading, self.outputPad, 0));

      const previewSource = latestSummary?.body ?? thinkingBlocks.join("\n\n");
      if (previewSource.trim()) {
        self.contentContainer.addChild(
          new StrictThinkingPreview(
            previewSource.trim(),
            self.outputPad,
            thinkingStyle,
          ),
        );
      }

      const hasVisibleContentAfter = message.content
        .slice(i + 1)
        .some(
          (next) =>
            (next.type === "text" && next.text.trim()) ||
            (next.type === "thinking" && next.thinking.trim()),
        );
      if (hasVisibleContentAfter) self.contentContainer.addChild(new Spacer(1));
    }

    const hasToolCalls = message.content.some(
      (content) => content.type === "toolCall",
    );
    self.hasToolCalls = hasToolCalls;

    if (message.stopReason === "length") {
      self.contentContainer.addChild(new Spacer(1));
      self.contentContainer.addChild(
        new Text(
          activeTheme
            ? activeTheme.fg(
                "error",
                "Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
              )
            : "Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
          self.outputPad,
          0,
        ),
      );
    } else if (!hasToolCalls) {
      if (message.stopReason === "aborted") {
        const abortMessage =
          message.errorMessage && message.errorMessage !== "Request was aborted"
            ? message.errorMessage
            : "Operation aborted";
        self.contentContainer.addChild(new Spacer(1));
        self.contentContainer.addChild(
          new Text(
            activeTheme ? activeTheme.fg("error", abortMessage) : abortMessage,
            self.outputPad,
            0,
          ),
        );
      } else if (message.stopReason === "error") {
        const errorMessage = message.errorMessage || "Unknown error";
        self.contentContainer.addChild(new Spacer(1));
        self.contentContainer.addChild(
          new Text(
            activeTheme
              ? activeTheme.fg("error", `Error: ${errorMessage}`)
              : `Error: ${errorMessage}`,
            self.outputPad,
            0,
          ),
        );
      }
    }
  };

  function startThinking(message: AssistantMessage, contentIndex: number) {
    activeThinking = {
      messageTimestamp: message.timestamp,
      contentIndex,
      startedAt: Date.now(),
    };
    streamingComponents.clear();
    animationFrame = 0;

    // Depending on event-listener order, Pi may have rendered the empty
    // thinking_start partial just before this extension receives the event.
    // Re-render that component immediately so users do not wait for the first
    // summary delta before seeing the animation.
    if (
      latestComponent &&
      latestComponentTimestamp === message.timestamp
    ) {
      streamingComponents.add(latestComponent);
      const self = latestComponent as unknown as AssistantInternals;
      self.updateContent(message);
      activeTui?.requestRender();
    }

    if (animationTimer) clearInterval(animationTimer);
    animationTimer = setInterval(() => {
      animationFrame++;
      for (const component of streamingComponents) {
        const self = component as unknown as AssistantInternals;
        if (self.lastMessage) self.updateContent(self.lastMessage);
      }
      activeTui?.requestRender();
    }, config.animationIntervalMs);
  }

  function finishThinking() {
    if (!activeThinking) return;
    const finished = activeThinking;
    const durationMs = Math.max(1, Date.now() - finished.startedAt);
    let durations = completedDurations.get(finished.messageTimestamp);
    if (!durations) {
      durations = new Map();
      completedDurations.set(finished.messageTimestamp, durations);
    }
    durations.set(finished.contentIndex, durationMs);
    pi.appendEntry<DurationEntryData>(DURATION_ENTRY_TYPE, {
      messageTimestamp: finished.messageTimestamp,
      contentIndex: finished.contentIndex,
      durationMs,
    });

    activeThinking = undefined;
    if (animationTimer) clearInterval(animationTimer);
    animationTimer = undefined;

    const components = [...streamingComponents];
    streamingComponents.clear();
    for (const component of components) {
      const self = component as unknown as AssistantInternals;
      if (self.lastMessage) self.updateContent(self.lastMessage);
    }
    activeTui?.requestRender();
  }

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    const update = event.assistantMessageEvent;

    if (update.type === "thinking_start") {
      if (
        activeThinking?.messageTimestamp === event.message.timestamp
      ) {
        // Some Responses-compatible providers emit a fresh thinking_start for
        // each summary/reasoning item even though no text or tool boundary has
        // ended the visible Thinking run. Follow the new content block without
        // resetting the run's original start time.
        activeThinking.contentIndex = update.contentIndex;
      } else {
        if (activeThinking) finishThinking();
        startThinking(event.message, update.contentIndex);
      }
    } else if (update.type === "thinking_delta") {
      if (!activeThinking) {
        startThinking(event.message, update.contentIndex);
      } else if (activeThinking.messageTimestamp === event.message.timestamp) {
        activeThinking.contentIndex = update.contentIndex;
      }
    } else if (
      update.type === "text_start" ||
      update.type === "toolcall_start" ||
      update.type === "toolcall_delta"
    ) {
      finishThinking();
    }
    // Do not finalize on thinking_end alone. OpenAI Responses providers can
    // close one reasoning item and immediately open another for the next
    // summary while Pi still renders both as one contiguous Thinking run.
    // A text/tool transition or message_end is the actual visible boundary.
  });

  // OpenAI-compatible providers may not close reasoning until the response ends.
  pi.on("tool_execution_start", finishThinking);
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") finishThinking();
  });

  pi.on("session_start", (_event, ctx) => {
    restoreDurationEntries(ctx.sessionManager.getBranch(), completedDurations);
    activeTheme = ctx.ui.theme;
    if (ctx.mode !== "tui") return;

    // An empty widget gives the animation loop access to requestRender without
    // enabling terminal mouse reporting or intercepting native scrollback input.
    ctx.ui.setWidget(WIDGET_ID, (tui) => {
      activeTui = tui;
      return { render: () => [], invalidate() {} };
    });

    // On resume, Pi may construct the chat before session_start is emitted.
    // Rebuild those already-rendered components now that persisted durations
    // and the active theme are available.
    refreshRenderedComponents();
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreDurationEntries(ctx.sessionManager.getBranch(), completedDurations);
    refreshRenderedComponents();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    finishThinking();
    if (animationTimer) clearInterval(animationTimer);
    animationTimer = undefined;
    activeTui = undefined;
    activeTheme = undefined;
    latestComponent = undefined;
    latestComponentTimestamp = undefined;
    completedDurations.clear();
    renderedComponents.clear();
    streamingComponents.clear();
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_ID, undefined);

    if (patchInstalled) {
      prototype.updateContent = originalUpdateContent;
      patchInstalled = false;
    }
  });
}
