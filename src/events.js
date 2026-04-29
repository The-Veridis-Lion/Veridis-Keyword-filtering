import { extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';
import { deepClone, parseInputToWords, getCurrentCharacterContext } from './utils.js';
import {
    applyPresetByName,
    renderTags,
    updateToolbarUI,
    renderSubrulesToModal,
    showConfirmModal,
    refreshCharacterBindingUI,
    applyCharacterPresetBinding,
    openSingleRuleModal,
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

let streamingDiffInjectTimer = null;
let streamingPendingDiffIndices = [];
const ruleObjectIdMap = new WeakMap();
let nextRuleObjectId = 1;

function ensureRuleObjectId(rule) {
    if (!rule || typeof rule !== 'object') return '';
    let id = ruleObjectIdMap.get(rule);
    if (!id) {
        id = `rule-${nextRuleObjectId++}`;
        ruleObjectIdMap.set(rule, id);
    }
    return id;
}

function getRuleIdsByIndexes(rules, indexes) {
    return indexes.map((idx) => rules[idx]).filter(Boolean).map((rule) => ensureRuleObjectId(rule));
}

function getSelectedIndexesFromState(rules) {
    const selectedSet = new Set(runtimeState.batchSelectedRuleIds || []);
    return rules.map((rule, idx) => (selectedSet.has(ensureRuleObjectId(rule)) ? idx : -1)).filter((idx) => idx >= 0);
}

function syncBatchSelectionStateFromDom(rules) {
    const indexes = $('.batch-item-checkbox:checked').map(function() { return Number($(this).data('index')); }).get().filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < rules.length);
    runtimeState.batchSelectedRuleIds = getRuleIdsByIndexes(rules, indexes);
}

function applyBatchSelectionStateToDom(rules) {
    const selectedSet = new Set(runtimeState.batchSelectedRuleIds || []);
    $('.batch-item-checkbox').each(function() {
        const idx = Number($(this).data('index'));
        const rule = rules[idx];
        const checked = Boolean(rule) && selectedSet.has(ensureRuleObjectId(rule));
        $(this).prop('checked', checked);
    });
}

function getBatchOperationContext(clickedIndex, rules) {
    const isBatchMode = $('#bl-purifier-popup').hasClass('is-batch-mode');
    const selectedIndexes = getSelectedIndexesFromState(rules);
    const selectedSet = new Set(selectedIndexes);
    const shouldBatch = isBatchMode && selectedIndexes.length > 1 && selectedSet.has(clickedIndex);
    return { isBatchMode, selectedIndexes, selectedSet, shouldBatch };
}

function shouldBatchTransferRule(clickedIndex, rules) {
    if (!Number.isInteger(clickedIndex) || clickedIndex < 0 || clickedIndex >= rules.length) return false;
    return getBatchOperationContext(clickedIndex, rules).shouldBatch;
}

function deleteSingleRule(rules, index) {
    const deletingRule = rules[index];
    if (!deletingRule) return false;
    const deletingId = ensureRuleObjectId(deletingRule);
    rules.splice(index, 1);
    runtimeState.batchSelectedRuleIds = (runtimeState.batchSelectedRuleIds || []).filter((id) => id !== deletingId);
    return true;
}

function deleteSelectedRules(rules, selectedIndexes) {
    if (!Array.isArray(selectedIndexes) || selectedIndexes.length <= 1) return false;
    const deletingSet = new Set(selectedIndexes);
    const deletingIds = new Set(getRuleIdsByIndexes(rules, selectedIndexes));
    const nextRules = rules.filter((_, idx) => !deletingSet.has(idx));
    rules.splice(0, rules.length, ...nextRules);
    runtimeState.batchSelectedRuleIds = (runtimeState.batchSelectedRuleIds || []).filter((id) => !deletingIds.has(id));
    return true;
}

function handleDeleteRule(index, rules) {
    if (shouldBatchTransferRule(index, rules)) {
        return deleteSelectedRules(rules, getSelectedIndexesFromState(rules));
    }
    return deleteSingleRule(rules, index);
}

function renderTagsPreserveBatchSelection() {
    renderTags();
    const { extension_settings } = getAppContext();
    applyBatchSelectionStateToDom(extension_settings[extensionName]?.rules || []);
}

function batchMoveRules(rules, selectedIndexes, direction) {
    if (selectedIndexes.length <= 1) return false;
    const selectedSet = new Set(selectedIndexes);
    const sorted = [...selectedIndexes].sort((a, b) => a - b);

    if (direction === 'up') {
        if (sorted[0] === 0) return false;
        for (let i = 0; i < sorted.length; i++) {
            const idx = sorted[i];
            const prev = idx - 1;
            if (prev >= 0 && !selectedSet.has(prev)) {
                [rules[prev], rules[idx]] = [rules[idx], rules[prev]];
                selectedSet.delete(idx);
                selectedSet.add(prev);
            }
        }
        return true;
    }

    if (direction === 'down') {
        if (sorted[sorted.length - 1] === rules.length - 1) return false;
        for (let i = sorted.length - 1; i >= 0; i--) {
            const idx = sorted[i];
            const next = idx + 1;
            if (next < rules.length && !selectedSet.has(next)) {
                [rules[idx], rules[next]] = [rules[next], rules[idx]];
                selectedSet.delete(idx);
                selectedSet.add(next);
            }
        }
        return true;
    }
    return false;
}

export function injectDiffButtonsStreamingSafe(indices = []) {
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
}

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
        return Array.from(chatEl.querySelectorAll('.mes')).indexOf(node);
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
    
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) return;
        
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
                        if (original !== nextValue) node.nodeValue = nextValue;
                        } else if (node.nodeType === 1) {
                            purifyDOM(node);
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
                    if (original !== nextValue) m.target.nodeValue = nextValue;
                }
            }
        } finally {
            chatObserver.takeRecords();
            injectDiffButtonsStreamingSafe([...touchedMessageIndices]);
            isPurifying = false;
        }
    });

    const chatEl = document.getElementById('chat');
    if (chatEl) chatObserver.observe(chatEl, { childList: true, subtree: true, characterData: true });

    let currentTheaterShadow = null;
    const theaterIntervalId = setInterval(() => {
        const theaterHost = document.querySelector('#t-output-content .t-shadow-host');
        if (theaterHost && theaterHost.shadowRoot) {
            if (currentTheaterShadow !== theaterHost) {
                chatObserver.observe(theaterHost.shadowRoot, { childList: true, subtree: true, characterData: true });
                currentTheaterShadow = theaterHost;
                isPurifying = true;
                try { purifyDOM(theaterHost.shadowRoot); } catch (err) {} finally { isPurifying = false; }
            }
        } else {
            currentTheaterShadow = null;
        }
    }, 800);
    window.addEventListener('beforeunload', () => clearInterval(theaterIntervalId), { once: true });

    document.addEventListener('input', (e) => {
        const el = e.target;
        if (!['TEXTAREA', 'INPUT'].includes(el.tagName) || isProtectedNode(el)) return;
        buildProcessors();
        if (runtimeState.activeProcessors.length === 0) return;
        const originalVal = el.value || '';
        const cleanedVal = applyReplacements(originalVal, { deterministic: true });
        if (originalVal !== cleanedVal) {
            const start = el.selectionStart;
            isPurifying = true;
            try {
                el.value = cleanedVal;
                try { el.setSelectionRange(start, start); } catch (err) {}
            } finally {
                isPurifying = false;
            }
        }
    }, true);
}

