import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompactThinkingConfig } from "./types.ts";

const DEFAULT_CONFIG: CompactThinkingConfig = {
  useSummaryTitlesAsThinkingTitle: true,
  previewLines: 3,
  animationIntervalMs: 90,
};

const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

function loadConfig(): CompactThinkingConfig {
  const path = join(AGENT_DIR, "compact-thinking.json");

  if (!existsSync(path)) {
    mkdirSync(AGENT_DIR, { recursive: true });
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  }

  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CompactThinkingConfig>;
  if (
    typeof value.useSummaryTitlesAsThinkingTitle !== "boolean" ||
    !Number.isInteger(value.previewLines) ||
    (value.previewLines ?? 0) < 1 ||
    !Number.isFinite(value.animationIntervalMs) ||
    (value.animationIntervalMs ?? 0) < 1
  ) {
    throw new Error(`Invalid compact-thinking configuration: ${path}`);
  }
  return value as CompactThinkingConfig;
}

export const config = loadConfig();
