import { extensionName, getAppContext } from './state.js';
import { logger } from './log.js';

const SIMPLE_WILDCARD_STOP_CHARS = ",，。.!?！？；;\n";
const REGEX_LITERAL_ALLOWED_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);
const SCOPE_TAG_START_PATTERN = /^<([A-Za-z][A-Za-z0-9:_-]*)>$/;
const SCOPE_TAG_LABEL_SEPARATOR = '//';
const DEFAULT_SCOPE_TAG_LABEL = '范围';
const BUILTIN_SCOPE_TAG_DEFS = [
    { key: '<UpdateVariable>', startTag: '<UpdateVariable>', label: 'MVU变量' },
    { key: '<horae>', startTag: '<horae>', label: 'horae记忆表格' },
    { key: '<horaeevent>', startTag: '<horaeevent>', label: 'horae记忆表格' },
    { key: '<tableEdit>', startTag: '<tableEdit>', label: '木悠记忆表格' },
];
const BUILTIN_SCOPE_TAG_DEF_MAP = new Map(BUILTIN_SCOPE_TAG_DEFS.map((scopeTagDef) => [scopeTagDef.key, scopeTagDef]));

export function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

export function getCurrentCharacterContext() {
    const { chat_metadata } = getAppContext();
    const normalizeText = (v) => String(v || '').trim();
    const byName = (name, source = 'name') => {
        const clean = normalizeText(name);
        if (!clean) return null;
        return { key: `${source}:${clean}`, name: clean };
    };
    const byId = (id, name = '') => {
        const cleanId = normalizeText(id);
        if (!cleanId) return null;
        return { key: `chid:${cleanId}`, name: normalizeText(name) || `角色#${cleanId}` };
    };

    try {
        const chidRaw = window.this_chid;
        const chid = Number(chidRaw);
        if (Number.isInteger(chid) && chid >= 0 && Array.isArray(window.characters) && window.characters[chid]) {
            const ch = window.characters[chid];
            const name = String(ch.name || ch.ch_name || '').trim();
            return byId(chid, name);
        }
    } catch (e) { logger.warn(`getCurrentCharacterContext: window.this_chid 读取失败`, e); }

    const selectedCard = document.querySelector('.character_select.selected, .group_select.selected, .character_select[chid].active');
    if (selectedCard) {
        const selectedChid = selectedCard.getAttribute('chid') || selectedCard.dataset?.chid || selectedCard.dataset?.id;
        const selectedName = selectedCard.getAttribute('title') || selectedCard.dataset?.name || selectedCard.querySelector('.ch_name, .name_text, .character_name')?.textContent;
        const bySelectedId = byId(selectedChid, selectedName);
        if (bySelectedId) return bySelectedId;
        const bySelectedName = byName(selectedName, 'card');
        if (bySelectedName) return bySelectedName;
    }

    const metadataName = normalizeText(chat_metadata?.character_name || chat_metadata?.name2 || chat_metadata?.ch_name || chat_metadata?.name);
    const fromMetaName = byName(metadataName);
    if (fromMetaName) return fromMetaName;

    const chatMetaId = normalizeText(chat_metadata?.character_id || chat_metadata?.avatar || chat_metadata?.main_chat || chat_metadata?.chat_id);
    const fromMetaId = byId(chatMetaId, metadataName);
    if (fromMetaId) return fromMetaId;

    const headerName = normalizeText(
        document.querySelector('#chat_header .name_text, #rm_info_name, #chat .name_text, #selected_chat_pole .name_text')?.textContent
    );
    const fromHeader = byName(headerName, 'header');
    if (fromHeader) return fromHeader;

    const hashKey = normalizeText(window.location?.hash || '');
    if (hashKey) {
        return { key: `hash:${hashKey}`, name: `当前聊天(${hashKey.slice(0, 24)})` };
    }

    logger.info('未检测到角色上下文（getCurrentCharacterContext 返回空 key）');
    return { key: "", name: "未检测到角色（可先发送一条消息后再试）" };
}

export function getPresetForCharacter(characterKey) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    if (!settings) return "";
    const special = settings.characterBindings?.[characterKey];
    if (special && settings.presets?.[special]) return special;
    if (settings.defaultPreset && settings.presets?.[settings.defaultPreset]) return settings.defaultPreset;
    return "";
}

function findLastUnescapedSlash(text) {
    for (let i = text.length - 1; i > 0; i--) {
        if (text[i] !== '/') continue;
        let backslashCount = 0;
        for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) backslashCount++;
        if (backslashCount % 2 === 0) return i;
    }
    return -1;
}

function normalizeRegexLiteralFlags(rawFlags) {
    let normalizedFlags = '';
    const seen = new Set();
    for (const flag of rawFlags) {
        if (!REGEX_LITERAL_ALLOWED_FLAGS.has(flag)) {
            return { ok: false, error: { message: `包含不支持的 flags：${flag}` } };
        }
        if (seen.has(flag)) {
            return { ok: false, error: { message: `包含重复的 flags：${flag}` } };
        }
        seen.add(flag);
        normalizedFlags += flag;
    }
    if (!seen.has('g')) normalizedFlags += 'g';
    return { ok: true, flags: normalizedFlags };
}

