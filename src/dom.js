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
 * 判断节点是否位于已知宿主插件容器内。
 * 这里不需要真正识别“插件类型”，只要容器 id 稳定，就可以把整个区域视为受保护输入区。
 * @param {Element} node 待检查节点。
 * @returns {boolean} true 表示节点位于已知插件容器内。
 */
function isKnownPluginContainerNode(node) {
    if (!node || !node.closest) return false;
    return Boolean(node.closest('#tavern_helper, #regex_editor_template, #qr--settings, #completion_prompt_manager_popup, #xiaobai_template_editor, #task_editor')); //酒馆助手，正则弹窗，qr，预设，小白角色模板
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
    if (isKnownPluginContainerNode(node)) return true;
    if (isScriptEditorDialogNode(node)) return true;
    if (node.closest('#advanced_formatting, #api_settings')) return true;
    if ((node.id && node.id.includes('shujuku_v120-')) || node.closest('[id*="shujuku_v120-"]')) return true;

    const promptIds = [
        'system_prompt', 'post_history_prompt', 'floating_prompt', 'nsfw_prompt', 'author_note', 'jailbreak_prompt', //预设
        'chat_completions_system_prompt', 'chat_completions_jailbreak_prompt', 'completion_prompt_manager_popup_entry_form_prompt',//预设
        'completion_prompt_manager_popup_entry_form_name', 'description_textarea', 'personality_textarea', 'scenario_textarea',//世界书&人设
        'mes_example_textarea', 'first_mes_textarea', 'creator_notes_textarea', '' //聊天
    ];
    if (node.id && promptIds.includes(node.id)) return true;
    if (node.id && node.id.startsWith('world_entry_content_')) return true;
    if (node.matches?.('.task_name_edit, .task_commands_edit')) return true; //小白任务
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
