import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CompactThinking } from "./lib/compact-thinking.ts";

export default function compactThinking(pi: ExtensionAPI) {
  const compactThinking = new CompactThinking(pi);

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    const update = event.assistantMessageEvent;

    if (update.type === "thinking_start") {
      compactThinking.startThinking(event.message, update.contentIndex);
    } else if (update.type === "thinking_delta") {
      compactThinking.handleThinkingDelta(event.message, update.contentIndex);
    } else if (
      update.type === "text_start" ||
      update.type === "toolcall_start" ||
      update.type === "toolcall_delta"
    ) {
      compactThinking.finishThinking();
    }
    // Do not finalize on thinking_end alone. OpenAI Responses providers can
    // close one reasoning item and immediately open another for the next
    // summary while Pi still renders both as one contiguous Thinking run.
  });

  // OpenAI-compatible providers may not close reasoning until the response ends.
  pi.on("tool_execution_start", () => compactThinking.finishThinking());
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") compactThinking.finishThinking();
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    compactThinking.start(ctx.sessionManager.getBranch(), ctx.ui);
  });

  pi.on("session_tree", (_event, ctx) => {
    compactThinking.reload(ctx.sessionManager.getBranch());
  });

  pi.on("session_shutdown", () => {
    compactThinking.stop();
  });
}