export function compileRegexTarget(target) {
    const source = String(target ?? '').trim();
    if (!source) return { ok: false, error: { message: '规则不能为空。' } };

    let pattern = source;
    let flags = 'gmu';

    if (source.startsWith('/')) {
        const lastSlash = findLastUnescapedSlash(source);
        if (lastSlash <= 0) {
            return { ok: false, error: { message: '不是合法的 /pattern/flags 格式。' } };
        }

        pattern = source.slice(1, lastSlash);
        const normalized = normalizeRegexLiteralFlags(source.slice(lastSlash + 1));
        if (!normalized.ok) return normalized;
        flags = normalized.flags;
    }

    try {
        const regex = new RegExp(pattern, flags);
        const matchesEmptyString = regex.test('');
        regex.lastIndex = 0;
        if (matchesEmptyString) {
            return { ok: false, error: { message: '会匹配空字符串，存在风险，请改写规则。' } };
        }
        return { ok: true, value: { source, pattern, flags, regex } };
    } catch (e) {
        return { ok: false, error: { message: e?.message || '正则表达式语法错误。' } };
    }
}

export function validateRegexTargetInput(text) {
    const parsed = [];
    const lines = String(text ?? '').split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const lineText = String(lines[i] ?? '').trim();
        if (!lineText) continue;

        const compiled = compileRegexTarget(lineText);
        if (!compiled.ok) {
            return {
                ok: false,
                error: {
                    line: i + 1,
                    input: lineText,
                    message: compiled.error.message,
                },
            };
        }

        parsed.push({ line: i + 1, ...compiled.value });
    }

    return { ok: true, parsed };
}

