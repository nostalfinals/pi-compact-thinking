# pi-compact-thinking

A [Pi](https://pi.dev/) extension that replaces the built-in `Thinking blocks: hidden` renderer with a compact, animated thinking preview.

<details>
<summary>Take a look</summary>

https://github.com/user-attachments/assets/7c4b2194-501f-4194-9d4e-aac2aa937d0b

</details>

## Installation

```bash
pi install npm:pi-compact-thinking
```

Restart Pi after installation.

## Compatibility

Tested with Pi `0.80.10`.

This extension monkey-patches Pi's internal assistant-message renderer. Internal UI APIs may change in future Pi releases, so the extension may require updates after upgrading Pi.

## Configuration

The configuration file is created automatically the first time the extension loads. Its location is:

- `$PI_CODING_AGENT_DIR/compact-thinking.json`, when `PI_CODING_AGENT_DIR` is set; otherwise
- `~/.pi/agent/compact-thinking.json`.

```json
{
  "useSummaryTitlesAsThinkingTitle": true,
  "previewLines": 3,
  "animationIntervalMs": 90
}
```

- `useSummaryTitlesAsThinkingTitle`: For OpenAI models, uses the latest reasoning-summary heading as the live compact thinking title.
- `previewLines`: Maximum number of rendered reasoning-preview lines to retain in `Thinking blocks: hidden` mode.
- `animationIntervalMs`: Interval, in milliseconds, between animation frames while the model is reasoning.

It is also recommended to set `hideThinkingBlock` to `true` in Pi's settings to enable compact thinking by default.

Restart Pi or reload the extension after changing the configuration.
