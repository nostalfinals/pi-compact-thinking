import { CustomEntry, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const DURATION_ENTRY_TYPE = "compact-thinking-duration";

interface ThinkingDurationData {
  messageTimestamp: number;
  contentIndex: number;
  durationMs: number;
}

export class CompactThinking {
  readonly thinkingDurations = new Map<number, Map<number, number>>();

  constructor(readonly pi: ExtensionAPI) {}

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

  clearDurations() {
    this.thinkingDurations.clear();
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
}
