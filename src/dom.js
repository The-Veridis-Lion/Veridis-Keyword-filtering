import { getAppContext, runtimeState } from './state.js';
import { applyReplacements, applyVisualMask, buildProcessors } from './core.js';

/**
 * 判断节点是否位于宿主应用的脚本编辑弹窗中。
 * 该弹窗可能同时存在多个实例，但内部结构一致，因此使用稳定的结构特征做匹配。
 * @param {Element} node 待检查节点。
 * @returns {boolean} true 表示节点位于脚本编辑弹窗内。
 */
function isScriptEditorDialogNode(node) {
    if (!node || !node.closest) return false;
    const dialog = node.closest('[role="dialog"], .popup, .vfm__content');
    if (!dialog) return false;
    return Boolean(
        dialog.querySelector('.TH-script-editor-container')
        && dialog.querySelector('#TH-script-editor-button-enabled-toggle')
        && dialog.querySelector('.text_pole')
    );
}

/**
 * 判断节点是否属于宿主应用的正则脚本编辑字段。
 * 同一套字段会出现在全局预设、角色卡等不同位置，因此按字段类名和占位标识匹配。
 * @param {Element} node 待检查节点。
 * @returns {boolean} true 表示节点属于正则编辑字段。
 */
function isRegexScriptEditorNode(node) {
    if (!node || !node.matches) return false;
    const regexFieldSelector = [
        '.regex_script_name',
        '.find_regex',
        '.regex_replace_string',
        '.regex_trim_strings',
        '[data-i18n*="ext_regex_replace_string_placeholder"]',
        '[data-i18n*="ext_regex_trim_placeholder"]',
    ].join(', ');
    if (node.matches(regexFieldSelector)) return true;

    const placeholder = typeof node.getAttribute === 'function' ? String(node.getAttribute('placeholder') || '') : '';
    return placeholder.includes('使用 {{match}}')
        || placeholder.includes('查找正则表达式')
        || placeholder.includes('全局修剪正则表达式匹配');
}

/**
 * 判断节点是否属于受保护区域。
 * @param {Element} node 待检查节点。
 * @returns {boolean} true 表示应跳过净化。
 */
export function isProtectedNode(node) {
    if (!node || !node.closest) return false;
    if (node.closest('.name_text')) return true;
    if (node.closest('#bl-purifier-popup, #bl-batch-popup, #bl-confirm-modal, #bl-rule-edit-modal, #bl-rule-transfer-modal, #bl-diff-modal, #bl-subrule-edit-modal')) return true;
    if (isScriptEditorDialogNode(node)) return true;
    if (isRegexScriptEditorNode(node)) return true;
    if (node.closest('#advanced_formatting, #api_settings')) return true;
    if ((node.id && node.id.includes('shujuku_v120-')) || node.closest('[id*="shujuku_v120-"]')) return true;

    const promptIds = [
        'system_prompt', 'post_history_prompt', 'floating_prompt', 'nsfw_prompt', 'author_note', 'jailbreak_prompt',
        'chat_completions_system_prompt', 'chat_completions_jailbreak_prompt', 'completion_prompt_manager_popup_entry_form_prompt',
        'completion_prompt_manager_popup_entry_form_name', 'description_textarea', 'personality_textarea', 'scenario_textarea',
        'mes_example_textarea', 'first_mes_textarea', 'creator_notes_textarea'
    ];
    if (node.id && promptIds.includes(node.id)) return true;
    if (node.id && node.id.startsWith('world_entry_content_')) return true;
    const dataFor = typeof node.getAttribute === 'function' ? node.getAttribute('data-for') : '';
    if (dataFor && dataFor.startsWith('world_entry_content_')) return true;
    if (node.tagName === 'TEXTAREA' && node.name === 'comment') return true;
    return false;
}

function isRevertedMessageDomNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const mesNode = node.matches?.('.mes') ? node : node.closest?.('.mes');
    if (!mesNode) return false;
    const index = resolveMessageIndexFromDomNode(mesNode);
    const { chat } = getAppContext();
    const msg = Array.isArray(chat) ? chat[index] : null;
    return msg?.__bl_is_reverted === true;
}

