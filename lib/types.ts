import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, type Component } from "@earendil-works/pi-tui";

export interface CompactThinkingConfig {
  useSummaryTitlesAsThinkingTitle: boolean;
  previewLines: number;
  animationIntervalMs: number;
}

export interface DurationEntryData {
  messageTimestamp: number;
  contentIndex: number;
  durationMs: number;
}

export interface SummaryPart {
  title: string;
  body: string;
}

export interface ActiveThinking {
  messageTimestamp: number;
  contentIndex: number;
  startedAt: number;
}

export interface AssistantInternals {
  contentContainer: {
    clear(): void;
    addChild(component: Component): void;
  };
  hideThinkingBlock: boolean;
  markdownTheme: ConstructorParameters<typeof Markdown>[3];
  hiddenThinkingLabel: string;
  outputPad: number;
  lastMessage?: AssistantMessage;
  hasToolCalls: boolean;
  updateContent(message: AssistantMessage): void;
}

export type PatchedPrototype = typeof AssistantMessageComponent.prototype & {
  updateContent: (message: AssistantMessage) => void;
};
