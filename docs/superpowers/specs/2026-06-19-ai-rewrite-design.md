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

The new edition must also use an independent internal namespace, not only a different manifest display name:

- use a distinct `extensionName`, for example `ultimate_purifier_ai_rewrite`
- derive a distinct `diffMetadataKey` from that extension name
- use distinct localStorage/cache keys for the Chinese variant dictionary
- avoid sharing runtime state with the stable plugin
- rename or namespace DOM ids, CSS selectors, and delegated event selectors so the AI edition does not collide with the stable plugin if both folders are installed

Full namespacing is required for the first implementation. A warning-only side-by-side limitation is not enough, because the current plugin uses many global `#bl-*` ids and delegated `document.off(...).on(...)` handlers that can interfere with another installed copy.

Because the namespace changes, the AI edition should offer a one-time migration path: when its own settings are empty, it may deep-clone rules, presets, bindings, scope tags, and compatibility settings from legacy `ultimate_purifier` settings, then normalize them under the new schema. It must not move or delete the legacy settings.

## User-Facing Behavior

Each sub-rule gains a processing mode:

- `程序替换`: current behavior. The rule is compiled into the local replacement processors and runs synchronously.
- `AI 改写`: the rule does not perform local data replacement after generation ends. It may still participate in the existing streaming visual mask as a temporary rough preview, then matching fragments are sent to the configured OpenAI-compatible API for localized rewriting after generation ends.

The sub-rule replacement field keeps the existing editor and must remain compatible with the current program-replacement meaning:

- In program mode, replacements remain literal replacement candidates.
- In AI mode, replacements are local rough replacement candidates for the existing streaming visual mask. They are also included in the API prompt as local fallback candidates or rewrite direction, but they are not written to message data by the AI-mode rule itself.
- In AI mode, an empty replacement list keeps the existing plugin semantics for streaming rough preview: a visual match is temporarily deleted. This only affects the visual projection; the raw message data remains unchanged for the post-generation API pass.

