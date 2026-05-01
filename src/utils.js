import { extensionName, getAppContext } from './state.js';
import { logger } from './log.js';

const SIMPLE_WILDCARD_STOP_CHARS = ",，。.!?！？；;\n";
const REGEX_LITERAL_ALLOWED_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);

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

export function buildSimpleWildcardPattern() {
    const escapedStops = SIMPLE_WILDCARD_STOP_CHARS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `[^${escapedStops}]{0,15}?`;
}
