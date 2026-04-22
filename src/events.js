import { extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';
import { parseInputToWords, getCurrentCharacterContext } from './utils.js';
import {
    applyPresetByName,
    renderTags,
    updateToolbarUI,
    renderSubrulesToModal,
    showConfirmModal,
    refreshCharacterBindingUI,
    applyCharacterPresetBinding,
    syncSubrulesFromDOM,
    openTransferModal,
    closeTransferModal,
    runRuleTransfer,
    openEditModal,
} from './ui.js';
import {
    buildProcessors,
    performGlobalCleanse,
    applyReplacements,
    applyVisualMask,
    performIncrementalCleanse,
    getMessageIndexFromEvent,
    getLatestMessageIndex,
} from './core.js';
import { performDeepCleanse } from './cleanse.js';
import { purifyDOM, isProtectedNode } from './dom.js';
import { computeMessageSignature, getDiffSnippetsForMessage, getDiffStateForMessage, injectDiffButtons, isAssistantMessage, markDiffComparisonPending, persistTrackedDiffState, resetDiffRuntimeState, restoreDiffStateFromChatMetadata } from './diff.js';

export function initRealtimeInterceptor() {
    let isPurifying = false;

    const resolveNodeMessageIndex = (node) => {
        if (!node || node.nodeType !== 1) return -1;
        const attrs = [node.getAttribute('mesid'), node.getAttribute('data-mesid'), node.getAttribute('messageid'), node.getAttribute('data-message-id')];
        for (const raw of attrs) {
            const n = Number(raw);
            if (Number.isInteger(n) && n >= 0) return n;
        }
        const chatEl = document.getElementById('chat');
        if (!chatEl) return -1;
        const nodes = Array.from(chatEl.querySelectorAll('.mes'));
        return nodes.indexOf(node);
    };

    const collectMessageNodes = (node, bucket) => {
        if (!node || node.nodeType !== 1) return;
        if (node.matches?.('.mes')) bucket.push(node);
        node.querySelectorAll?.('.mes').forEach((mes) => bucket.push(mes));
    };

    const primePendingComparisonForNode = (messageNode, options = {}) => {
        const { chat } = getAppContext();
        const index = resolveNodeMessageIndex(messageNode);
        if (index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return -1;
        markDiffComparisonPending(index, computeMessageSignature(chat[index]), options);
        return index;
    };

    const chatObserver = new MutationObserver((mutations) => {
        if (isPurifying) return;

        const isStreaming = runtimeState.isStreamingGeneration;
        if (!isStreaming) {
            buildProcessors();
            if (runtimeState.activeProcessors.length === 0) return;
        }

        const touchedMessageIndices = new Set();
        isPurifying = true;
        try {
            for (let mi = 0; mi < mutations.length; mi++) {
                const m = mutations[mi];
                for (let ni = 0; ni < m.addedNodes.length; ni++) {
                    const node = m.addedNodes[ni];
                    if (node.nodeType === 3 || node.nodeType === 8) {
                        if (node.parentNode && isProtectedNode(node.parentNode)) continue;
                        const original = node.nodeValue;
                        const nextValue = isStreaming ? applyVisualMask(original) : applyReplacements(original, { deterministic: true });
                        if (original !== nextValue) {
                            node.nodeValue = nextValue;
                            logger.debug(`MutationObserver 文本替换 ${node.nodeType === 3 ? '文本' : '注释'}节点`);
                        }
                    } else if (node.nodeType === 1) {
                        if (!isStreaming) purifyDOM(node);
                        const messageNodes = [];
                        collectMessageNodes(node, messageNodes);
                        messageNodes.forEach((mesNode) => {
                            const index = primePendingComparisonForNode(mesNode, { skipPersist: isStreaming });
                            if (index >= 0) touchedMessageIndices.add(index);
                        });
                    }
                }
                if (m.type === 'characterData') {
                    if (m.target.parentNode && isProtectedNode(m.target.parentNode)) continue;
                    const original = m.target.nodeValue;
                    const nextValue = isStreaming ? applyVisualMask(original) : applyReplacements(original, { deterministic: true });
                    if (original !== nextValue) {
                        m.target.nodeValue = nextValue;
                        logger.debug(`MutationObserver characterData 替换`);
                    }
                }
            }
        } finally {
            chatObserver.takeRecords();
            injectDiffButtonsStreamingSafe([...touchedMessageIndices]);
            isPurifying = false;
        }
    });

    const chatEl = document.getElementById('chat');
    if (chatEl) {
        chatObserver.observe(chatEl, { childList: true, subtree: true, characterData: true });
        logger.info('实时拦截器已启动，MutationObserver 监听 #chat');
    } else {
        logger.warn('实时拦截器启动失败，未找到 #chat 元素');
    }

    let currentTheaterShadow = null;
    const theaterIntervalId = setInterval(() => {
        const theaterHost = document.querySelector('#t-output-content .t-shadow-host');
        if (theaterHost && theaterHost.shadowRoot) {
            if (currentTheaterShadow !== theaterHost) {
                chatObserver.observe(theaterHost.shadowRoot, { childList: true, subtree: true, characterData: true });
                currentTheaterShadow = theaterHost;
                logger.info('检测到剧场模式，已将 MutationObserver 附加到 ShadowRoot');
                isPurifying = true;
                try {
                    purifyDOM(theaterHost.shadowRoot);
                } catch (err) {
                    logger.warn(`剧场模式 purifyDOM 出错`, err);
                } finally {
                    isPurifying = false;
                }
            }
        } else {
            if (currentTheaterShadow !== null) {
                logger.info('剧场模式已退出，ShadowRoot 观察者已断开');
            }
            currentTheaterShadow = null;
        }
    }, 800);
    window.addEventListener('beforeunload', () => clearInterval(theaterIntervalId), { once: true });

    document.addEventListener('input', (e) => {
        const el = e.target;
        if (!['TEXTAREA', 'INPUT'].includes(el.tagName)) return;
        if (isProtectedNode(el)) return;

        buildProcessors();
        if (runtimeState.activeProcessors.length === 0) return;

        const originalVal = el.value || '';
        const cleanedVal = applyReplacements(originalVal, { deterministic: true });

        if (originalVal !== cleanedVal) {
            const start = el.selectionStart;
            isPurifying = true;
            try {
                el.value = cleanedVal;
                try { el.setSelectionRange(start, start); } catch (err) { logger.warn(`setSelectionRange 失败`, err); }
            } finally {
                isPurifying = false;
            }
        }
    }, true);
}

export function bindEvents() {
    const { extension_settings, saveSettingsDebounced, eventSource, event_types } = getAppContext();

    $(document).off('click', '#bl-wand-btn').on('click', '#bl-wand-btn', () => {
        logger.debug('点击了词汇映射工具栏按钮');
        updateToolbarUI();
        renderTags();
        $('#bl-purifier-popup').css('display', 'flex').hide().fadeIn(200);
    });

    $(document).off('click', '#bl-close-btn').on('click', '#bl-close-btn', () => $('#bl-purifier-popup').fadeOut(200));
    const settings = extension_settings[extensionName];
    $('#bl-diff-global-toggle').prop('checked', settings.enableVisualDiff !== false);

    $(document).off('change', '#bl-diff-global-toggle').on('change', '#bl-diff-global-toggle', function() {
        settings.enableVisualDiff = $(this).prop('checked');
        saveSettingsDebounced();
        injectDiffButtons();
    });
    function renderDiffModalContent(index) {
        const { extension_settings } = getAppContext();
        const settings = extension_settings[extensionName];
        const mode = settings.diffViewMode || 'snippet';
        const state = getDiffStateForMessage(index);
        const cached = getDiffSnippetsForMessage(index);
        const contentEl = $('#bl-diff-modal-content');

        if (state.status !== 'ready') {
            contentEl.html(`
                <div class="bl-diff-loading">
                    <i class="fas fa-spinner fa-spin"></i>
                    <span>Loading...</span>
                </div>
            `);
            $('#bl-diff-mode-text').text(mode === 'full' ? '切回片段' : '全文模式');
            $('#bl-diff-mode-icon').attr('class', mode === 'full' ? 'fa-solid fa-list-ul' : 'fa-solid fa-file-lines');
            return;
        }

        if (mode === 'full') {
            const fullHtml = cached.fullDiff || '<div class="bl-diff-empty">当前消息未触发净化差异。</div>';
            contentEl.html(`<div class="bl-diff-full-text">${fullHtml}</div>`);
            $('#bl-diff-mode-text').text('切回片段');
            $('#bl-diff-mode-icon').attr('class', 'fa-solid fa-list-ul');
        } else {
            const html = cached.snippets.length > 0
                ? cached.snippets.join('<hr class="bl-diff-divider">')
                : '<div class="bl-diff-empty">当前消息未触发净化差异。</div>';
            contentEl.html(html);
            $('#bl-diff-mode-text').text('全文模式');
            $('#bl-diff-mode-icon').attr('class', 'fa-solid fa-file-lines');
        }
    }

    runtimeState.diffModalRefresh = (index) => {
        if (runtimeState.currentDiffIndex === undefined) return;
        if (index !== undefined && index !== runtimeState.currentDiffIndex) return;
        if (!$('#bl-diff-modal').is(':visible')) return;
        renderDiffModalContent(runtimeState.currentDiffIndex);
    };

    // ==========================================
    // 新修改的区域开始：透视弹窗按钮与收纳逻辑
    // ==========================================
    $(document).off('click', '.bl-diff-btn').on('click', '.bl-diff-btn', function() {
        const index = Number($(this).attr('data-index'));
        if (!Number.isInteger(index) || index < 0) return;

        // --- 新增：同步收纳按钮的图标和文本状态 ---
        const { extension_settings } = getAppContext();
        const settings = extension_settings[extensionName];
        if (settings.diffButtonInExtraMenu) {
            $('#bl-diff-pos-icon').attr('class', 'fa-solid fa-thumbtack');
            $('#bl-diff-pos-text').text('外显按钮');
        } else {
            $('#bl-diff-pos-icon').attr('class', 'fa-solid fa-ellipsis');
            $('#bl-diff-pos-text').text('收纳按钮');
        }
        // ------------------------------------------

        runtimeState.currentDiffIndex = index;
        renderDiffModalContent(index);
        $('#bl-diff-modal').css('display', 'flex');
    });

    $(document).off('click', '#bl-diff-pos-toggle').on('click', '#bl-diff-pos-toggle', function() {
        const { extension_settings, saveSettingsDebounced } = getAppContext();
        const settings = extension_settings[extensionName];
        
        // 切换布尔值状态并存盘
        settings.diffButtonInExtraMenu = !settings.diffButtonInExtraMenu;
        saveSettingsDebounced();

        // 切换UI显示
        if (settings.diffButtonInExtraMenu) {
            $('#bl-diff-pos-icon').attr('class', 'fa-solid fa-thumbtack');
            $('#bl-diff-pos-text').text('外显按钮');
        } else {
            $('#bl-diff-pos-icon').attr('class', 'fa-solid fa-ellipsis');
            $('#bl-diff-pos-text').text('收纳按钮');
        }

        // 重新渲染当前屏幕上所有的透视按钮层级
        injectDiffButtons();
    });
    // ==========================================
    // 新修改的区域结束
    // ==========================================

    $(document).off('click', '#bl-diff-mode-toggle').on('click', '#bl-diff-mode-toggle', function() {
        const { extension_settings, saveSettingsDebounced } = getAppContext();
        const settings = extension_settings[extensionName];
        settings.diffViewMode = settings.diffViewMode === 'full' ? 'snippet' : 'full';
        saveSettingsDebounced();

        if (runtimeState.currentDiffIndex !== undefined) {
            renderDiffModalContent(runtimeState.currentDiffIndex);
        }
    });

    $(document).off('click', '#bl-diff-modal-close').on('click', '#bl-diff-modal-close', () => $('#bl-diff-modal').hide());
    $(document).off('click', '#bl-diff-modal').on('click', '#bl-diff-modal', function(e) {
        if (e.target && e.target.id === 'bl-diff-modal') $('#bl-diff-modal').hide();
    });
    $(document).off('click', '#bl-open-new-rule-btn').on('click', '#bl-open-new-rule-btn', () => openEditModal(-1));
    $(document).off('click', '.bl-rule-edit').on('click', '.bl-rule-edit', function() { openEditModal($(this).data('index')); });
    $(document).off('click', '.bl-rule-transfer').on('click', '.bl-rule-transfer', function() { openTransferModal($(this).data('index')); });

    $(document).off('click', '.bl-rule-move-up').on('click', '.bl-rule-move-up', function() {
        const index = Number($(this).data('index'));
        const rules = extension_settings[extensionName].rules || [];
        if (index <= 0 || index >= rules.length) return;
        [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
        runtimeState.isRegexDirty = true;
        saveSettingsDebounced();
        renderTags();
    });

    $(document).off('click', '.bl-rule-move-down').on('click', '.bl-rule-move-down', function() {
        const index = Number($(this).data('index'));
        const rules = extension_settings[extensionName].rules || [];
        if (index < 0 || index >= rules.length - 1) return;
        [rules[index], rules[index + 1]] = [rules[index + 1], rules[index]];
        runtimeState.isRegexDirty = true;
        saveSettingsDebounced();
        renderTags();
    });

    $(document).off('change', '.bl-rule-toggle').on('change', '.bl-rule-toggle', function() {
        const index = $(this).data('index');
        extension_settings[extensionName].rules[index].enabled = $(this).prop('checked');
        runtimeState.isRegexDirty = true;
        saveSettingsDebounced();
        renderTags();
        performGlobalCleanse();
    });

    $(document).off('click', '.bl-rule-del').on('click', '.bl-rule-del', function() {
        extension_settings[extensionName].rules.splice($(this).data('index'), 1);
        runtimeState.isRegexDirty = true;
        saveSettingsDebounced();
        renderTags();
    });

    $(document).off('click', '#bl-add-subrule-btn').on('click', '#bl-add-subrule-btn', () => {
        syncSubrulesFromDOM();
        runtimeState.currentEditingSubrules.push({ targets: [], replacements: [], mode: 'simple', isEditing: true });
        renderSubrulesToModal();
        const container = $('#bl-edit-subrules-container');
        container.scrollTop(container[0].scrollHeight);
    });

    $(document).off('click', '.bl-move-subrule-up-btn').on('click', '.bl-move-subrule-up-btn', function() {
        syncSubrulesFromDOM();
        const index = Number($(this).data('index'));
        if (index <= 0 || index >= runtimeState.currentEditingSubrules.length) return;
        [runtimeState.currentEditingSubrules[index - 1], runtimeState.currentEditingSubrules[index]] = [runtimeState.currentEditingSubrules[index], runtimeState.currentEditingSubrules[index - 1]];
        renderSubrulesToModal();
    });

    $(document).off('click', '.bl-move-subrule-down-btn').on('click', '.bl-move-subrule-down-btn', function() {
        syncSubrulesFromDOM();
        const index = Number($(this).data('index'));
        if (index < 0 || index >= runtimeState.currentEditingSubrules.length - 1) return;
        [runtimeState.currentEditingSubrules[index], runtimeState.currentEditingSubrules[index + 1]] = [runtimeState.currentEditingSubrules[index + 1], runtimeState.currentEditingSubrules[index]];
        renderSubrulesToModal();
    });

    $(document).off('click', '.bl-edit-subrule-btn').on('click', '.bl-edit-subrule-btn', function() {
        syncSubrulesFromDOM();
        runtimeState.currentEditingSubrules[$(this).data('index')].isEditing = true;
        renderSubrulesToModal();
    });

    $(document).off('click', '.bl-save-subrule-btn').on('click', '.bl-save-subrule-btn', function() {
        syncSubrulesFromDOM();
        runtimeState.currentEditingSubrules[$(this).data('index')].isEditing = false;
        renderSubrulesToModal();
    });

    $(document).off('change', '.bl-sub-mode').on('change', '.bl-sub-mode', function() {
        const idx = $(this).closest('.bl-subrule-row').find('.bl-save-subrule-btn').data('index');
        syncSubrulesFromDOM();
        runtimeState.currentEditingSubrules[idx].mode = $(this).val();
        renderSubrulesToModal();
    });

    $(document).off('click', '.bl-del-subrule-btn').on('click', '.bl-del-subrule-btn', function() {
        syncSubrulesFromDOM();
        runtimeState.currentEditingSubrules.splice($(this).data('index'), 1);
        renderSubrulesToModal();
    });

    $(document).off('click', '#bl-edit-cancel').on('click', '#bl-edit-cancel', () => $('#bl-rule-edit-modal').hide());
    $(document).off('click', '#bl-transfer-cancel').on('click', '#bl-transfer-cancel', () => closeTransferModal());
    $(document).off('click', '#bl-transfer-copy').on('click', '#bl-transfer-copy', () => runRuleTransfer(false));
    $(document).off('click', '#bl-transfer-move').on('click', '#bl-transfer-move', () => runRuleTransfer(true));
    $(document).off('click', '#bl-rule-transfer-modal').on('click', '#bl-rule-transfer-modal', function(e) {
        if (e.target && e.target.id === 'bl-rule-transfer-modal') closeTransferModal();
    });

    $(document).off('click', '#bl-edit-save').on('click', '#bl-edit-save', () => {
        syncSubrulesFromDOM();
        const nameVal = $('#bl-edit-name').val().trim();

        const validSubrules = runtimeState.currentEditingSubrules.filter(sub => sub.targets.length > 0);
        if (validSubrules.length === 0) {
            alert("至少需要提供一组有效的目标词！(被替换词不能全空)");
            return;
        }

        validSubrules.forEach(sub => delete sub.isEditing);

        let isEnabled = true;
        if (runtimeState.currentEditingIndex !== -1) {
            isEnabled = extension_settings[extensionName].rules[runtimeState.currentEditingIndex].enabled !== false;
        }

        const newRule = {
            name: nameVal || `合集 ${extension_settings[extensionName].rules.length + 1}`,
            subRules: validSubrules,
            enabled: isEnabled
        };

        if (runtimeState.currentEditingIndex === -1) extension_settings[extensionName].rules.push(newRule);
        else extension_settings[extensionName].rules[runtimeState.currentEditingIndex] = newRule;

        runtimeState.isRegexDirty = true;
        saveSettingsDebounced();
        renderTags();
        performGlobalCleanse();
        $('#bl-rule-edit-modal').hide();
    });

    $(document).off('click', '#bl-deep-clean-btn').on('click', '#bl-deep-clean-btn', () => showConfirmModal(() => performDeepCleanse()));

    $(document).off('change', '#bl-preset-select').on('change', '#bl-preset-select', function() {
        applyPresetByName($(this).val(), { skipRender: true });
        renderTags();
        refreshCharacterBindingUI();
    });

    $(document).off('click', '#bl-default-toggle').on('click', '#bl-default-toggle', function() {
        const settings = extension_settings[extensionName];
        const activePreset = String(settings.activePreset || '');
        if (!activePreset) {
            alert('请先在下拉框中选择一个预设。');
            return;
        }
        settings.defaultPreset = settings.defaultPreset === activePreset ? "" : activePreset;
        saveSettingsDebounced();
        refreshCharacterBindingUI();
    });

    $(document).off('click', '#bl-character-bind-toggle').on('click', '#bl-character-bind-toggle', function() {
        const settings = extension_settings[extensionName];
        const activePreset = String(settings.activePreset || '');
        if (!activePreset) {
            alert('请先在下拉框中选择一个预设。');
            return;
        }
        const context = getCurrentCharacterContext();
        if (!context.key) {
            alert('当前页面未识别到可绑定角色。请进入单角色聊天后再绑定。');
            refreshCharacterBindingUI();
            return;
        }

        if (!settings.characterBindings) settings.characterBindings = {};
        const isCurrentlyBound = settings.characterBindings[context.key] === activePreset;
        if (isCurrentlyBound) delete settings.characterBindings[context.key];
        else settings.characterBindings[context.key] = activePreset;

        runtimeState.lastCharacterContextKey = context.key;
        if (!isCurrentlyBound) applyPresetByName(activePreset, { skipRender: true });
        else applyCharacterPresetBinding(true);

        saveSettingsDebounced();
        refreshCharacterBindingUI();
    });

    $(document).off('click', '#bl-preset-rename').on('click', '#bl-preset-rename', function() {
        const settings = extension_settings[extensionName];
        const oldName = settings.activePreset;
        if (!oldName) { alert("当前为临时规则，请先新建存档。"); return; }
        const newName = prompt("输入新存档名称：", oldName);
        if (!newName || newName === oldName) return;
        if (settings.presets[newName]) { alert("存档名称已存在。"); return; }
        settings.presets[newName] = settings.presets[oldName];
        delete settings.presets[oldName];
        if (settings.defaultPreset === oldName) settings.defaultPreset = newName;
        Object.keys(settings.characterBindings || {}).forEach((key) => {
            if (settings.characterBindings[key] === oldName) settings.characterBindings[key] = newName;
        });
        settings.activePreset = newName;
        saveSettingsDebounced();
        updateToolbarUI();
    });

    $(document).off('click', '#bl-preset-delete').on('click', '#bl-preset-delete', function() {
        const settings = extension_settings[extensionName];
        const name = settings.activePreset;
        if (!name) return;
        if (confirm(`确定删除存档 "${name}" 吗？`)) {
            delete settings.presets[name];
            if (settings.defaultPreset === name) settings.defaultPreset = "";
            Object.keys(settings.characterBindings || {}).forEach((key) => {
                if (settings.characterBindings[key] === name) delete settings.characterBindings[key];
            });
            settings.activePreset = "";
            settings.rules = [];
            runtimeState.isRegexDirty = true;
            saveSettingsDebounced();
            renderTags();
            updateToolbarUI();
            performGlobalCleanse();
        }
    });

    $(document).off('click', '#bl-preset-new').on('click', '#bl-preset-new', function() {
        const settings = extension_settings[extensionName];
        const name = prompt("输入新存档名称：");
        if (!name) return;
        if (settings.presets[name]) { alert("存档名称已存在。"); return; }
        settings.presets[name] = JSON.parse(JSON.stringify(settings.rules));
        settings.activePreset = name;
        saveSettingsDebounced();
        updateToolbarUI();
    });

    $(document).off('click', '#bl-preset-save').on('click', '#bl-preset-save', function() {
        const settings = extension_settings[extensionName];
        if (!settings.activePreset) { alert("当前为临时规则，请点击“新建”保存为新存档。"); return; }
        settings.presets[settings.activePreset] = JSON.parse(JSON.stringify(settings.rules));
        saveSettingsDebounced();
        alert("已保存到存档：" + settings.activePreset);
    });

    $(document).off('click', '#bl-preset-export').on('click', '#bl-preset-export', function() {
        const settings = extension_settings[extensionName];
        const data = JSON.stringify(settings.rules, null, 2);
        const blob = new Blob([data], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (settings.activePreset || "临时规则") + ".json";
        a.click();
        URL.revokeObjectURL(url);
    });

    $(document).off('click', '#bl-preset-import').on('click', '#bl-preset-import', function() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = event => {
                try {
                    let importedRules = JSON.parse(event.target.result);
                    if (typeof importedRules === 'object' && !Array.isArray(importedRules) && importedRules.rules) {
                        importedRules = importedRules.rules;
                    }

                    if (!Array.isArray(importedRules)) throw new Error("格式非数组");

                    const defaultName = file.name.replace(/\.json$/i, '');
                    const newName = prompt("导入成功！\n输入存档名称直接保存，或点击取消仅作为临时规则预览：", defaultName);
                    const settings = extension_settings[extensionName];

                    importedRules.forEach((r, idx) => {
                        if (!r.name) r.name = r.targets?.[0] || `未命名合集 ${idx + 1}`;
                        if (r.enabled === undefined) r.enabled = true;
                        if (r.targets) {
                            r.subRules = [{ targets: r.targets, replacements: r.replacements || [], mode: 'text' }];
                            delete r.targets;
                            delete r.replacements;
                        }
                        if (!r.subRules) r.subRules = [];
                        r.subRules.forEach(sub => { if (!sub.mode) sub.mode = 'text'; });
                    });

                    settings.rules = importedRules;
                    if (newName) {
                        settings.presets[newName] = JSON.parse(JSON.stringify(importedRules));
                        settings.activePreset = newName;
                    } else {
                        settings.activePreset = "";
                    }

                    runtimeState.isRegexDirty = true;
                    saveSettingsDebounced();
                    renderTags();
                    updateToolbarUI();
                    performGlobalCleanse();
                } catch (err) {
                    alert("导入失败：检查文件是否为合法规则数组。");
                }
            };
            reader.readAsText(file);
        };
        input.click();
    });
    // ==========================================
    // 流式期间性能优化：批量 diff 按钮注入 + 延迟持久化
    // ==========================================
    let streamingDiffInjectTimer = null;
    let streamingPendingDiffIndices = [];

    const injectDiffButtonsStreamingSafe = (indices = []) => {
        if (runtimeState.isStreamingGeneration) {
            indices.forEach(i => { if (!streamingPendingDiffIndices.includes(i)) streamingPendingDiffIndices.push(i); });
            if (streamingDiffInjectTimer) return;
            streamingDiffInjectTimer = setTimeout(() => {
                streamingDiffInjectTimer = null;
                const pending = [...streamingPendingDiffIndices];
                streamingPendingDiffIndices = [];
                if (pending.length > 0) injectDiffButtons(pending);
            }, 100);
        } else {
            if (indices.length > 0) injectDiffButtons(indices);
        }
    };

    let streamingPersistTimer = null;
    const scheduleStreamingPersist = () => {
        if (streamingPersistTimer) return;
        streamingPersistTimer = setTimeout(() => {
            streamingPersistTimer = null;
            persistTrackedDiffState();
        }, 200);
    };
    // ==========================================

    const markPendingFromPayload = (payload, options = {}) => {
        const { chat } = getAppContext();
        let index = getMessageIndexFromEvent(payload);
        if (index < 0) index = getLatestMessageIndex();
        if (index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return;
        markDiffComparisonPending(index, computeMessageSignature(chat[index]), options);
        if (options.skipInject !== true) injectDiffButtonsStreamingSafe([index]);
    };

    const visualMaskLatestOnly = (payload) => {
        if (!runtimeState.isStreamingGeneration) return;
        markPendingFromPayload(payload, { skipPersist: true, skipInject: true });
        performIncrementalCleanse(payload, { visualOnly: true, fallbackLatest: true, skipPurifyDom: true });
    };

    let delayedCleanseTimer = null;
    let settleCleanseTimer = null;
    const delayedIncrementalCleanse = (payload) => {
        runtimeState.isStreamingGeneration = false;
        markPendingFromPayload(payload, { skipPersist: false });
        if (delayedCleanseTimer) clearTimeout(delayedCleanseTimer);
        if (settleCleanseTimer) clearTimeout(settleCleanseTimer);
        delayedCleanseTimer = setTimeout(() => {
            performIncrementalCleanse(payload, { visualOnly: false, fallbackLatest: true });
        }, 150);
        settleCleanseTimer = setTimeout(() => {
            performIncrementalCleanse(payload, { visualOnly: false, fallbackLatest: true });
        }, 700);
    };

    let editCleanseTimer = null;
    if (event_types.MESSAGE_EDITED) {
        eventSource.on(event_types.MESSAGE_EDITED, (payload) => {
            markPendingFromPayload(payload);
            if (editCleanseTimer) clearTimeout(editCleanseTimer);
            editCleanseTimer = setTimeout(() => {
                performIncrementalCleanse(payload, { visualOnly: false, fallbackLatest: true });
            }, 100);
        });
    }

    if (event_types.GENERATION_STARTED) eventSource.on(event_types.GENERATION_STARTED, () => {
        runtimeState.isStreamingGeneration = true;
        logger.debug('事件: GENERATION_STARTED');
    });
    if (event_types.STREAM_TOKEN_RECEIVED) {
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, (payload) => {
            runtimeState.isStreamingGeneration = true;
            logger.debug(`事件: STREAM_TOKEN_RECEIVED`);
        });
    }
    if (event_types.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, (payload) => {
        logger.debug('事件: GENERATION_ENDED');
        delayedIncrementalCleanse(payload);
    });
    if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, (payload) => {
        logger.debug('事件: GENERATION_STOPPED');
        delayedIncrementalCleanse(payload);
    });
    if (event_types.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, (payload) => {
        logger.debug('事件: MESSAGE_RECEIVED');
        delayedIncrementalCleanse(payload);
    });
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, (payload) => {
        logger.debug('事件: MESSAGE_SWIPED');
        delayedIncrementalCleanse(payload);
    });
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            logger.info('事件: CHAT_CHANGED，聊天已切换');
            resetDiffRuntimeState();
            runtimeState.currentDiffIndex = undefined;
            $('#bl-diff-modal').hide();
            applyCharacterPresetBinding(true, { skipCleanse: true });
            restoreDiffStateFromChatMetadata();
            setTimeout(() => {
                injectDiffButtons();
                performGlobalCleanse();
            }, 120);
        });
    }

    setInterval(() => applyCharacterPresetBinding(false, { skipCleanse: true }), 1200);
}