/**
 * 对指定 DOM 子树执行净化替换。
 * @param {Node} rootNode 待净化根节点。
 * @returns {void}
 */
export function purifyDOM(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 1 && isRevertedMessageDomNode(rootNode)) return;
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) return;

    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT, null, false);

let node;
    while (node = walker.nextNode()) {
        const parent = node.parentNode;
        if (parent && (isProtectedNode(parent) || isRevertedMessageDomNode(parent) || (document.activeElement && (document.activeElement === parent || parent.contains(document.activeElement))))) continue;

        const original = node.nodeValue || '';
        if (original.trim() === '') continue;

        const nextValue = runtimeState.isStreamingGeneration ? applyVisualMask(original) : applyReplacements(original, { deterministic: true });
        if (original !== nextValue) node.nodeValue = nextValue;
    }

    if (rootNode.nodeType === 1) {
        if (rootNode.matches && rootNode.matches('input, textarea')) {
            const input = rootNode;
            if (!(isProtectedNode(input) || isRevertedMessageDomNode(input) || document.activeElement === input)) {
                const originalVal = input.value || '';
                const nextVal = runtimeState.isStreamingGeneration ? applyVisualMask(originalVal) : applyReplacements(originalVal, { deterministic: true });
                if (originalVal !== nextVal) input.value = nextVal;
            }
        }

        if (rootNode.querySelectorAll) {
            const inputs = rootNode.querySelectorAll('input, textarea');
            for (let i = 0; i < inputs.length; i++) {
                const input = inputs[i];
                if (isProtectedNode(input) || isRevertedMessageDomNode(input) || document.activeElement === input) continue;
                const originalVal = input.value || '';
                const nextVal = runtimeState.isStreamingGeneration ? applyVisualMask(originalVal) : applyReplacements(originalVal, { deterministic: true });
                if (originalVal !== nextVal) input.value = nextVal;
            }
        }
    }
}

/**
 * 根据消息索引获取对应 DOM 节点。
 * @param {number} index 消息索引。
 * @returns {Element | null} 对应消息节点，找不到时返回 null。
 */
export function getMessageDomNode(index) {
    const chatEl = document.getElementById('chat');
    if (!chatEl || !Number.isInteger(index) || index < 0) return null;
    const selectors = [`.mes[mesid="${index}"]`, `.mes[data-mesid="${index}"]`, `.mes[messageid="${index}"]`, `.mes[data-message-id="${index}"]`];
    for (const selector of selectors) {
        const node = chatEl.querySelector(selector);
        if (node) return node;
    }
    const allMes = Array.from(chatEl.querySelectorAll('.mes'));
    const byOrder = allMes[index];
    if (byOrder && resolveMessageIndexFromDomNode(byOrder) === index) return byOrder;
    return null;
}

export function isUserMessageDomNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const mesNode = node.matches?.('.mes') ? node : node.closest?.('.mes');
    if (!mesNode) return false;
    return mesNode.getAttribute('is_user') === 'true' || mesNode.dataset?.isUser === 'true';
}

export function isTrackableMessageDomNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const mesNode = node.matches?.('.mes') ? node : node.closest?.('.mes');
    if (!mesNode) return false;
    return !isUserMessageDomNode(mesNode);
}

export function resolveMessageIndexFromDomNode(node) {
    if (!node || node.nodeType !== 1) return -1;
    const mesNode = node.matches?.('.mes') ? node : node.closest?.('.mes');
    if (!mesNode) return -1;

    const attrs = [
        mesNode.getAttribute('mesid'),
        mesNode.getAttribute('data-mesid'),
        mesNode.getAttribute('messageid'),
        mesNode.getAttribute('data-message-id')
    ];

    for (const raw of attrs) {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 0) return n;
    }

    const chatEl = document.getElementById('chat');
    if (!chatEl) return -1;
    const nodes = Array.from(chatEl.querySelectorAll('.mes'));
    const index = nodes.indexOf(mesNode);
    return index >= 0 ? index : -1;
}