export function parseInputToWords(text, mode = 'text', options = {}) {
    if (!text) return [];
    const isTarget = options.isTarget !== false;
    if (mode === 'regex' || mode === 'simple') {
        const words = text.split('\n').map(w => w.trim());
        return isTarget ? words.filter(w => w) : words;
    }
    const noQuotes = text.replace(/['"‘’”“”]/g, ' ');
    const textWords = isTarget
        ? noQuotes.split(/[\s,，、\n]+/)
        : noQuotes.split(/[,\n，、]/);
    const words = textWords.map(w => w.trim());
    return isTarget ? words.filter(w => w) : words;
}

export function createScopeTagId() {
    return `scope-tag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function parseScopeTagInput(input) {
    const source = String(input ?? '').trim();
    if (!source) {
        return { ok: false, error: { message: '请输入范围标签，例如 <horae> 或 <horae>//horae记忆表格。' } };
    }

    let label = '';
    let tagSource = source;
    const separatorIndex = source.indexOf(SCOPE_TAG_LABEL_SEPARATOR);
    if (separatorIndex >= 0) {
        tagSource = source.slice(0, separatorIndex).trim();
        label = normalizeScopeTagLabel(source.slice(separatorIndex + SCOPE_TAG_LABEL_SEPARATOR.length));
    }

    const match = tagSource.match(SCOPE_TAG_START_PATTERN);
    if (!match) {
        return { ok: false, error: { message: '标签部分仅支持无属性的完整起始标签，例如 <horae>；也可写成 <horae>//备注。' } };
    }

    const tagName = match[1];
    return {
        ok: true,
        value: {
            label,
            tagName,
            startTag: `<${tagName}>`,
            endTag: `</${tagName}>`,
        },
    };
}

function normalizeScopeTagLabel(label) {
    return String(label ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeScopeTagBuiltinKey(rawBuiltinKey = '', startTag = '') {
    const builtinKey = String(rawBuiltinKey ?? '').trim();
    if (BUILTIN_SCOPE_TAG_DEF_MAP.has(builtinKey)) return builtinKey;
    if (BUILTIN_SCOPE_TAG_DEF_MAP.has(startTag)) return startTag;
    return '';
}

export function normalizeScopeTagBuiltinDismissedList(entries) {
    if (!Array.isArray(entries)) return [];
    const seen = new Set();
    const normalized = [];

    entries.forEach((entry) => {
        const builtinKey = normalizeScopeTagBuiltinKey(entry);
        if (!builtinKey || seen.has(builtinKey)) return;
        seen.add(builtinKey);
        normalized.push(builtinKey);
    });

    return normalized;
}

export function formatScopeTagInput(scopeTag) {
    if (!scopeTag || typeof scopeTag !== 'object') return '';
    const startTag = String(scopeTag.startTag ?? '').trim();
    if (!startTag) return '';
    const label = normalizeScopeTagLabel(scopeTag.label);
    return label ? `${startTag}${SCOPE_TAG_LABEL_SEPARATOR}${label}` : startTag;
}

export function getBuiltinScopeTagKeyForStartTag(startTag = '') {
    return normalizeScopeTagBuiltinKey('', String(startTag ?? '').trim());
}

export function normalizeScopeTagEntry(entry, fallbackId = '') {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const rawId = String(entry.id || fallbackId || '');
    const sourceStartTag = String(entry.startTag ?? '').trim();
    const migratedStartTag = sourceStartTag === '<horea>'
        ? '<horaeevent>'
        : sourceStartTag;
    const sourceBuiltinKey = String(entry.builtinKey ?? '').trim();
    const migratedBuiltinKey = sourceBuiltinKey === '<horea>'
        ? '<horaeevent>'
        : sourceBuiltinKey;
    const parsed = parseScopeTagInput(migratedStartTag);
    if (!parsed.ok) return null;
    const builtinKey = normalizeScopeTagBuiltinKey(
        migratedBuiltinKey || (entry.builtin === true && rawId === 'builtin-scope-tag-3' ? '<horaeevent>' : migratedBuiltinKey),
        parsed.value.startTag
    );
    return {
        id: String(entry.id || fallbackId || createScopeTagId()),
        startTag: parsed.value.startTag,
        endTag: parsed.value.endTag,
        label: normalizeScopeTagLabel(entry.label),
        enabled: entry.enabled !== false,
        builtinKey,
        builtin: builtinKey !== '',
    };
}

export function normalizeScopeTagList(entries) {
    if (!Array.isArray(entries)) return [];
    const seen = new Set();
    const seenBuiltinKeys = new Set();
    const normalized = [];

    entries.forEach((entry, index) => {
        const scopeTag = normalizeScopeTagEntry(entry, `scope-tag-${index + 1}`);
        if (!scopeTag || seen.has(scopeTag.startTag)) return;
        if (scopeTag.builtinKey && seenBuiltinKeys.has(scopeTag.builtinKey)) return;
        seen.add(scopeTag.startTag);
        if (scopeTag.builtinKey) seenBuiltinKeys.add(scopeTag.builtinKey);
        normalized.push(scopeTag);
    });

    return normalized;
}

export function getBuiltinScopeTags() {
    return BUILTIN_SCOPE_TAG_DEFS.map((scopeTagDef, index) => {
        const parsed = parseScopeTagInput(scopeTagDef.startTag);
        return {
            id: `builtin-scope-tag-${index + 1}`,
            startTag: parsed.value.startTag,
            endTag: parsed.value.endTag,
            label: scopeTagDef.label,
            enabled: false,
            builtinKey: scopeTagDef.key,
            builtin: true,
        };
    });
}

export function mergeScopeTagsWithBuiltins(entries, dismissedBuiltinKeys = []) {
    const normalizedDismissed = new Set(normalizeScopeTagBuiltinDismissedList(dismissedBuiltinKeys));
    const merged = normalizeScopeTagList(entries);
    const seenBuiltinKeys = new Set(merged.map((scopeTag) => scopeTag.builtinKey).filter(Boolean));

    getBuiltinScopeTags().forEach((scopeTag) => {
        if (normalizedDismissed.has(scopeTag.builtinKey)) return;
        if (seenBuiltinKeys.has(scopeTag.builtinKey)) return;
        merged.push(scopeTag);
    });

    return merged;
}

function isRuleLikeObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Array.isArray(value.subRules)
        || Array.isArray(value.targets)
        || (typeof value.name === 'string' && ('enabled' in value || 'subRules' in value));
}

/**
 * 兼容多种预设导入格式，统一提取为规则数组。
 * 支持原生数组、{ rules }、{ __content__ }、以及带数字键的对象包装。
 * @param {any} payload 导入的 JSON 对象。
 * @returns {Array<object>} 规则数组。
 */
export function normalizeImportedRulesPayload(payload) {
    if (Array.isArray(payload)) return payload;

    if (!payload || typeof payload !== 'object') {
        throw new Error('格式非对象或数组');
    }

    if ('rules' in payload) {
        return normalizeImportedRulesPayload(payload.rules);
    }

    if ('__content__' in payload) {
        return normalizeImportedRulesPayload(payload.__content__);
    }

    if ('content' in payload) {
        return normalizeImportedRulesPayload(payload.content);
    }

    const numericKeys = Object.keys(payload)
        .filter((key) => /^\d+$/.test(key))
        .sort((a, b) => Number(a) - Number(b));
    if (numericKeys.length > 0) {
        const numericRules = numericKeys
            .map((key) => payload[key])
            .filter(isRuleLikeObject);
        if (numericRules.length > 0) return numericRules;
    }

    const candidateRules = Object.entries(payload)
        .filter(([key]) => !String(key).startsWith('_'))
        .map(([, value]) => value)
        .filter(isRuleLikeObject);
    if (candidateRules.length > 0) return candidateRules;

    throw new Error('未识别的预设格式');
}

export function buildSimpleWildcardPattern() {
    const escapedStops = SIMPLE_WILDCARD_STOP_CHARS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `[^${escapedStops}]{0,15}?`;
}