The user can also edit one global prompt template. The template receives variables for the full original message, rewrite items, and local fallback candidates from the existing replacement rows.

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
  maxContextChars: 12000,
  maxRewriteCharsPerItem: 2000,
  streamingRoughPreview: true,
  promptTemplate: "..."
}
```

Migration rules:

- Missing `aiRewrite` settings are filled with defaults.
- Missing sub-rule `rewriteMode` fields default to `"program"`.
- Old presets continue to behave exactly as before.
- Imported old JSON presets are normalized to include the default mode.
- API key is stored only in plugin settings and is not included in preset export.
- AI rewrite settings are plugin-level settings, not preset-level settings.
- One-time migration from the legacy namespace must not copy any old API key-like field unless it belongs to the new `aiRewrite` schema.

## Architecture

The existing engine remains responsible for direct replacement, scope tag handling, diff metadata, DOM refresh, and chat saving.

New AI rewrite code should be isolated behind a module boundary, for example:

```text
src/aiRewrite.js
```

Suggested responsibilities:

- collect enabled sub-rules where `rewriteMode === "ai"`
- scan final assistant text for AI-rule matches without replacing text
- reuse the same target parsing semantics as the current engine, including text, simple wildcard, regex, and Chinese variant compatibility
- respect the same scope tag mode as normal cleansing, including `protect` and `cleanse-inside`
- extract rewrite fragments around matches
- merge overlapping or duplicate fragments
- build the OpenAI-compatible request payload
- parse and validate JSON responses
- apply accepted rewrites by recorded positions
- guard against stale messages, branch changes, retries, and recursion
- deduplicate requests across repeated host events for the same message source

Existing `program` rules continue through `buildProcessors()` and `applyScopedReplacements()`. AI rewrite rules must not enter the processors that write message data.

The AI scanner should share helper code with the existing rule compiler where practical. If helper extraction is needed, it should be small and covered by checks so regex validation, simple wildcard behavior, and Chinese variant matching do not diverge between program rules and AI rules.

Streaming rough preview must reuse the existing visual purification path rather than implement a second DOM-rewrite system:

- keep `MutationObserver`, `applyVisualMask()`, `purifyDOM()`, and `purifyStreamingMessageDom()` as the visual entry points
- extend processor construction so streaming visual processors can include AI-mode sub-rules when `aiRewrite.streamingRoughPreview !== false`
- continue excluding AI-mode sub-rules from non-streaming data cleanse processors
- preserve the existing `domSafeOnly`, `unsafeRegexOnly`, cross-text-node projection, line-break signature, protected-node, reverted-message, and skip-user-message safeguards
- preserve the current replacement semantics, including random deterministic choice and empty replacement list meaning direct deletion
- do not write rough preview text to `chat[index].mes`, swipes, chat metadata, or saves

This means the AI edition connects to the current streaming replacement feature. It does not create a new rough replacement feature beside it.

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
5. After applying API rewrites, the plugin runs one deterministic program-only cleanse pass over the resulting full message. This catches any normal program-rule terms reintroduced by the API without triggering a second AI rewrite.
6. The plugin refreshes the message display and saves through the existing incremental save queue.
7. Diff state records the earliest available generation source as source and the final local text as cleaned text. If the earliest source is unavailable, fall back to the API-rewrite-before text. This keeps "revert purification" and visual diff semantics aligned with the existing plugin.

The flow never writes during streaming. It does not call `saveChat()` directly.

During streaming, if `streamingRoughPreview` is enabled, AI-mode sub-rules can visually mask the active assistant message through the same `applyVisualMask()` path used by current program rules. This gives the user an immediate rough cleanup while the message streams. The raw message data remains unmodified, so the post-generation AI rewrite still sees the real final text.

After generation ends and before the API returns, the displayed message may continue to show the rough preview via a visual-only DOM pass. That pass must still reuse existing DOM purification helpers and must be reversible by normal message refresh because the rough text is not persisted.

If a new generation starts while an AI rewrite request is in flight, the pending request should be aborted or its result discarded. AI rewrite should not compete with the next message's streaming or save cycle.

Program and AI rules are intentionally separated. Program rules run first, then AI rules scan the resulting final assistant text. If a program rule removes text that an AI rule would otherwise match, the AI rule will not trigger for that removed text; users should not configure duplicate program and AI sub-rules for the same trigger unless they want that ordering.

Streaming rough preview ordering follows the existing program replacement order. It is only a visual projection, so it must not change the source text used for API match extraction or diff metadata.

Repeated host events must not create repeated API calls for the same source. The AI rewrite queue should deduplicate by message index, branch key, source signature, active preset, and a rules/settings version token. If a later event has the same dedupe key while a request is pending or already applied, it should not send another request.

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
- local rough replacement candidates from the sub-rule replacements

Fragment extraction uses the match offsets:

- Default fragment unit is the sentence containing the match.
- If sentence boundaries are unreliable, the sentence is too short, or a match spans multiple sentences, expand to the containing paragraph.
- Multiple matches in the same sentence or paragraph are merged.
- Overlapping fragments are merged.
- The number of rewrite items is capped by `maxItemsPerRequest`; excess items are skipped for that request rather than split into multiple automatic calls.

Recorded offsets, not returned strings, are the source of truth for local replacement. This prevents replacing the wrong repeated sentence.

Sentence and paragraph extraction should be conservative:

- Chinese and English sentence endings both count, including `。！？!?;；`.
- Closing quotes and brackets after a sentence ending stay with the same fragment.
- A list item or standalone line should usually stay within that line unless the match clearly spans lines.
- A colon-led dialogue or label line should not automatically consume the following paragraph.
- URL-like text, inline code, fenced code blocks, and tag bodies excluded by scope rules must not be split into rewrite fragments.
- When uncertain, expand to the smallest containing paragraph rather than crossing unrelated paragraphs.

Scope and safety rules:

- In `protect` mode, protected tag bodies are not scanned and are not sent as rewrite items.
- In `cleanse-inside` mode, only enabled tag bodies are scanned for rewrite items; text outside those tags is not rewritten.
- Unclosed tags follow the same behavior as current scoped replacement.
- AI scanning must skip rules that would create empty-string matches.
- Invalid regex targets are ignored and surfaced through the same validation path as current regex rules.
- Regex AI rules may use the existing `$1` replacement-template behavior for streaming rough preview, because that is part of the current program replacement feature. For the API prompt, those replacement rows are passed as local fallback candidates or hints; the API is not required to apply them literally.
- Fenced code blocks and inline code should not be selected as rewrite items in the first version, because localized prose rewriting can corrupt code-like content.

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

Endpoint handling:

- trim trailing slashes from `baseUrl`
- append `/chat/completions` unless the configured URL already ends with a compatible chat completions path
- treat non-2xx HTTP responses as failures
- do not require provider-specific features such as `response_format`, because many OpenAI-compatible gateways do not support the same option set

The rendered prompt includes:

- the full assistant message as style reference
- a JSON array of rewrite items
- each item id, text, matched terms, rule names, and local rough replacement candidates
- strict output instructions

Prompt rendering must JSON-serialize rewrite item data rather than hand-build JSON strings. Protected scope bodies should be redacted from the style reference in `protect` mode. If the message exceeds `maxContextChars`, the style reference should be clipped around the rewrite items with clear omission markers instead of sending an unbounded prompt.

The external API receives message text. The UI should make that clear near the enable/API key controls.

The editable prompt template is not the entire safety envelope. The implementation must always wrap or append a non-editable output guard that requires the JSON response shape and forbids explanations, markdown prose, whole-message rewrites, and unrelated edits. Users can customize style instructions, but they should not be able to remove the structural JSON contract accidentally.

API URL safety:

- `https://` is expected for remote API endpoints.
- `http://localhost`, `http://127.0.0.1`, and similar local proxy URLs are allowed.
- non-local `http://` URLs should show a clear warning before saving or enabling AI rewrite.

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