export function bindEvents() {
    const { extension_settings, saveSettingsDebounced, eventSource, event_types } = getAppContext();

    $(document).off('click', '#bl-wand-btn').on('click', '#bl-wand-btn', () => {
        updateToolbarUI();
        renderTags();
        $('#bl-purifier-popup').css('display', 'flex').hide().fadeIn(200);
    });

    $(document).off('click', '#bl-close-btn').on('click', '#bl-close-btn', () => $('#bl-purifier-popup').fadeOut(200));
    const settings = extension_settings[extensionName];

    const applyThemeMode = (mode) => {
        const normalized = ['auto', 'light', 'dark'].includes(mode) ? mode : 'auto';
        settings.themeMode = normalized;
        $('#bl-purifier-popup, .bl-modal-shell, #bl-rule-transfer-modal, #bl-diff-modal').attr('data-bl-theme', normalized);
    };

    applyThemeMode(settings.themeMode || 'auto');

    $(document).off('click', '#bl-theme-toggle').on('click', '#bl-theme-toggle', function() {
        const current = settings.themeMode || 'auto';
        applyThemeMode(current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto');
        saveSettingsDebounced();
    });

    $('#bl-diff-global-toggle').prop('checked', settings.enableVisualDiff !== false);

    $(document).off('change', '#bl-diff-global-toggle').on('change', '#bl-diff-global-toggle', function() {
        settings.enableVisualDiff = $(this).prop('checked');
        saveSettingsDebounced();
        injectDiffButtons();
    });

    $(document).off('click', '#bl-batch-toggle').on('click', '#bl-batch-toggle', function() {
        const $popup = $('#bl-purifier-popup');
        const isBatchMode = !$popup.hasClass('is-batch-mode');
        $popup.toggleClass('is-batch-mode', isBatchMode);
        $('#bl-batch-operations').toggle(isBatchMode);
        $('.batch-checkbox-label').toggle(isBatchMode);
        $(this).toggleClass('active', isBatchMode);
        if (!isBatchMode) {
            $('.batch-item-checkbox').prop('checked', false);
            runtimeState.batchSelectedRuleIds = [];
        }
    });

    $(document).off('click', '#bl-btn-select-all').on('click', '#bl-btn-select-all', () => {
        $('.batch-item-checkbox').prop('checked', true);
        syncBatchSelectionStateFromDom(extension_settings[extensionName].rules || []);
    });

    $(document).off('click', '#bl-btn-select-invert').on('click', '#bl-btn-select-invert', () => {
        $('.batch-item-checkbox').each(function() { $(this).prop('checked', !$(this).prop('checked')); });
        syncBatchSelectionStateFromDom(extension_settings[extensionName].rules || []);
    });

    $(document).off('click', '#bl-btn-batch-transfer').on('click', '#bl-btn-batch-transfer', () => {
        const selectedIndexes = getSelectedIndexesFromState(extension_settings[extensionName].rules || []);
        if (selectedIndexes.length > 0) openTransferModal(selectedIndexes);
    });

    $(document).off('click', '#bl-btn-batch-delete').on('click', '#bl-btn-batch-delete', () => {
        const rules = extension_settings[extensionName].rules || [];
        const selectedIndexes = getSelectedIndexesFromState(rules);
        if (selectedIndexes.length <= 0 || !confirm(`确定要删除选中的 ${selectedIndexes.length} 个规则分组吗？`)) return;
        if (selectedIndexes.length > 1 ? deleteSelectedRules(rules, selectedIndexes) : deleteSingleRule(rules, selectedIndexes[0])) {
            runtimeState.isRegexDirty = true;
            saveSettingsDebounced();
            renderTagsPreserveBatchSelection();
        }
    });

    $(document).off('change', '.batch-item-checkbox').on('change', '.batch-item-checkbox', () => syncBatchSelectionStateFromDom(extension_settings[extensionName].rules || []));

    function renderDiffModalContent(index) {
        const settings = extension_settings[extensionName];
        const mode = settings.diffViewMode || 'snippet';
        const state = getDiffStateForMessage(index);
        const cached = getDiffSnippetsForMessage(index);
        const contentEl = $('#bl-diff-modal-content');

        if (state.status !== 'ready') {
            contentEl.html(`<div class="bl-diff-loading"><i class="fas fa-spinner fa-spin"></i><span>Loading...</span></div>`);
            $('#bl-diff-mode-text').text(mode === 'full' ? '切回片段' : '全文模式');
            $('#bl-diff-mode-icon').attr('class', mode === 'full' ? 'fa-solid fa-list-ul' : 'fa-solid fa-file-lines');
            return;
        }
        if (mode === 'full') {
            contentEl.html(`<div class="bl-diff-full-text">${cached.fullDiff || '<div class="bl-diff-empty">当前消息未触发差异。</div>'}</div>`);
            $('#bl-diff-mode-text').text('切回片段');
            $('#bl-diff-mode-icon').attr('class', 'fa-solid fa-list-ul');
        } else {
            contentEl.html(cached.snippets.length > 0 ? cached.snippets.join('<hr class="bl-diff-divider">') : '<div class="bl-diff-empty">当前消息未触发差异。</div>');
            $('#bl-diff-mode-text').text('全文模式');
            $('#bl-diff-mode-icon').attr('class', 'fa-solid fa-file-lines');
        }
    }

    runtimeState.diffModalRefresh = (index) => {
        if (runtimeState.currentDiffIndex === undefined) return;
        if (index !== undefined && index !== runtimeState.currentDiffIndex) return;
        if ($('#bl-diff-modal').is(':visible')) renderDiffModalContent(runtimeState.currentDiffIndex);
    };

    $(document).off('click', '.bl-diff-btn').on('click', '.bl-diff-btn', function() {
        const index = Number($(this).attr('data-index'));
        if (!Number.isInteger(index) || index < 0) return;
        const settings = extension_settings[extensionName];
        if (settings.diffButtonInExtraMenu) {
            $('#bl-diff-pos-icon').attr('class', 'fa-solid fa-thumbtack');
            $('#bl-diff-pos-text').text('外显按钮');
        } else {
            $('#bl-diff-pos-icon').attr('class', 'fa-solid fa-ellipsis');
            $('#bl-diff-pos-text').text('收纳按钮');
        }
        runtimeState.currentDiffIndex = index;
        renderDiffModalContent(index);
        $('#bl-diff-modal').css('display', 'flex');
    });

    $(document).off('click', '#bl-diff-pos-toggle').on('click', '#bl-diff-pos-toggle', function() {
        const settings = extension_settings[extensionName];
        settings.diffButtonInExtraMenu = !settings.diffButtonInExtraMenu;
        saveSettingsDebounced();
        if (settings.diffButtonInExtraMenu) {
            $('#bl-diff-pos-icon').attr('class', 'fa-solid fa-thumbtack');
            $('#bl-diff-pos-text').text('外显按钮');
        } else {
            $('#bl-diff-pos-icon').attr('class', 'fa-solid fa-ellipsis');
            $('#bl-diff-pos-text').text('收纳按钮');
        }
        injectDiffButtons();
    });

    $(document).off('click', '#bl-diff-mode-toggle').on('click', '#bl-diff-mode-toggle', function() {
        const settings = extension_settings[extensionName];
        settings.diffViewMode = settings.diffViewMode === 'full' ? 'snippet' : 'full';
        saveSettingsDebounced();
        if (runtimeState.currentDiffIndex !== undefined) renderDiffModalContent(runtimeState.currentDiffIndex);
    });

    $(document).off('click', '#bl-diff-modal-close').on('click', '#bl-diff-modal-close', () => $('#bl-diff-modal').hide());
    $(document).off('click', '#bl-diff-modal').on('click', '#bl-diff-modal', function(e) { if (e.target && e.target.id === 'bl-diff-modal') $('#bl-diff-modal').hide(); });
    
    $(document).off('click', '#bl-open-new-rule-btn').on('click', '#bl-open-new-rule-btn', () => openEditModal(-1));
    $(document).off('click', '.bl-rule-edit').on('click', '.bl-rule-edit', function() { openEditModal($(this).data('index')); });
    $(document).off('click', '.bl-rule-transfer').on('click', '.bl-rule-transfer', function() {
        const index = Number($(this).data('index'));
        const rules = extension_settings[extensionName].rules || [];
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        if (shouldBatchTransferRule(index, rules)) openTransferModal(getSelectedIndexesFromState(rules));
        else openTransferModal(index);
    });

    $(document).off('click', '.bl-rule-move-up').on('click', '.bl-rule-move-up', function() {
        const index = Number($(this).data('index'));
        const rules = extension_settings[extensionName].rules || [];
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        const ctx = getBatchOperationContext(index, rules);
        if (ctx.shouldBatch) { if (!batchMoveRules(rules, ctx.selectedIndexes, 'up')) return; }
        else { if (index <= 0) return; [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]]; }
        runtimeState.isRegexDirty = true;
        saveSettingsDebounced();
        renderTagsPreserveBatchSelection();
    });

    $(document).off('click', '.bl-rule-move-down').on('click', '.bl-rule-move-down', function() {
        const index = Number($(this).data('index'));
        const rules = extension_settings[extensionName].rules || [];
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        const ctx = getBatchOperationContext(index, rules);
        if (ctx.shouldBatch) { if (!batchMoveRules(rules, ctx.selectedIndexes, 'down')) return; }
        else { if (index >= rules.length - 1) return; [rules[index], rules[index + 1]] = [rules[index + 1], rules[index]]; }
        runtimeState.isRegexDirty = true;
        saveSettingsDebounced();
        renderTagsPreserveBatchSelection();
    });

    $(document).off('change', '.bl-rule-toggle').on('change', '.bl-rule-toggle', function() {
        const rules = extension_settings[extensionName].rules || [];
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        const targetEnabled = $(this).prop('checked');
        const ctx = getBatchOperationContext(index, rules);
        if (ctx.shouldBatch) ctx.selectedIndexes.forEach((idx) => { rules[idx].enabled = targetEnabled; });
        else rules[index].enabled = targetEnabled;
        runtimeState.isRegexDirty = true;
        saveSettingsDebounced();
        renderTagsPreserveBatchSelection();
        performGlobalCleanse();
    });

    $(document).off('click', '.bl-rule-del').on('click', '.bl-rule-del', function() {
        if (!confirm('确定要删除这个规则分组吗？删除后无法恢复。')) return; 
        const rules = extension_settings[extensionName].rules || [];
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        if (handleDeleteRule(index, rules)) {
            runtimeState.isRegexDirty = true;
            saveSettingsDebounced();
            renderTagsPreserveBatchSelection();
        }
    });

    // ==========================================
    // 独立子映射管理
    // ==========================================
    
    $(document).off('click', '#bl-add-subrule-btn').on('click', '#bl-add-subrule-btn', () => openSingleRuleModal(-1));

    $(document).off('click', '.bl-move-subrule-up-btn').on('click', '.bl-move-subrule-up-btn', function() {
        const index = Number($(this).data('index'));
        if (index <= 0 || index >= runtimeState.currentEditingSubrules.length) return;
        [runtimeState.currentEditingSubrules[index - 1], runtimeState.currentEditingSubrules[index]] = [runtimeState.currentEditingSubrules[index], runtimeState.currentEditingSubrules[index - 1]];
        renderSubrulesToModal();
    });

    $(document).off('click', '.bl-move-subrule-down-btn').on('click', '.bl-move-subrule-down-btn', function() {
        const index = Number($(this).data('index'));
        if (index < 0 || index >= runtimeState.currentEditingSubrules.length - 1) return;
        [runtimeState.currentEditingSubrules[index], runtimeState.currentEditingSubrules[index + 1]] = [runtimeState.currentEditingSubrules[index + 1], runtimeState.currentEditingSubrules[index]];
        renderSubrulesToModal();
    });

    $(document).off('click', '.bl-del-subrule-btn').on('click', '.bl-del-subrule-btn', function() {
        runtimeState.currentEditingSubrules.splice($(this).data('index'), 1);
        renderSubrulesToModal();
    });

    $(document).off('click', '.bl-edit-subrule-btn').on('click', '.bl-edit-subrule-btn', function() {
        openSingleRuleModal($(this).data('index'));
    });

    // ==========================================
    // 独立编辑弹窗事件 (包含备注的快捷修改与保存)
    // ==========================================
    
    $(document).off('click', '.bl-remark-subrule-btn').on('click', '.bl-remark-subrule-btn', function(e) {
        e.preventDefault();
        const index = $(this).data('index');
        const sub = runtimeState.currentEditingSubrules[index];
        const newRemark = prompt("📝 快捷修改规则备注：\n(若不需要备注，请直接清空并点击确定)", sub.remark || '');
        
        if (newRemark !== null) {
            sub.remark = newRemark.trim();
            renderSubrulesToModal(); 
        }
    });

    $(document).off('change', '#bl-modal-sub-mode').on('change', '#bl-modal-sub-mode', function() {
        const mode = $(this).val();
        const $t = $('#bl-modal-sub-target');
        const $r = $('#bl-modal-sub-rep');
        
        if (mode === 'regex') {
            $t.attr('placeholder', "正则匹配规则 (每行一条)\n例如：/(宛若|如同)(神明|恶魔)/g");
            $r.attr('placeholder', "替换后词汇 (每行一条，允许含逗号，可留空)\n支持 $1, $2 捕获组引用");
        } else if (mode === 'simple') {
            $t.attr('placeholder', "简易语法 (每行一条)\n例如：{宛若,如同}{神明,恶魔}?");
            $r.attr('placeholder', "替换后词汇 (每行一条，支持随机，可留空)");
        } else {
            $t.attr('placeholder', "被替换词汇 (逗号/空格分隔)\n例如：嘴角勾起, 并不存在");
            $r.attr('placeholder', "替换后词汇 (逗号/空格分隔，留空直接删除)");
        }
    });

    $(document).off('click', '#bl-modal-sub-save').on('click', '#bl-modal-sub-save', function() {
        const mode = $('#bl-modal-sub-mode').val();
        const tStr = $('#bl-modal-sub-target').val();
        const rStr = $('#bl-modal-sub-rep').val();
        const remarkStr = $('#bl-modal-sub-remark').val().trim();
        
        const targets = parseInputToWords(tStr, mode, { isTarget: true });
        const replacements = parseInputToWords(rStr, mode === 'text' ? 'text' : 'regex', { isTarget: false });

        if (targets.length === 0) {
            alert("查找内容不能为空！");
            return;
        }

        const subRule = { targets, replacements, mode, remark: remarkStr };

        if (runtimeState.currentSubruleEditIndex === -1) {
            runtimeState.currentEditingSubrules.push(subRule);
        } else {
            runtimeState.currentEditingSubrules[runtimeState.currentSubruleEditIndex] = subRule;
        }

        $('#bl-subrule-edit-modal').fadeOut(150);
        renderSubrulesToModal();
        
        if (runtimeState.currentSubruleEditIndex === -1) {
            const container = $('#bl-edit-subrules-container');
            container.scrollTop(container[0].scrollHeight);
        }
    });

    $(document).off('click', '#bl-modal-sub-cancel').on('click', '#bl-modal-sub-cancel', () => $('#bl-subrule-edit-modal').fadeOut(150));

    // ==========================================
    // ✨ 修复：编辑合集弹窗上的叉号按钮 (已改为绑定 #bl-edit-cancel-x)
    // ==========================================

    $(document).off('click', '#bl-edit-cancel-x').on('click', '#bl-edit-cancel-x', () => $('#bl-rule-edit-modal').hide());
    $(document).off('click', '#bl-transfer-cancel').on('click', '#bl-transfer-cancel', () => closeTransferModal());
    $(document).off('click', '#bl-transfer-copy').on('click', '#bl-transfer-copy', () => runRuleTransfer(false));
    $(document).off('click', '#bl-transfer-move').on('click', '#bl-transfer-move', () => runRuleTransfer(true));
    $(document).off('click', '#bl-rule-transfer-modal').on('click', '#bl-rule-transfer-modal', function(e) {
        if (e.target && e.target.id === 'bl-rule-transfer-modal') closeTransferModal();
    });

    $(document).off('click', '#bl-edit-save').on('click', '#bl-edit-save', () => {
        const nameVal = $('#bl-edit-name').val().trim();
        const validSubrules = runtimeState.currentEditingSubrules.filter(sub => sub.targets && sub.targets.length > 0);
        
        if (validSubrules.length === 0) {
            alert("合集内至少需要保留一组有效映射！");
            return;
        }

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
        if (!activePreset) { alert('请先在下拉框中选择一个预设。'); return; }
        settings.defaultPreset = settings.defaultPreset === activePreset ? "" : activePreset;
        saveSettingsDebounced();
        refreshCharacterBindingUI();
    });

    $(document).off('click', '#bl-character-bind-toggle').on('click', '#bl-character-bind-toggle', function() {
        const settings = extension_settings[extensionName];
        const activePreset = String(settings.activePreset || '');
        if (!activePreset) { alert('请先在下拉框中选择一个预设。'); return; }
        const context = getCurrentCharacterContext();
        if (!context.key) { alert('当前页面未识别到可绑定角色。'); refreshCharacterBindingUI(); return; }

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

    const markPendingFromPayload = (payload, options = {}) => {
        const { chat } = getAppContext();
        let index = getMessageIndexFromEvent(payload);
        if (index < 0) index = getLatestMessageIndex();
        if (index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return;
        markDiffComparisonPending(index, computeMessageSignature(chat[index]), options);
        if (options.skipInject !== true) injectDiffButtonsStreamingSafe([index]);
    };

    let delayedCleanseTimer = null;
    let settleCleanseTimer = null;
    const delayedIncrementalCleanse = (payload) => {
        runtimeState.isStreamingGeneration = false;
        markPendingFromPayload(payload, { skipPersist: false });
        if (delayedCleanseTimer) clearTimeout(delayedCleanseTimer);
        if (settleCleanseTimer) clearTimeout(settleCleanseTimer);
        delayedCleanseTimer = setTimeout(() => { performIncrementalCleanse(payload, { visualOnly: false, fallbackLatest: true }); }, 150);
        settleCleanseTimer = setTimeout(() => { performIncrementalCleanse(payload, { visualOnly: false, fallbackLatest: true }); }, 700);
    };

    let editCleanseTimer = null;
    if (event_types.MESSAGE_EDITED) {
        eventSource.on(event_types.MESSAGE_EDITED, (payload) => {
            markPendingFromPayload(payload);
            if (editCleanseTimer) clearTimeout(editCleanseTimer);
            editCleanseTimer = setTimeout(() => { performIncrementalCleanse(payload, { visualOnly: false, fallbackLatest: true }); }, 100);
        });
    }

    if (event_types.GENERATION_STARTED) eventSource.on(event_types.GENERATION_STARTED, () => { runtimeState.isStreamingGeneration = true; });
    if (event_types.STREAM_TOKEN_RECEIVED) eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => { runtimeState.isStreamingGeneration = true; });
    if (event_types.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, (payload) => delayedIncrementalCleanse(payload));
    if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, (payload) => delayedIncrementalCleanse(payload));
    if (event_types.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, (payload) => delayedIncrementalCleanse(payload));
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, (payload) => delayedIncrementalCleanse(payload));
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            resetDiffRuntimeState();
            runtimeState.currentDiffIndex = undefined;
            $('#bl-diff-modal').hide();
            applyCharacterPresetBinding(true, { skipCleanse: true });
            restoreDiffStateFromChatMetadata();
            setTimeout(() => { injectDiffButtons(); performGlobalCleanse(); }, 120);
        });
    }

    setInterval(() => applyCharacterPresetBinding(false, { skipCleanse: true }), 1200);
}
