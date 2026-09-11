import { getKeybindings, Text, type Component } from "@earendil-works/pi-tui";
import { config } from "./config.ts";

export function formatThoughtDuration(durationMs: number) {
  if (durationMs < 1_000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function getThinkingToggleHint() {
  const keys = getKeybindings().getKeys("app.thinking.toggle");
  return keys.length > 0 ? `${keys.join("/")} to expand` : undefined;
}

export class StrictThinkingPreview implements Component {
  private text: string;
  private padding: number;
  private style: (text: string) => string;

  // Cache for rendered output
  private cachedText?: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    text: string,
    padding: number,
    style: (text: string) => string,
  ) {
    this.text = text;
    this.padding = padding;
    this.style = style;
  }

  render(width: number) {
    // Check cache
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
      return this.cachedLines;
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

    // Update cache
    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = result;

    return result;
  }

  invalidate() {
    // Clear cache
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