- Response must parse as JSON. The parser may strip one outer markdown fenced-code wrapper such as ```json ... ``` before parsing, because some compatible gateways add it despite instructions.
- Responses with extra prose outside the JSON object, multiple JSON objects, or unrelated text are rejected.
- `rewrites` must be an array.
- Each item must reference a known local id.
- `rewritten` must be a non-empty string.
- `rewritten` must not exceed `maxRewriteCharsPerItem`.
- `rewritten` must not contain obvious JSON or markdown wrapper artifacts.
- An item that fails validation is skipped.
- If all items fail, the message is left unchanged.
- The API result is not allowed to trigger a second AI rewrite pass for the same message.
- The plugin should not automatically retry failed API calls, to avoid duplicate cost and late writes.

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
- the current rules or active preset changed after the request started
- global AI rewrite settings changed after the request started

This prevents late API responses from writing into the wrong branch or overwriting user edits.

In-flight state belongs in `runtimeState`, not chat metadata. Chat metadata should only store the finalized diff state needed for refresh recovery.

The dedupe/applied state should also live in runtime state and be pruned when chats change, rules change, or the tracked message falls outside the diff/message tracking window.

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
  - streaming rough preview switch
  - base URL input
  - API key password input with a reveal/clear affordance
  - model input
  - temperature input
  - timeout input
  - max items per request input
  - max context characters input
  - max rewritten item length input
  - editable prompt template textarea
  - short notice that matched assistant text is sent to the configured external API
  - warning state for non-local `http://` base URLs
- Sub-rule editor processing mode control:
  - `程序替换`
  - `AI 改写`
- In AI mode, replacement field label should make the dual role clear, for example "流式临时替换 / API 参考候选". It must not imply that these rows are only free-form prompt instructions.
- Rule cards show a compact `AI 改写` badge for AI-mode sub-rules.
- If the AI edition detects legacy stable-plugin settings during first setup, expose a clear "copy legacy presets/settings" action or perform one-time copy with a visible confirmation toast.

UI must follow existing `DESIGN.md` constraints:

- preserve current theme variables
- keep mobile and tablet modal behavior
- preserve TauriTavern `data-tt-mobile-surface` annotations on new modals or panels
- avoid changing existing field names purely for copy

## Tests and Checks

Implementation should verify:

- the AI edition uses a distinct settings key, diff metadata key, cache key, DOM namespace, and event namespace
- legacy settings can be copied without mutating the stable plugin settings
- old rules without `rewriteMode` still run as program replacements
- imported old presets normalize correctly
- AI-mode sub-rules do not perform local replacement
- program and AI sub-rules can coexist in the same group
- duplicate program and AI triggers follow the documented program-first ordering
- AI-mode sub-rules can participate in existing streaming visual masking when rough preview is enabled
- streaming rough preview uses the existing `applyVisualMask()` / `purifyStreamingMessageDom()` path, not a separate DOM rewrite engine
- streaming rough preview never writes message data, swipes, diff metadata, or saves
- disabling `streamingRoughPreview` prevents AI-mode sub-rules from visual masking during streaming
- AI-mode empty replacements visually delete matches during streaming rough preview but do not persist that deletion
- multiple matching sentences produce one API request
- repeated generation-end/update events for the same source do not create duplicate API calls
- repeated identical sentences are replaced by position, not by string search
- protected scope tag bodies are not scanned or sent in `protect` mode
- `cleanse-inside` only scans enabled tag bodies
- Chinese variant compatibility affects AI matching when enabled and verified
- invalid or empty-match AI regex/simple rules are ignored safely
- fenced code and inline code are not selected as AI rewrite fragments
- overlong messages are clipped by `maxContextChars`
- overlong rewritten items are rejected
- API output wrapped in a single `json` fenced block is accepted after stripping the wrapper
- API output with prose around JSON is rejected
- invalid API JSON leaves the message unchanged
- non-2xx API responses leave the message unchanged
- partial API failures apply only valid items
- stale API responses are discarded
- rule or preset changes while a request is pending discard the result
- final AI output receives one program-only deterministic cleanse pass and does not trigger another AI pass
- successful AI rewrite updates message data, current swipe, DOM, diff, and save queue
- visual diff shows earliest available generation source to final AI-rewritten text
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
- streaming response with AI-mode rough preview enabled
- streaming response with AI-mode rough preview disabled
- long reply with several AI-rule matches
- several host completion/update events for the same reply
- API result that reintroduces a program-rule target
- identical repeated matching sentence
- swipe switch before API returns
- user edit before API returns
- rule/preset change before API returns
- AI request timeout
- API settings change before API returns
- mobile and tablet settings UI
- existing diff revert and re-cleanse controls

## Open Questions

There are no blocking open questions for the first implementation plan. The first version should keep the scope narrow: one OpenAI-compatible API call after generation end, batch local fragments, and no AI processing for historical/global/deep cleanse.
