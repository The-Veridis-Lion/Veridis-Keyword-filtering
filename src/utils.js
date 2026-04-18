import { extensionName, getAppContext } from './state.js';

const SIMPLE_WILDCARD_STOP_CHARS = ",，。.!?！？；;\n";

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
    } catch (e) { }

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
