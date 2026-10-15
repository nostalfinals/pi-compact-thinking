import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type CustomEntry,
  type ExtensionAPI,
  type ExtensionUIContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { ThinkingRenderer } from "./renderer.ts";

export type ActiveThinking = {
  messageTimestamp: number;
  contentIndex: number;
  startedAt: number;
};

const DURATION_ENTRY_TYPE = "compact-thinking-duration";

type ThinkingDurationData = {
  messageTimestamp: number;
  contentIndex: number;
  durationMs: number;
};

export class CompactThinking {
  private readonly thinkingDurations = new Map<number, Map<number, number>>();
  private readonly renderer: ThinkingRenderer;
  private _currentThinking: ActiveThinking | undefined;

  constructor(readonly pi: ExtensionAPI) {
    this.renderer = new ThinkingRenderer(this);
  }

  get currentThinking(): ActiveThinking | undefined {
    return this._currentThinking;
  }

  private set currentThinking(thinking: ActiveThinking | undefined) {
    this._currentThinking = thinking;
  }

  start(entries: SessionEntry[], ui?: ExtensionUIContext) {
    this.loadDurationsFromHistory(entries);
    if (ui) this.renderer.start(ui);
  }

  reload(entries: SessionEntry[]) {
    this.loadDurationsFromHistory(entries);
    this.renderer.refresh();
  }

  startThinking(message: AssistantMessage, contentIndex: number) {
    if (this.currentThinking?.messageTimestamp === message.timestamp) {
      // Some Responses-compatible providers emit a fresh thinking_start for
      // each summary/reasoning item in one visible Thinking run.
      this.currentThinking.contentIndex = contentIndex;
      return;
    }

    this.finishThinking();
    this.currentThinking = {
      messageTimestamp: message.timestamp,
      contentIndex,
      startedAt: Date.now(),
    };
    this.renderer.startThinking(message);
  }

  handleThinkingDelta(message: AssistantMessage, contentIndex: number) {
    if (!this.currentThinking) {
      this.startThinking(message, contentIndex);
    } else if (this.currentThinking.messageTimestamp === message.timestamp) {
      this.currentThinking.contentIndex = contentIndex;
    }
  }

  finishThinking() {
    if (!this.currentThinking) return;

    const finished = this.currentThinking;
    const durationMs = Math.max(1, Date.now() - finished.startedAt);
    this.saveDuration(finished.messageTimestamp, finished.contentIndex, durationMs);
    this.currentThinking = undefined;
    this.renderer.finishThinking(finished.messageTimestamp);
  }

  findDurationsInRange(
    messageTimestamp: number,
    startIndex: number,
    endIndex: number,
  ): number | undefined {
    const durationsInMessage = this.thinkingDurations.get(messageTimestamp);

    if (!durationsInMessage) {
      return undefined;
    }

    for (let i = endIndex; i >= startIndex; i--) {
      const duration = durationsInMessage.get(i);
      if (duration !== undefined) {
        return duration;
      }
    }

    return undefined;
  }

  saveDuration(messageTimestamp: number, thinkingContentIndex: number, durationMs: number) {
    let durationsInMessage = this.thinkingDurations.get(messageTimestamp);

    if (!durationsInMessage) {
      durationsInMessage = new Map();
      this.thinkingDurations.set(messageTimestamp, durationsInMessage);
    }

    durationsInMessage.set(thinkingContentIndex, durationMs);
    this.pi.appendEntry<ThinkingDurationData>(DURATION_ENTRY_TYPE, {
      messageTimestamp,
      contentIndex: thinkingContentIndex,
      durationMs,
    });
  }

  loadDurationsFromHistory(entries: SessionEntry[]) {
    this.thinkingDurations.clear();

    entries.forEach((entry) => {
      if (!this.isValidCustomEntry(entry)) {
        return;
      }

      const data = entry.data as Partial<ThinkingDurationData>;

      if (!this.isValidDurationData(data)) {
        return;
      }

      let durationsInMessage = this.thinkingDurations.get(data.messageTimestamp);

      if (!durationsInMessage) {
        durationsInMessage = new Map();
        this.thinkingDurations.set(data.messageTimestamp, durationsInMessage);
      }

      durationsInMessage.set(data.contentIndex, data.durationMs);
    });
  }

  private isValidCustomEntry(entry: SessionEntry): entry is CustomEntry {
    return (
      entry.type === "custom" &&
      entry.customType === DURATION_ENTRY_TYPE &&
      typeof entry.data === "object"
    );
  }

  private isValidDurationData(data: unknown): data is ThinkingDurationData {
    if (data === null || typeof data !== "object") {
      return false;
    }

    const candidate = data as Partial<ThinkingDurationData>;

    return (
      typeof candidate.messageTimestamp === "number" &&
      Number.isFinite(candidate.messageTimestamp) &&
      typeof candidate.contentIndex === "number" &&
      Number.isInteger(candidate.contentIndex) &&
      typeof candidate.durationMs === "number" &&
      Number.isFinite(candidate.durationMs) &&
      candidate.durationMs >= 1
    );
  }

  stop() {
    this.finishThinking();
    this.renderer.stop();
    this.thinkingDurations.clear();
  }
}
