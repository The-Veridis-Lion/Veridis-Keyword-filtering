import { runtimeState } from './state.js';
import { applyReplacements, applyVisualMask, buildProcessors } from './core.js';

/**
 * 判断节点是否属于受保护区域。
 * 保护节点白名单用于避免误杀系统级 UI（插件弹窗、设置面板、提示词编辑区、数据库扩展字段等）。
 * @param {Element} node 待检查节点。
 * @returns {boolean} true 表示应跳过净化。
 */
export function isProtectedNode(node) {
    if (!node || !node.closest) return false;
    if (node.closest('#bl-purifier-popup, #bl-batch-popup, #bl-confirm-modal, #bl-rule-edit-modal, #bl-rule-transfer-modal, #bl-diff-modal')) return true;
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

/**
 * 对指定 DOM 子树执行净化替换（文本节点、注释节点、输入框）。
 * @param {Node} rootNode 待净化根节点。
 * @returns {void}
 */
export function purifyDOM(rootNode) {
    if (!rootNode) return;
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) return;

    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT, null, false);

    let node;
    while (node = walker.nextNode()) {
        const parent = node.parentNode;
        if (parent && (isProtectedNode(parent) || (document.activeElement && (document.activeElement === parent || parent.contains(document.activeElement))))) continue;

        const original = node.nodeValue || '';
        const nextValue = runtimeState.isStreamingGeneration ? applyVisualMask(original) : applyReplacements(original, { deterministic: true });
        if (original !== nextValue) node.nodeValue = nextValue;
    }

    if (rootNode.nodeType === 1) {
        if (rootNode.matches && rootNode.matches('input, textarea')) {
            const input = rootNode;
            if (!(isProtectedNode(input) || document.activeElement === input)) {
                const originalVal = input.value || '';
                const nextVal = runtimeState.isStreamingGeneration ? applyVisualMask(originalVal) : applyReplacements(originalVal, { deterministic: true });
                if (originalVal !== nextVal) input.value = nextVal;
            }
        }

        if (rootNode.querySelectorAll) {
            const inputs = rootNode.querySelectorAll('input, textarea');
            for (let i = 0; i < inputs.length; i++) {
                const input = inputs[i];
                if (isProtectedNode(input) || document.activeElement === input) continue;
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
 * @returns {Element | null} 对应消息节点，找不到时返回最后一条或 null。
 */
export function getMessageDomNode(index) {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return null;
    const selectors = [`.mes[mesid="${index}"]`, `.mes[data-mesid="${index}"]`, `.mes[messageid="${index}"]`, `.mes[data-message-id="${index}"]`];
    for (const selector of selectors) {
        const node = chatEl.querySelector(selector);
        if (node) return node;
    }
    const allMes = chatEl.querySelectorAll('.mes');
    return allMes.length > 0 ? allMes[allMes.length - 1] : null;
}
