# AI Rewrite Design

Date: 2026-06-19

## Goal

Build a new, isolated AI rewrite edition of the existing keyword purifier plugin. The current plugin remains unchanged. The new edition copies the current plugin into a separate folder and adds an optional OpenAI-compatible local rewrite flow for sub-rules that the user marks as AI rewrite rules.

The feature is meant for cases where a direct replacement would be too blunt, such as boilerplate phrasing or over-intense modifiers. Users decide which existing preset sub-rules are handled by normal program replacement and which are handled by AI rewriting.

## Non-Goals

- Do not modify the current root plugin implementation during the design phase.
- Do not add multiple provider abstractions. Only OpenAI-compatible chat completions are in scope.
- Do not call the API during streaming token rendering.
- Do not process user messages, input boxes, global cleanse, or deep cleanse with AI rewrite by default.
- Do not export API keys inside preset JSON files.
- Do not replace the whole message from API output unless a future design explicitly changes that behavior.

## Project Isolation

Implementation will happen in a new folder, for example:

```text
Veridis-Keyword-filtering-ai-rewrite/
```

That folder will be copied from the current plugin and then changed independently. Its `manifest.json` will use a distinct display name and version, such as:

```json
{
  "display_name": "屏蔽词净化助手 AI 改写版",
  "version": "7.0.0-alpha"
}
```

The existing root plugin remains the stable version. Existing untracked folders such as preset examples and annotated guides are not part of this feature unless the user explicitly asks to include them.

## User-Facing Behavior

Each sub-rule gains a processing mode:

- `程序替换`: current behavior. The rule is compiled into the local replacement processors and runs synchronously.
- `AI 改写`: the rule detects matching text but does not perform local replacement. After generation ends, matching fragments are sent to the configured OpenAI-compatible API for localized rewriting.

The sub-rule replacement field keeps its editor but changes meaning in AI mode:

- In program mode, replacements remain literal replacement candidates.
- In AI mode, replacements become rewrite hints or directions, such as "改得自然一点" or "避免夸张副词".

The user can also edit one global prompt template. The template receives variables for the full original message, rewrite items, and rewrite hints.

## Settings

The new edition adds an `aiRewrite` settings object:

```js
aiRewrite: {
  enabled: false,
  baseUrl: "",
  apiKey: "",
  model: "",
  temperature: 0.3,
  timeoutMs: 20000,
  maxItemsPerRequest: 8,
  promptTemplate: "..."
}
```

Migration rules:

- Missing `aiRewrite` settings are filled with defaults.
- Missing sub-rule `rewriteMode` fields default to `"program"`.
- Old presets continue to behave exactly as before.
- Imported old JSON presets are normalized to include the default mode.
- API key is stored only in plugin settings and is not included in preset export.

## Architecture

The existing engine remains responsible for direct replacement, scope tag handling, diff metadata, DOM refresh, and chat saving.

New AI rewrite code should be isolated behind a module boundary, for example:

```text
src/aiRewrite.js
```

Suggested responsibilities:

- collect enabled sub-rules where `rewriteMode === "ai"`
- scan final assistant text for AI-rule matches without replacing text
- extract rewrite fragments around matches
- merge overlapping or duplicate fragments
- build the OpenAI-compatible request payload
- parse and validate JSON responses
- apply accepted rewrites by recorded positions
- guard against stale messages, branch changes, retries, and recursion

Existing `program` rules continue through `buildProcessors()` and `applyScopedReplacements()`. AI rewrite rules must not enter those processors.

## Trigger Flow

AI rewrite only runs after the assistant message has finished generating.

1. The existing non-streaming cleanse path runs first, applying program rules and preserving current diff behavior.
2. The AI rewrite queue checks whether the latest assistant message is eligible:
   - global AI rewrite is enabled
   - base URL, API key, and model are configured
   - the message is an assistant message
   - the message is not reverted or protected from purification
   - at least one enabled AI sub-rule matches
3. Matching fragments are batched into one API request.
4. If valid rewrite results return, the plugin applies local replacements from back to front by recorded positions.
5. The plugin refreshes the message display and saves through the existing incremental save queue.
6. Diff state records the API-rewrite-before text as source and the final local text as cleaned text, so the visual diff can show the rewrite.

The flow never writes during streaming. It does not call `saveChat()` directly.

## Match Extraction

The AI match scanner supports the same target modes as current sub-rules:

- text
- simple
- regex

It records every match with:

- sub-rule identity
- group name
- target or regex that matched
- matched text
- start and end offsets
- rewrite hints from the sub-rule replacements

Fragment extraction uses the match offsets:

- Default fragment unit is the sentence containing the match.
- If sentence boundaries are unreliable, the sentence is too short, or a match spans multiple sentences, expand to the containing paragraph.
- Multiple matches in the same sentence or paragraph are merged.
- Overlapping fragments are merged.
- The number of rewrite items is capped by `maxItemsPerRequest`; excess items are skipped for that request rather than split into multiple automatic calls.

Recorded offsets, not returned strings, are the source of truth for local replacement. This prevents replacing the wrong repeated sentence.

## API Request

The request uses an OpenAI-compatible chat completions endpoint derived from `baseUrl`, such as:

```text
POST {baseUrl}/chat/completions
```

The payload includes:

- `model`
- `temperature`
- messages containing the rendered prompt
- no streaming

The rendered prompt includes:

- the full assistant message as style reference
- a JSON array of rewrite items
- each item id, text, matched terms, rule names, and hints
- strict output instructions

Default prompt intent:

```text
你是文本局部改写助手。你会收到一整条 AI 回复作为文风参考，以及若干需要改写的片段。
只改写 listed fragments，不要扩写、总结、解释或改变剧情事实。
目标是去除命中的八股句式、夸张副词或不自然表达，同时尽量保持原文文风、语气、人物口吻和原意。
必须只返回 JSON，不要返回 markdown。

整条回复：
{{originalMessage}}

需要改写的片段：
{{rewriteItemsJson}}

输出格式：
{"rewrites":[{"id":"hit-1","rewritten":"改写后的片段"}]}
```

## API Response

The API must return JSON:

```json
{
  "rewrites": [
    { "id": "hit-1", "rewritten": "..." },
    { "id": "hit-2", "rewritten": "..." }
  ]
}
```

Validation rules:

- Response must parse as JSON.
- `rewrites` must be an array.
- Each item must reference a known local id.
- `rewritten` must be a non-empty string.
- An item that fails validation is skipped.
- If all items fail, the message is left unchanged.
- The API result is not allowed to trigger a second AI rewrite pass for the same message.

The response does not need to echo `original` exactly. The plugin already knows the replacement ranges.

## Stale Result Protection

Before applying API results, compare the current message against the snapshot taken when the request started.

Discard the result if:

- the chat changed
- the message index now points to a different message
- the active swipe or branch changed
- the message was edited
- the message was reverted
- the message text no longer matches the request snapshot
- another AI rewrite task is already active for the same message

This prevents late API responses from writing into the wrong branch or overwriting user edits.

## Error Handling and Status

Status feedback should be light:

- show "AI 改写中..." when a request starts
- show "AI 改写已应用" when at least one item is applied
- show one concise failure toast when the whole request fails

Failure cases do not block chat use and do not modify the message:

- missing config
- network failure
- timeout
- invalid JSON
- unexpected API response shape
- stale message snapshot
- all rewrite items rejected

Timeout uses `AbortController` and the configured `timeoutMs`.

## UI

UI additions:

- Main panel AI rewrite settings section:
  - enable switch
  - base URL input
  - API key input
  - model input
  - temperature input
  - timeout input
  - max items per request input
  - editable prompt template textarea
- Sub-rule editor processing mode control:
  - `程序替换`
  - `AI 改写`
- In AI mode, replacement field label changes to "改写提示/方向".
- Rule cards show a compact `AI 改写` badge for AI-mode sub-rules.

UI must follow existing `DESIGN.md` constraints:

- preserve current theme variables
- keep mobile and tablet modal behavior
- preserve TauriTavern `data-tt-mobile-surface` annotations on new modals or panels
- avoid changing existing field names purely for copy

## Tests and Checks

Implementation should verify:

- old rules without `rewriteMode` still run as program replacements
- imported old presets normalize correctly
- AI-mode sub-rules do not perform local replacement
- program and AI sub-rules can coexist in the same group
- multiple matching sentences produce one API request
- repeated identical sentences are replaced by position, not by string search
- invalid API JSON leaves the message unchanged
- partial API failures apply only valid items
- stale API responses are discarded
- successful AI rewrite updates message data, current swipe, DOM, diff, and save queue
- visual diff shows API-before to API-after changes
- streaming still only performs visual masking and never writes data

Static checks should include:

```text
node --check index.js
node --check src/core.js
node --check src/events.js
node --check src/ui.js
node --check src/aiRewrite.js
git diff --check
```

Manual checks should include:

- normal SillyTavern generation end
- long reply with several AI-rule matches
- identical repeated matching sentence
- swipe switch before API returns
- user edit before API returns
- AI request timeout
- mobile and tablet settings UI
- existing diff revert and re-cleanse controls

## Open Questions

There are no blocking open questions for the first implementation plan. The first version should keep the scope narrow: one OpenAI-compatible API call after generation end, batch local fragments, and no AI processing for historical/global/deep cleanse.
