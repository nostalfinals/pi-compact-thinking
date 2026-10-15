import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { config } from "./lib/config.ts";
import { CompactThinking } from "./lib/compact-thinking.ts";
import { renderAssistantMessage } from "./lib/renderer.ts";
import type { ActiveThinking, AssistantInternals, PatchedPrototype } from "./lib/types.ts";

const WIDGET_ID = "compact-thinking-render-loop";

export default function compactThinking(pi: ExtensionAPI) {
  const compactThinking = new CompactThinking(pi);

  const prototype = AssistantMessageComponent.prototype as PatchedPrototype;
  const originalUpdateContent = prototype.updateContent;

  const renderedComponents = new Set<AssistantMessageComponent>();
  const streamingComponents = new Set<AssistantMessageComponent>();
  let activeThinking: ActiveThinking | undefined;
  let activeTheme: Theme | undefined;
  let activeTui: TUI | undefined;
  let latestComponent: AssistantMessageComponent | undefined;
  let latestComponentTimestamp: number | undefined;
  let animationTimer: ReturnType<typeof setInterval> | undefined;
  let animationFrame = 0;
  let patchInstalled = false;

  function refreshRenderedComponents() {
    if (activeTui) {
      // Pi renders a resumed session before rebinding extensions. Invalidate
      // the component tree after installing the patch so those prebuilt
      // AssistantMessageComponents run updateContent again.
      activeTui.invalidate();
      activeTui.requestRender(true);
      return;
    }

    for (const component of renderedComponents) {
      const self = component as unknown as AssistantInternals;
      if (self.lastMessage) self.updateContent(self.lastMessage);
    }
  }

  function patchedUpdateContent(
    this: AssistantMessageComponent,
    message: AssistantMessage,
    isStreaming?: boolean,
  ) {
    const component = this as AssistantMessageComponent;
    const self = this as unknown as AssistantInternals;
    const currentIsStreaming = isStreaming ?? self.isStreaming ?? false;
    self.isStreaming = currentIsStreaming;
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

    renderAssistantMessage(component, compactThinking, message, {
      activeThinking,
      theme: activeTheme,
      animationFrame,
      isStreaming: currentIsStreaming,
    });
  }

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
    if (latestComponent && latestComponentTimestamp === message.timestamp) {
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
    compactThinking.saveDuration(finished.messageTimestamp, finished.contentIndex, durationMs);

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
      if (activeThinking?.messageTimestamp === event.message.timestamp) {
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
    if (ctx.mode !== "tui") return;
    prototype.updateContent = patchedUpdateContent;
    patchInstalled = true;
    compactThinking.loadDurationsFromHistory(ctx.sessionManager.getBranch());
    activeTheme = ctx.ui.theme;

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
    compactThinking.loadDurationsFromHistory(ctx.sessionManager.getBranch());
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
    compactThinking.stop();
    renderedComponents.clear();
    streamingComponents.clear();
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_ID, undefined);

    if (patchInstalled) {
      prototype.updateContent = originalUpdateContent;
      patchInstalled = false;
    }
  });
}
