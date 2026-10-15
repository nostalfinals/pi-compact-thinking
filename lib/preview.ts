import { getKeybindings, Text, type Component } from "@earendil-works/pi-tui";
import { config } from "./config.ts";

export function formatThoughtDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function getThinkingToggleHint(): string | undefined {
  const keys = getKeybindings().getKeys("app.thinking.toggle");
  return keys.length > 0 ? `${keys.join("/")} to expand` : undefined;
}

export class ThinkingPreview implements Component {
  private readonly text: string;
  private padding: number;
  private style: (text: string) => string;

  private cache?: {
    width: number;
    lines: string[];
  };

  constructor(text: string, padding: number, style: (text: string) => string) {
    this.text = text;
    this.padding = padding;
    this.style = style;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) {
      return this.cache.lines;
    }

    const lines = new Text(this.style(this.text), this.padding, 0).render(width);
    let result: string[];
    if (lines.length <= config.previewLines) {
      result = lines;
    } else {
      const hiddenLines = lines.length - config.previewLines;
      const noun = hiddenLines === 1 ? "line" : "lines";
      const toggleHint = getThinkingToggleHint();
      const hint = `... (${hiddenLines} more ${noun}${toggleHint ? `, ${toggleHint}` : ""})`;
      const hintLines = new Text(this.style(hint), this.padding, 0).render(width);
      result = [...hintLines, ...lines.slice(-config.previewLines)];
    }

    this.cache = { width, lines: result };

    return result;
  }

  invalidate() {
    this.cache = undefined;
  }
}
