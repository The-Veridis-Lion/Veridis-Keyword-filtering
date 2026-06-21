import { extensionName, getAppContext, runtimeState, markRulesDataDirty, markPresetsUiDirty, minTrackedDiffMessages, maxTrackedDiffMessages, normalizeDiffTrackedMessageLimit } from './state.js';
import { logger } from './log.js';
import { DEFAULT_SCOPE_TAG_GROUP_ID, createScopeTagGroupId, createScopeTagId, deepClone, formatScopeTagInput, getBuiltinScopeTagKeyForStartTag, getCotScopeTagBuiltinKeys, getCurrentChatCompletionPresetName, getCurrentCharacterContext, getPresetBindingUsage, isCotScopeTagEntry, mergeScopeTagsWithBuiltins, normalizeImportedRulesPayload, normalizeScopeTagBuiltinDismissedList, normalizeScopeTagCollapsedGroupList, normalizeScopeTagGroupList, normalizeScopeTagList, parseInputToWords, parseScopeTagInput, validateRegexTargetInput } from './utils.js';
import {
    applyPresetByName,
    closeScopeTagsModal,
    openScopeTagsModal,
    renderTags,
    renderScopeTagsModal,
    updateToolbarUI,
    renderSubrulesToModal,
    showConfirmModal,
    refreshCharacterBindingUI,
    applyCharacterPresetBinding,
    focusLatestRuleCard,
    openSingleRuleModal,
    openTransferModal,
    closeTransferModal,
    runRuleTransfer,
    openEditModal,
    openRuleSearchModal,
    closeRuleSearchModal,
    renderRuleSearchModal,
    syncRuleSearchInputUi,
    clearRuleSearchEditFlow,
    showToast,
    openZhDictionaryModal,
    closeZhDictionaryModal,
    showZhDictionaryInstallOverlay,
    updateZhDictionaryInstallOverlay,
    closeLoadingOverlay,
    removeRegexReplacementInput,
    startEditingRegexReplacementInput,
    recognizeRegexReplacementInput,
    hasPendingRegexReplacementInput,
    setSingleRuleReplacementEditor,
    getSingleRuleReplacementValues,
} from './ui.js';
import {
    buildProcessors,
    performGlobalCleanse,
    applyScopedReplacements,
    performIncrementalCleanse,
    getMessageIndexFromEvent,
    getLatestMessageIndex,
    cleanseMessageDataAtIndex,
    queueIncrementalChatSave,
    refreshMessageDisplay,
} from './core.js';
import { performDeepCleanse } from './cleanse.js';
import { applyStreamingVisualMask, getMessageDomNode, purifyDOM, purifyStreamingMessageDom, isProtectedNode, isUserMessageDomNode, isRevertedMessageDomNode, isTrackableMessageDomNode, syncPersonaDescriptionProtectionControl } from './dom.js';
import { captureDiffRawSource, clearTrackedDiffEntry, computeMessageSignature, escapeHtml, getDiffComparisonForMessage, getDiffSnippetsForMessage, getDiffStateForMessage, injectDiffButtons, isAssistantMessage, markDiffComparisonPending, refreshDiffCacheIfStale, resetDiffRuntimeState, restoreDiffStateFromChatMetadata, syncTrackedIndicesToLatestAssistantMessages } from './diff.js';
import { getCurrentMessageOriginalMes, setCurrentSwipeText } from './messageMeta.js';
import { findRelatedRulesForDiffChange } from './relatedRules.js';
import { isBaiBaiToolkitInstalled, isTauriTavernHost } from './platform.js';
import {
    downloadZhDictionaryPackage,
    getZhDictionaryPackageStats,
    getZhDictionaryPackageStatus,
    getZhVariantCompatOptions,
    isZhDictionaryReady,
    markZhDictionaryInstallFailed,
    normalizeZhVariantSettings,
    restoreZhDictionaryPackageFromCache,
} from './zhConversion.js';

let streamingDiffInjectTimer = null;
let streamingPendingDiffIndices = [];
const ruleObjectIdMap = new WeakMap();
let nextRuleObjectId = 1;
let zhDictionaryInstallAbortController = null;

function removeBindingEntriesForPreset(bindingMap, presetName) {
    if (!bindingMap || typeof bindingMap !== 'object' || !presetName) return 0;
    let count = 0;
    Object.keys(bindingMap).forEach((key) => {
        if (bindingMap[key] === presetName) {
            delete bindingMap[key];
            count += 1;
        }
    });
    return count;
}

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
    const isBatchMode = $('#bl-purifier-popup').hasClass('bl-is-batch-mode');
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

function normalizeRulesForPresetComparison(rules) {
    return (Array.isArray(rules) ? rules : []).map((rule) => {
        const normalized = deepClone(rule || {});
        delete normalized.enabled;
        return normalized;
    });
}

function hasPresetContentChanges(currentRules, savedRules) {
    return JSON.stringify(normalizeRulesForPresetComparison(currentRules))
        !== JSON.stringify(normalizeRulesForPresetComparison(savedRules));
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
    syncPersonaDescriptionProtectionControl();
    const personaProtectionIntervalId = setInterval(syncPersonaDescriptionProtectionControl, 1000);
    window.addEventListener('beforeunload', () => clearInterval(personaProtectionIntervalId), { once: true });
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

    const collectClosestTrackableMessageNode = (node, bucket) => {
        if (!node) return;
        const element = node.nodeType === 1 ? node : node.parentElement;
        const mesNode = element?.matches?.('.mes') ? element : element?.closest?.('.mes');
        if (mesNode && isTrackableMessageDomNode(mesNode)) bucket.add(mesNode);
    };

    const primePendingComparisonForNode = (messageNode, options = {}) => {
        const { chat } = getAppContext();
        const index = resolveNodeMessageIndex(messageNode);
        if (index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return -1;
        captureDiffRawSource(index);
        markDiffComparisonPending(index, computeMessageSignature(chat[index]), options);
        return index;
    };

    const streamingVisualPurifyTextCache = new WeakMap();

    const hasStreamingUnsafeRegexProcessors = () => runtimeState.activeProcessors
        .some((proc) => proc.kind === 'regex' && proc.domSafe === false);

    const getLatestStreamingAssistantIndex = () => {
        const { chat } = getAppContext();
        if (!Array.isArray(chat)) return -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (isAssistantMessage(chat[i])) return i;
        }
        return -1;
    };

    const purifyStreamingMessageVisualNow = (messageNodes, touchedMessageIndices) => {
        if (!runtimeState.isStreamingGeneration || messageNodes.size === 0) return;
        if (!hasStreamingUnsafeRegexProcessors()) return;

        const latestIndex = getLatestStreamingAssistantIndex();
        if (latestIndex < 0) return;

        messageNodes.forEach((mesNode) => {
            if (!mesNode?.isConnected || isRevertedMessageDomNode(mesNode)) return;

            const index = resolveNodeMessageIndex(mesNode);
            if (index !== latestIndex) return;

            const textRoot = mesNode.querySelector?.('.mes_text') || mesNode;
            const currentText = textRoot?.textContent || '';
            if (!currentText || streamingVisualPurifyTextCache.get(mesNode) === currentText) return;

            streamingVisualPurifyTextCache.set(mesNode, currentText);
            if (!purifyStreamingMessageDom(mesNode, { unsafeRegexOnly: true })) return;

            const nextTextRoot = mesNode.querySelector?.('.mes_text') || mesNode;
            streamingVisualPurifyTextCache.set(mesNode, nextTextRoot?.textContent || '');
            const touchedIndex = primePendingComparisonForNode(mesNode, { skipPersist: true });
            if (touchedIndex >= 0) touchedMessageIndices.add(touchedIndex);
        });
    };

    const chatObserver = new MutationObserver((mutations) => {
    if (isPurifying) return;
    const isStreaming = runtimeState.isStreamingGeneration;
    
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) return;
        
        const touchedMessageIndices = new Set();
        const streamingMessageNodes = new Set();
        isPurifying = true;
        try {
            for (let mi = 0; mi < mutations.length; mi++) {
                const m = mutations[mi];
                for (let ni = 0; ni < m.addedNodes.length; ni++) {
                    const node = m.addedNodes[ni];
                    if (node.nodeType === 3 || node.nodeType === 8) {
                        if (node.parentNode && isProtectedNode(node.parentNode)) continue;
                        if (node.parentNode && isRevertedMessageDomNode(node.parentNode)) continue;
                        if (node.parentNode && getAppContext().extension_settings?.[extensionName]?.skipUserMessages && isUserMessageDomNode(node.parentNode)) continue;
                        const original = node.nodeValue;
                        const nextValue = isStreaming
                            ? applyStreamingVisualMask(original, { domSafeOnly: true })
                            : applyScopedReplacements(original, { deterministic: true, domSafeOnly: true });
                        if (original !== nextValue) node.nodeValue = nextValue;
                        if (isStreaming) collectClosestTrackableMessageNode(node, streamingMessageNodes);
                        } else if (node.nodeType === 1) {
                            purifyDOM(node);
                            if (isStreaming) collectClosestTrackableMessageNode(node, streamingMessageNodes);
                            const messageNodes = [];
                            collectMessageNodes(node, messageNodes);
                        messageNodes.forEach((mesNode) => {
                            const index = primePendingComparisonForNode(mesNode, { skipPersist: isStreaming });
                            if (index >= 0) touchedMessageIndices.add(index);
                            if (isStreaming) streamingMessageNodes.add(mesNode);
                        });
                    }
                }
                if (m.type === 'characterData') {
                    if (m.target.parentNode && isProtectedNode(m.target.parentNode)) continue;
                    if (m.target.parentNode && isRevertedMessageDomNode(m.target.parentNode)) continue;
                    if (m.target.parentNode && getAppContext().extension_settings?.[extensionName]?.skipUserMessages && isUserMessageDomNode(m.target.parentNode)) continue;
                    const original = m.target.nodeValue;
                    const nextValue = isStreaming
                        ? applyStreamingVisualMask(original, { domSafeOnly: true })
                        : applyScopedReplacements(original, { deterministic: true, domSafeOnly: true });
                    if (original !== nextValue) m.target.nodeValue = nextValue;
                    if (isStreaming) collectClosestTrackableMessageNode(m.target, streamingMessageNodes);
                }
            }

            if (isStreaming) {
                streamingMessageNodes.forEach((mesNode) => {
                    if (!purifyStreamingMessageDom(mesNode)) return;
                    const index = primePendingComparisonForNode(mesNode, { skipPersist: true });
                    if (index >= 0) touchedMessageIndices.add(index);
                });
                purifyStreamingMessageVisualNow(streamingMessageNodes, touchedMessageIndices);
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
        const cleanedVal = applyScopedReplacements(originalVal, { deterministic: true });
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

    function checkUnsavedChanges() {
        const settings = extension_settings[extensionName];
        const active = settings.activePreset;
        if (!active) return false;
        return hasPresetContentChanges(settings.rules || [], settings.presets[active] || []);
    }

    function normalizeImportedRuleList(rules) {
        return (Array.isArray(rules) ? rules : []).map((rule, idx) => {
            const next = deepClone(rule || {});
            if (!next.name) next.name = next.targets?.[0] || `未命名合集 ${idx + 1}`;
            if (next.enabled === undefined) next.enabled = true;
            if (next.targets) {
                next.subRules = [{
                    targets: next.targets,
                    replacements: next.replacements || [],
                    mode: 'text',
                    enabled: true,
                }];
                delete next.targets;
                delete next.replacements;
            }
            if (!Array.isArray(next.subRules)) next.subRules = [];
            next.subRules = next.subRules.map((sub) => {
                const normalizedSub = deepClone(sub || {});
                if (!normalizedSub.mode) normalizedSub.mode = 'text';
                if (normalizedSub.enabled === undefined) normalizedSub.enabled = true;
                if (!Array.isArray(normalizedSub.targets)) normalizedSub.targets = [];
                if (!Array.isArray(normalizedSub.replacements)) normalizedSub.replacements = [];
                return normalizedSub;
            });
            return next;
        });
    }

    function makeUniquePresetName(baseName) {
        const settings = extension_settings[extensionName];
        const base = String(baseName || '').trim() || '导入预设';
        if (!settings.presets?.[base]) return base;
        let counter = 2;
        while (settings.presets?.[`${base} (${counter})`]) counter++;
        return `${base} (${counter})`;
    }

    function getImportPresetName() {
        return String($('#bl-import-preset-name').val() || '').trim();
    }

    function closeImportChoiceModal() {
        runtimeState.importPresetDraft = null;
        $('#bl-preset-import-choice-modal')
            .removeClass('bl-is-open')
            .attr('aria-hidden', 'true')
            .hide();
    }

    function openImportChoiceModal(rules, defaultName) {
        const normalizedRules = normalizeImportedRuleList(rules);
        if (normalizedRules.length === 0) {
            alert('导入失败：未发现有效规则。');
            return;
        }
        const presetName = makeUniquePresetName(defaultName);
        runtimeState.importPresetDraft = { rules: normalizedRules, defaultName: presetName };
        $('#bl-import-preset-name').val(presetName);
        $('#bl-import-choice-summary').text(`已读取 ${normalizedRules.length} 个规则分组。只导入不会修改当前规则；切换使用和临时预览会替换当前规则并重新净化。`);
        const $modal = $('#bl-preset-import-choice-modal');
        $modal.detach().appendTo(document.body);
        $modal
            .attr('aria-hidden', 'false')
            .addClass('bl-is-open')
            .css('display', 'flex');
        // iOS browsers sometimes need a layout pass after the file picker returns.
        $modal[0]?.getBoundingClientRect();
        window.setTimeout(() => $('#bl-import-preset-name').trigger('focus').trigger('select'), 50);
    }

    function confirmBeforeImportChoiceIfUnsaved() {
        const settings = extension_settings[extensionName];
        const active = settings.activePreset;
        if (!active || !checkUnsavedChanges()) return true;
        return confirm(`当前预设 "${active}" 有未保存的改动。\n\n只导入为新预设不会修改当前规则；导入并切换或临时预览会在执行前再次确认保存。\n\n是否继续选择导入方式？`);
    }

    function validateImportPresetName() {
        const settings = extension_settings[extensionName];
        const name = getImportPresetName();
        if (!name) {
            alert('请填写预设名称。');
            $('#bl-import-preset-name').trigger('focus');
            return '';
        }
        if (settings.presets?.[name]) {
            alert('存档名称已存在，请换一个名称。');
            $('#bl-import-preset-name').trigger('focus').trigger('select');
            return '';
        }
        return name;
    }

    function confirmUnsavedBeforeReplacingCurrentRules(actionLabel) {
        const settings = extension_settings[extensionName];
        const active = settings.activePreset;
        if (!active || !checkUnsavedChanges()) return true;
        const shouldSave = confirm(`当前预设 "${active}" 有未保存的改动。\n\n点击“确定”先保存并继续${actionLabel}。\n点击“取消”将取消本次导入操作。`);
        if (!shouldSave) return false;
        settings.presets[active] = deepClone(settings.rules || []);
        saveSettingsDebounced();
        markPresetsUiDirty(true);
        return true;
    }

    function getImportDraftRules() {
        const draft = runtimeState.importPresetDraft;
        return Array.isArray(draft?.rules) ? deepClone(draft.rules) : null;
    }

    function importPresetOnly() {
        const settings = extension_settings[extensionName];
        const rules = getImportDraftRules();
        if (!rules) return;
        const name = validateImportPresetName();
        if (!name) return;

        settings.presets[name] = rules;
        markPresetsUiDirty(true);
        saveSettingsDebounced();
        updateToolbarUI();
        closeImportChoiceModal();
        showToast(`已导入预设：${name}`);
    }

    function importPresetAndSwitch() {
        const settings = extension_settings[extensionName];
        const rules = getImportDraftRules();
        if (!rules) return;
        const name = validateImportPresetName();
        if (!name) return;
        if (!confirmUnsavedBeforeReplacingCurrentRules('并切换使用导入预设')) return;

        settings.presets[name] = deepClone(rules);
        settings.activePreset = name;
        settings.rules = deepClone(rules);
        markRulesDataDirty({ presetsUi: true });
        saveSettingsDebounced();
        updateToolbarUI();
        renderTags();
        performGlobalCleanse();
        closeImportChoiceModal();
        showToast(`已导入并切换：${name}`);
    }

    function importPresetAsTemporaryPreview() {
        const settings = extension_settings[extensionName];
        const rules = getImportDraftRules();
        if (!rules) return;
        if (!confirm('仅临时预览会立刻替换当前规则，但不会保存为预设。\n确定继续吗？')) return;
        if (!confirmUnsavedBeforeReplacingCurrentRules('并进入临时预览')) return;

        settings.rules = rules;
        settings.activePreset = "";
        markRulesDataDirty();
        saveSettingsDebounced();
        updateToolbarUI();
        renderTags();
        performGlobalCleanse();
        closeImportChoiceModal();
        showToast('已进入临时规则预览');
    }

    const { extension_settings, saveSettingsDebounced, eventSource, event_types } = getAppContext();
    const formatRegexTargetError = (error) => `第 ${error.line} 行：${error.message}`;
    const clearRegexTargetValidationState = () => {
        $('#bl-modal-sub-target').removeClass('bl-invalid').removeAttr('aria-invalid');
        $('#bl-modal-sub-target-error').removeClass('is-visible').text('');
    };
    const applyRegexTargetValidationError = (error) => {
        const message = formatRegexTargetError(error);
        $('#bl-modal-sub-target').addClass('bl-invalid').attr('aria-invalid', 'true');
        $('#bl-modal-sub-target-error').addClass('is-visible').text(message);
        return message;
    };
    const subruleModeUIMap = {
        simple: {
            hint: '适合批量覆盖相近表达，支持 {} 组合和 * 通配。',
            targetPlaceholder: "简易语法 (每行一条)\n例如：{宛若,如同}{神明,恶魔}?",
            replacementPlaceholder: "替换后词汇（每行一条，支持随机，可留空）\n留空时，命中后会直接删除",
        },
        text: {
            hint: '按普通词组逐项替换，适合稳定短语，长词会优先处理。',
            targetPlaceholder: "被替换词汇 (逗号/空格分隔)\n例如：嘴角勾起, 并不存在",
            replacementPlaceholder: "替换后词汇（逗号/空格分隔，可留空）\n留空时，命中后会直接删除",
        },
        regex: {
            hint: '适合复杂匹配和捕获组替换；每次命中会从替换项里随机选一个。',
            targetPlaceholder: "正则匹配规则 (每行一条)\n支持裸模式 foo|bar 或 /foo|bar/gmu",
            replacementPlaceholder: "替换模板（每行一条，支持随机；可用 $1、\\n，可留空）\n点“按行识别”后加入下方替换项",
            regexEditPlaceholder: "正在编辑替换项；可用 $1、\\n\n点“更新替换项”保存修改",
        },
    };
    const validateRegexTargetField = (options = {}) => {
        const mode = String($('#bl-modal-sub-mode').val() || '');
        if (mode !== 'regex') {
            clearRegexTargetValidationState();
            return { ok: true, parsed: [] };
        }

        const result = validateRegexTargetInput($('#bl-modal-sub-target').val());
        if (result.ok) {
            clearRegexTargetValidationState();
            return result;
        }

        const uiMessage = applyRegexTargetValidationError(result.error);
        if (options.focus === true) $('#bl-modal-sub-target').trigger('focus');
        if (options.toast === true) showToast(`正则规则有误：${uiMessage}`);
        return { ...result, uiMessage };
    };
    const applySubruleModeUI = (rawMode) => {
        const mode = subruleModeUIMap[rawMode] ? rawMode : 'simple';
        const config = subruleModeUIMap[mode];
        const previousMode = String($('#bl-modal-sub-mode').data('current-mode') || '');
        if (previousMode && previousMode !== mode) {
            const previousReplacements = getSingleRuleReplacementValues(previousMode);
            setSingleRuleReplacementEditor(mode, previousReplacements);
        }
        $('#bl-modal-sub-mode').data('current-mode', mode);
        $('#bl-modal-sub-target').attr('placeholder', config.targetPlaceholder);
        $('#bl-modal-sub-rep').attr('placeholder', config.replacementPlaceholder);
        if (mode === 'regex') {
            $('#bl-modal-sub-rep')
                .data('regex-default-placeholder', config.replacementPlaceholder)
                .data('regex-edit-placeholder', config.regexEditPlaceholder || config.replacementPlaceholder);
            const activeEditIndex = Number($('#bl-modal-sub-rep').data('regex-edit-index'));
            $('#bl-modal-sub-regex-recognize').text(activeEditIndex >= 0 ? '更新替换项' : '按行识别');
            $('#bl-modal-sub-rep').attr('placeholder', activeEditIndex >= 0
                ? (config.regexEditPlaceholder || config.replacementPlaceholder)
                : config.replacementPlaceholder);
        } else {
            $('#bl-modal-sub-rep')
                .removeData('regex-default-placeholder')
                .removeData('regex-edit-placeholder');
        }
        $('#bl-modal-sub-mode-hint').text(config.hint);
        validateRegexTargetField();
    };
    const clearScopeTagValidationState = () => {
        $('#bl-scope-tag-input').removeClass('bl-invalid').removeAttr('aria-invalid');
        $('#bl-scope-tag-error').removeClass('is-visible').text('');
    };
    const applyScopeTagValidationError = (message) => {
        $('#bl-scope-tag-input').addClass('bl-invalid').attr('aria-invalid', 'true');
        $('#bl-scope-tag-error').addClass('is-visible').text(message);
    };
    const getScopeTagEditId = () => String($('#bl-scope-tag-input').data('scope-edit-id') || '');
    const resetScopeTagEditor = () => {
        $('#bl-scope-tag-input').val('').data('scope-edit-id', '');
        $('#bl-scope-tag-label-input').val('');
        $('#bl-scope-tag-group-select').val(DEFAULT_SCOPE_TAG_GROUP_ID);
        $('#bl-scope-tag-editor-modal').prop('hidden', true);
        $('#bl-scope-group-manager-modal').prop('hidden', true);
        $('#bl-scope-tag-action-menu').prop('hidden', true);
        $('#bl-scope-tag-menu-open').attr('aria-expanded', 'false');
        clearScopeTagValidationState();
        renderScopeTagsModal();
    };
    const normalizeScopeTagDraftStart = (tagText) => {
        const trimmed = String(tagText || '').trim();
        if (/^<[^<>/\s]+>$/.test(trimmed)) return trimmed;
        return `<${trimmed.replace(/[<>]/g, '')}>`;
    };
    const buildScopeTagInputFromEditor = () => {
        const rawTagText = String($('#bl-scope-tag-input').val() || '').trim();
        const labelText = String($('#bl-scope-tag-label-input').val() || '').trim();
        if (!rawTagText) return '';
        if (rawTagText.includes('//')) {
            const [tagPart, ...labelParts] = rawTagText.split('//');
            const inlineLabel = labelParts.join('//').trim();
            const normalizedLabel = labelText || inlineLabel;
            const tagSource = normalizeScopeTagDraftStart(tagPart);
            return normalizedLabel ? `${tagSource}//${normalizedLabel}` : tagSource;
        }
        const tagSource = normalizeScopeTagDraftStart(rawTagText);
        return labelText ? `${tagSource}//${labelText}` : tagSource;
    };
    const getScopeTagGroups = () => normalizeScopeTagGroupList(settings.scopeTagGroups);
    const getScopeTagGroupIds = () => new Set(getScopeTagGroups().map((group) => group.id));
    const resolveScopeTagGroupId = (groupId) => {
        const candidate = String(groupId || DEFAULT_SCOPE_TAG_GROUP_ID).trim() || DEFAULT_SCOPE_TAG_GROUP_ID;
        return getScopeTagGroupIds().has(candidate) ? candidate : DEFAULT_SCOPE_TAG_GROUP_ID;
    };
    const renderScopeTagGroupOptions = (selectedGroupId = DEFAULT_SCOPE_TAG_GROUP_ID) => {
        const groups = getScopeTagGroups();
        const resolvedGroupId = resolveScopeTagGroupId(selectedGroupId);
        const $select = $('#bl-scope-tag-group-select');
        $select.empty();
        groups.forEach((group) => {
            $('<option>').val(group.id).text(group.name).appendTo($select);
        });
        $select.val(resolvedGroupId);
    };
    const getSelectedScopeTagGroupId = () => resolveScopeTagGroupId($('#bl-scope-tag-group-select').val());
    const normalizeScopeTagsToKnownGroups = (scopeTags) => {
        const groupIds = getScopeTagGroupIds();
        return normalizeScopeTagList(scopeTags).map((tag) => {
            const groupId = String(tag.groupId || DEFAULT_SCOPE_TAG_GROUP_ID).trim() || DEFAULT_SCOPE_TAG_GROUP_ID;
            return groupIds.has(groupId) ? tag : { ...tag, groupId: DEFAULT_SCOPE_TAG_GROUP_ID };
        });
    };
    const closeScopeTagActionMenu = () => {
        $('#bl-scope-tag-action-menu').prop('hidden', true);
        $('#bl-scope-tag-menu-open').attr('aria-expanded', 'false');
    };
    const renderScopeGroupManager = (focusGroupId = '') => {
        const groups = getScopeTagGroups();
        const html = groups.map((group, index) => {
            const isDefault = group.id === DEFAULT_SCOPE_TAG_GROUP_ID;
            const moveUpDisabled = index === 0 ? 'disabled' : '';
            const moveDownDisabled = index === groups.length - 1 ? 'disabled' : '';
            const deleteDisabled = isDefault ? 'disabled' : '';
            return `
                <div class="bl-scope-group-manager-item" data-group-id="${escapeHtml(group.id)}">
                    <input type="text" class="bl-scope-group-name-input" data-group-id="${escapeHtml(group.id)}" value="${escapeHtml(group.name)}" aria-label="分组名称">
                    <div class="bl-scope-group-manager-item-actions">
                        <button type="button" class="bl-icon-btn bl-scope-group-move-up" data-group-id="${escapeHtml(group.id)}" title="上移分组" ${moveUpDisabled}><i class="fas fa-arrow-up"></i></button>
                        <button type="button" class="bl-icon-btn bl-scope-group-move-down" data-group-id="${escapeHtml(group.id)}" title="下移分组" ${moveDownDisabled}><i class="fas fa-arrow-down"></i></button>
                        <button type="button" class="bl-icon-btn bl-scope-group-delete bl-danger-btn" data-group-id="${escapeHtml(group.id)}" title="${isDefault ? '默认分组不可删除' : '删除分组'}" ${deleteDisabled}><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            `;
        }).join('');
        $('#bl-scope-group-manager-list').html(html || '<div class="bl-empty-state">暂无分组</div>');
        if (focusGroupId) {
            window.setTimeout(() => {
                const escapedGroupId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                    ? CSS.escape(focusGroupId)
                    : String(focusGroupId).replace(/["\\]/g, '\\$&');
                $(`#bl-scope-group-manager-list .bl-scope-group-name-input[data-group-id="${escapedGroupId}"]`).trigger('focus').trigger('select');
            }, 20);
        }
    };
    const openScopeTagEditor = (scopeTag = null) => {
        const formattedInput = scopeTag ? formatScopeTagInput(scopeTag) : '';
        const tagSource = formattedInput.split('//')[0]?.trim() || '';
        const tagName = tagSource.match(/^<([^<>/\s]+)>$/)?.[1] || tagSource;
        renderScopeTagGroupOptions(scopeTag?.groupId || DEFAULT_SCOPE_TAG_GROUP_ID);
        $('#bl-scope-tag-input')
            .val(scopeTag ? tagName : '')
            .data('scope-edit-id', scopeTag?.id || '');
        $('#bl-scope-tag-label-input').val(scopeTag?.label || '');
        clearScopeTagValidationState();
        renderScopeTagsModal();
        $('#bl-scope-tag-editor-modal').prop('hidden', false);
        window.setTimeout(() => {
            $('#bl-scope-tag-input').trigger('focus');
        }, 20);
    };
    const setScopeTagMode = (mode) => {
        const nextMode = mode === 'cleanse-inside' ? 'cleanse-inside' : 'protect';
        if (settings.scopeTagMode === nextMode) {
            renderScopeTagsModal();
            return;
        }
        settings.scopeTagMode = nextMode;
        saveSettingsDebounced();
        renderScopeTagsModal();
        performGlobalCleanse();
        showToast(settings.scopeTagMode === 'cleanse-inside' ? '已切换为净化特定标签' : '已切换为保护特定标签');
    };
    const persistScopeTagGroups = (groups, options = {}) => {
        const normalizedGroups = normalizeScopeTagGroupList(groups);
        settings.scopeTagGroups = normalizedGroups;
        settings.scopeTagCollapsedGroups = normalizeScopeTagCollapsedGroupList(settings.scopeTagCollapsedGroups, normalizedGroups);
        const knownGroupIds = new Set(normalizedGroups.map((group) => group.id));
        const currentScopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        settings.scopeTags = normalizeScopeTagList(currentScopeTags).map((tag) => {
            const groupId = String(tag.groupId || DEFAULT_SCOPE_TAG_GROUP_ID).trim() || DEFAULT_SCOPE_TAG_GROUP_ID;
            return knownGroupIds.has(groupId) ? tag : { ...tag, groupId: DEFAULT_SCOPE_TAG_GROUP_ID };
        });
        saveSettingsDebounced();
        renderScopeTagsModal();
        renderScopeTagGroupOptions($('#bl-scope-tag-group-select').val() || DEFAULT_SCOPE_TAG_GROUP_ID);
        renderScopeGroupManager(options.focusGroupId || '');
    };
    const persistScopeTags = (scopeTags, options = {}) => {
        settings.scopeTagGroups = getScopeTagGroups();
        const sourceScopeTags = normalizeScopeTagsToKnownGroups(scopeTags);
        const representedBuiltinKeys = new Set(sourceScopeTags.map((tag) => tag.builtinKey).filter(Boolean));
        const dismissedBuiltinKeys = normalizeScopeTagBuiltinDismissedList(options.dismissedBuiltinKeys ?? settings.scopeTagBuiltinDismissed)
            .filter((builtinKey) => !representedBuiltinKeys.has(builtinKey));
        const normalized = mergeScopeTagsWithBuiltins(sourceScopeTags, dismissedBuiltinKeys);
        settings.scopeTagBuiltinDismissed = dismissedBuiltinKeys;
        settings.scopeTags = normalizeScopeTagsToKnownGroups(normalized);
        saveSettingsDebounced();
        renderScopeTagsModal();
        if (options.skipCleanse !== true) performGlobalCleanse();
        return normalized;
    };
    const saveScopeTag = () => {
        const rawInput = buildScopeTagInputFromEditor();
        const parsed = parseScopeTagInput(rawInput);
        if (!parsed.ok) {
            applyScopeTagValidationError(parsed.error.message);
            $('#bl-scope-tag-input').trigger('focus');
            return false;
        }

        const editId = getScopeTagEditId();
        const scopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        const currentTag = editId ? scopeTags.find((tag) => tag.id === editId) : null;
        const duplicate = scopeTags.find((tag) => tag.startTag === parsed.value.startTag && tag.id !== editId);
        if (duplicate) {
            applyScopeTagValidationError('该范围标签已存在，无需重复添加。');
            $('#bl-scope-tag-input').trigger('focus');
            return false;
        }

        const currentBuiltinKey = currentTag?.builtinKey || '';
        const inferredBuiltinKey = getBuiltinScopeTagKeyForStartTag(parsed.value.startTag);
        const nextBuiltinKey = currentBuiltinKey
            ? (inferredBuiltinKey || currentBuiltinKey)
            : inferredBuiltinKey;
        const dismissedBuiltinKeys = [...normalizeScopeTagBuiltinDismissedList(settings.scopeTagBuiltinDismissed)];
        if (currentBuiltinKey && inferredBuiltinKey && inferredBuiltinKey !== currentBuiltinKey) {
            dismissedBuiltinKeys.push(currentBuiltinKey);
        }

        const nextScopeTag = {
            id: editId || createScopeTagId(),
            startTag: parsed.value.startTag,
            endTag: parsed.value.endTag,
            label: parsed.value.label,
            groupId: getSelectedScopeTagGroupId(),
            enabled: currentTag ? currentTag.enabled !== false : true,
        };
        if (nextBuiltinKey) nextScopeTag.builtinKey = nextBuiltinKey;
        const updated = editId
            ? scopeTags.map((tag) => (tag.id === editId ? { ...tag, ...nextScopeTag, enabled: tag.enabled !== false } : tag))
            : [...scopeTags, nextScopeTag];

        persistScopeTags(updated, { dismissedBuiltinKeys });
        showToast(editId ? '范围标签已更新' : '范围标签已添加');
        resetScopeTagEditor();
        return true;
    };

    $(document).off('click', '#bl-wand-btn, #bl-wand-btn-panel').on('click', '#bl-wand-btn, #bl-wand-btn-panel', () => {
        updateToolbarUI();
        renderTags();
        $('#bl-purifier-popup').css('display', 'flex').hide().fadeIn(200);
    });

    $(document).off('click', '#bl-close-btn').on('click', '#bl-close-btn', () => {
        if (checkUnsavedChanges()) {
            if (confirm(`预设 "${extension_settings[extensionName].activePreset}" 有未保存的改动，是否保存？\n点击【确定】保存，点击【取消】直接关闭放弃改动。`)) {
                $('#bl-preset-save').click();
            } else {
                // 放弃保存时回滚到已保存状态，避免脏数据残留。
                applyPresetByName(extension_settings[extensionName].activePreset, { skipRender: true });
            }
        }
        closeRuleSearchModal({ reset: true });
        closeScopeTagsModal({ reset: true });
        $('#bl-purifier-popup').fadeOut(200);
    });
    const settings = extension_settings[extensionName];
    normalizeZhVariantSettings(settings);
    const isSearchGroupEditFlow = () => runtimeState.searchEditFlow.active === true && runtimeState.searchEditFlow.returnMode === 'group';
    const isSearchDirectSubruleFlow = () => runtimeState.searchEditFlow.active === true && runtimeState.searchEditFlow.returnMode === 'subrule';
    const isRelatedDirectSubruleFlow = () => runtimeState.searchEditFlow.active === true && runtimeState.searchEditFlow.returnMode === 'related';
    const resetRuleSearchQueryState = () => {
        runtimeState.ruleSearchKeyword = '';
        runtimeState.ruleSearchDraftKeyword = '';
        runtimeState.ruleSearchHasSearched = false;
        runtimeState.ruleSearchExpandedMenuKey = '';
        clearRuleSearchEditFlow();
    };
    const submitRuleSearch = () => {
        runtimeState.ruleSearchDraftKeyword = String($('#bl-rule-search-input').val() || '');
        runtimeState.ruleSearchKeyword = runtimeState.ruleSearchDraftKeyword.trim();
        runtimeState.ruleSearchHasSearched = runtimeState.ruleSearchKeyword.length > 0;
        runtimeState.ruleSearchExpandedMenuKey = '';
        renderRuleSearchModal();
    };
    const saveCurrentEditingRule = (options = {}) => {
        const {
            toastMessage = '合集保存成功',
            focusLatest = true,
        } = options;
        const rules = extension_settings[extensionName].rules || [];
        const isCreatingNewRule = runtimeState.currentEditingIndex === -1;
        const nameVal = String($('#bl-edit-name').val() || '').trim();
        const validSubrules = runtimeState.currentEditingSubrules.filter(sub => sub.targets && sub.targets.length > 0);

        if (validSubrules.length === 0) {
            showToast('合集内至少需要保留一组有效映射！');
            return { ok: false };
        }

        let isEnabled = true;
        if (runtimeState.currentEditingIndex !== -1 && rules[runtimeState.currentEditingIndex]) {
            isEnabled = rules[runtimeState.currentEditingIndex].enabled !== false;
        }

        const fallbackName = runtimeState.currentEditingIndex !== -1
            ? (rules[runtimeState.currentEditingIndex]?.name || `合集 ${runtimeState.currentEditingIndex + 1}`)
            : `合集 ${rules.length + 1}`;
        const newRule = {
            name: nameVal || fallbackName,
            subRules: validSubrules,
            enabled: isEnabled
        };

        if (runtimeState.currentEditingIndex === -1) rules.push(newRule);
        else rules[runtimeState.currentEditingIndex] = newRule;

        markRulesDataDirty();
        saveSettingsDebounced();
        renderTags();
        if (isCreatingNewRule && focusLatest) {
            window.setTimeout(() => {
                focusLatestRuleCard();
            }, 50);
        }
        performGlobalCleanse();
        renderRuleSearchModal();
        if (toastMessage) showToast(toastMessage);
        return { ok: true, isCreatingNewRule, rule: newRule };
    };

    const applyThemeMode = (mode) => {
        const normalized = ['auto', 'light', 'dark'].includes(mode) ? mode : 'auto';
        const labels = {
            auto: '跟随酒馆',
            light: '白色主题',
            dark: '暗色主题',
        };
        const icons = {
            auto: 'fa-circle-half-stroke',
            light: 'fa-sun',
            dark: 'fa-moon',
        };
        settings.themeMode = normalized;
        $('#bl-purifier-popup, .bl-modal-shell, #bl-rule-transfer-modal, #bl-diff-modal, .bl-toast, #bl-loading-overlay, #bl-scope-tag-editor-modal, #bl-scope-group-manager-modal').attr('data-bl-theme', normalized);
        $('#bl-theme-toggle')
            .attr('title', `当前主题：${labels[normalized]}，点击切换`)
            .attr('aria-label', `当前主题：${labels[normalized]}，点击切换`);
        $('#bl-theme-toggle i').attr('class', `fas ${icons[normalized]}`);
    };
    const syncZhCompatToggle = () => {
        const packageStatus = getZhDictionaryPackageStatus(settings);
        const ready = settings.zhVariantCompatEnabled === true
            ? isZhDictionaryReady(settings)
            : packageStatus.ready;
        if (settings.zhVariantCompatEnabled === true && !ready) {
            settings.zhVariantCompatEnabled = false;
        }
        const enabled = settings.zhVariantCompatEnabled === true && ready;
        const options = getZhVariantCompatOptions(settings);
        const regionText = [
            options.tw ? '台繁' : '',
            options.hk ? '港繁' : '',
        ].filter(Boolean).join('、') || '标准简繁';
        $('#bl-zh-compat-toggle')
            .toggleClass('bl-bind-active', enabled)
            .attr('aria-pressed', String(enabled))
            .attr('title', enabled
                ? `简繁兼容已开启：${regionText} 变体参与匹配（点击关闭）`
                : packageStatus.ready
                    ? `简繁兼容已关闭：已安装增强词典，点击启用 ${regionText} 匹配`
                    : '简繁兼容未安装：点击下载 OpenCC 增强词典包');
    };
    const enableVerifiedZhCompat = (toastMessage = '简繁兼容已开启') => {
        if (!restoreZhDictionaryPackageFromCache(settings)) return false;
        settings.zhVariantCompatEnabled = true;
        markRulesDataDirty({ rulesUi: false });
        saveSettingsDebounced();
        syncZhCompatToggle();
        performGlobalCleanse();
        showToast(toastMessage);
        return true;
    };
    const openZhDictionaryInstallPrompt = () => {
        const stats = getZhDictionaryPackageStats();
        openZhDictionaryModal(stats, getZhVariantCompatOptions(settings));
    };
    const runZhDictionaryInstall = async () => {
        if (zhDictionaryInstallAbortController) return;
        settings.zhVariantCompatOptions = {
            tw: $('#bl-zh-dict-tw').prop('checked') === true,
            hk: $('#bl-zh-dict-hk').prop('checked') === true,
        };
        settings.zhVariantCompatEnabled = false;
        saveSettingsDebounced();
        closeZhDictionaryModal();

        zhDictionaryInstallAbortController = new AbortController();
        showZhDictionaryInstallOverlay(() => {
            zhDictionaryInstallAbortController?.abort();
        });

        try {
            await downloadZhDictionaryPackage({
                signal: zhDictionaryInstallAbortController.signal,
                onProgress: ({ ratio, statusText }) => updateZhDictionaryInstallOverlay(ratio, statusText),
            });
            settings.zhVariantCompatEnabled = true;
            markRulesDataDirty({ rulesUi: false });
            saveSettingsDebounced();
            syncZhCompatToggle();
            performGlobalCleanse();
            showToast('增强简繁词典已安装并启用');
        } catch (error) {
            const message = markZhDictionaryInstallFailed(error);
            settings.zhVariantCompatEnabled = false;
            markRulesDataDirty({ rulesUi: false });
            saveSettingsDebounced();
            syncZhCompatToggle();
            if (error?.name === 'AbortError') showToast('已取消词典下载');
            else showToast(`词典安装失败：${message}`);
        } finally {
            zhDictionaryInstallAbortController = null;
            window.setTimeout(() => closeLoadingOverlay(), 260);
        }
    };
    applyThemeMode(settings.themeMode || 'auto');
    syncZhCompatToggle();

    $(document).off('click', '#bl-theme-toggle').on('click', '#bl-theme-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const modes = ['auto', 'light', 'dark'];
        const current = String(settings.themeMode || 'auto');
        const nextMode = modes[(Math.max(0, modes.indexOf(current)) + 1) % modes.length];
        applyThemeMode(nextMode);
        saveSettingsDebounced();
        showToast(`已切换主题：${nextMode === 'auto' ? '跟随酒馆' : nextMode === 'light' ? '白色主题' : '暗色主题'}`);
    });

    $(document).off('click.blBindMenu').on('click.blBindMenu', function(e) {
        if ($(e.target).closest('.bl-bind-menu-wrap').length > 0) return;
        $('#bl-bind-menu').prop('hidden', true);
        $('#bl-character-bind-toggle').attr('aria-expanded', 'false');
    });

    $(document).off('click', '#bl-zh-compat-toggle').on('click', '#bl-zh-compat-toggle', function(e) {
        e.preventDefault();
        if (settings.zhVariantCompatEnabled === true && isZhDictionaryReady(settings)) {
            settings.zhVariantCompatEnabled = false;
            markRulesDataDirty({ rulesUi: false });
            saveSettingsDebounced();
            syncZhCompatToggle();
            performGlobalCleanse();
            showToast('简繁兼容已关闭');
            return;
        }

        if (enableVerifiedZhCompat()) return;
        openZhDictionaryInstallPrompt();
    });

    $(document).off('click', '#bl-zh-dict-close, #bl-zh-dict-cancel').on('click', '#bl-zh-dict-close, #bl-zh-dict-cancel', function(e) {
        e.preventDefault();
        closeZhDictionaryModal();
    });

    $(document).off('click', '#bl-zh-dict-download').on('click', '#bl-zh-dict-download', function(e) {
        e.preventDefault();
        runZhDictionaryInstall();
    });

    $('#bl-diff-global-toggle').prop('checked', settings.enableVisualDiff !== false);

    $(document).off('change', '#bl-diff-global-toggle').on('change', '#bl-diff-global-toggle', function() {
        settings.enableVisualDiff = $(this).prop('checked');
        saveSettingsDebounced();
        injectDiffButtons();
    });

    $('#bl-skip-user-toggle').prop('checked', settings.skipUserMessages === true);

    $(document).off('change', '#bl-skip-user-toggle').on('change', '#bl-skip-user-toggle', function() {
        settings.skipUserMessages = $(this).prop('checked');
        saveSettingsDebounced();
        performGlobalCleanse();
    });

    $(document).off('click', '.bl-persona-description-protect-toggle').on('click', '.bl-persona-description-protect-toggle', function(e) {
        e.preventDefault();
        settings.protectPersonaDescription = settings.protectPersonaDescription !== true;
        saveSettingsDebounced();
        syncPersonaDescriptionProtectionControl();
        showToast(settings.protectPersonaDescription ? '用户设定描述已保护' : '用户设定描述已取消保护');
    });

    $(document).off('click', '#bl-preset-search').on('click', '#bl-preset-search', () => {
        openRuleSearchModal();
    });

    $(document).off('click', '#bl-rule-search-back').on('click', '#bl-rule-search-back', () => {
        closeRuleSearchModal({ reset: true });
    });

    $(document).off('input', '#bl-rule-search-input').on('input', '#bl-rule-search-input', function() {
        runtimeState.ruleSearchDraftKeyword = String($(this).val() || '');
        syncRuleSearchInputUi();
        if (runtimeState.ruleSearchDraftKeyword.trim() !== '') return;
        runtimeState.ruleSearchKeyword = '';
        runtimeState.ruleSearchHasSearched = false;
        runtimeState.ruleSearchExpandedMenuKey = '';
        renderRuleSearchModal();
    });

    $(document).off('keydown', '#bl-rule-search-input').on('keydown', '#bl-rule-search-input', function(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        submitRuleSearch();
    });

    $(document).off('click', '#bl-rule-search-submit').on('click', '#bl-rule-search-submit', () => {
        submitRuleSearch();
    });

    $(document).off('click', '#bl-rule-search-clear').on('click', '#bl-rule-search-clear', () => {
        resetRuleSearchQueryState();
        syncRuleSearchInputUi({ syncValue: true });
        renderRuleSearchModal();
        $('#bl-rule-search-input').trigger('focus');
    });

    $(document).off('click', '#bl-scope-tags-btn').on('click', '#bl-scope-tags-btn', () => {
        openScopeTagsModal();
    });

    $(document).off('click', '#bl-scope-tag-menu-open').on('click', '#bl-scope-tag-menu-open', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const $menu = $('#bl-scope-tag-action-menu');
        const nextHidden = !$menu.prop('hidden');
        $menu.prop('hidden', nextHidden);
        $(this).attr('aria-expanded', String(!nextHidden));
    });

    $(document).off('click', '#bl-scope-tag-add-open').on('click', '#bl-scope-tag-add-open', () => {
        closeScopeTagActionMenu();
        openScopeTagEditor();
    });

    $(document).off('click', '#bl-scope-group-manage-open').on('click', '#bl-scope-group-manage-open', () => {
        closeScopeTagActionMenu();
        renderScopeGroupManager();
        $('#bl-scope-group-manager-modal').prop('hidden', false);
    });

    $(document).off('click', '#bl-scope-tags-expand-all').on('click', '#bl-scope-tags-expand-all', () => {
        settings.scopeTagCollapsedGroups = [];
        saveSettingsDebounced();
        renderScopeTagsModal();
    });

    $(document).off('click', '#bl-scope-tags-collapse-all').on('click', '#bl-scope-tags-collapse-all', () => {
        settings.scopeTagCollapsedGroups = getScopeTagGroups().map((group) => group.id);
        saveSettingsDebounced();
        renderScopeTagsModal();
    });

    $(document).off('click', '.bl-scope-tag-group-head').on('click', '.bl-scope-tag-group-head', function(e) {
        e.preventDefault();
        if ($(e.target).closest('.bl-scope-tag-group-toggle').length > 0) return;
        const groupId = String($(this).closest('.bl-scope-tag-group').attr('data-group-id') || '');
        if (!groupId) return;
        const groups = getScopeTagGroups();
        const collapsed = new Set(normalizeScopeTagCollapsedGroupList(settings.scopeTagCollapsedGroups, groups));
        if (collapsed.has(groupId)) collapsed.delete(groupId);
        else collapsed.add(groupId);
        settings.scopeTagCollapsedGroups = normalizeScopeTagCollapsedGroupList([...collapsed], groups);
        saveSettingsDebounced();
        renderScopeTagsModal();
    });

    $(document).off('click', '.bl-scope-tag-group-toggle').on('click', '.bl-scope-tag-group-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const groupId = String($(this).attr('data-group-id') || '');
        if (!groupId || $(this).prop('disabled')) return;
        const nextEnabled = $(this).attr('aria-pressed') !== 'true';
        const currentScopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        let changed = false;
        const scopeTags = currentScopeTags.map((tag) => {
            if (resolveScopeTagGroupId(tag.groupId) !== groupId) return tag;
            if ((tag.enabled !== false) === nextEnabled) return tag;
            changed = true;
            return { ...tag, enabled: nextEnabled };
        });
        if (!changed) return;
        persistScopeTags(scopeTags);
        showToast(nextEnabled ? '已启用该分组' : '已关闭该分组');
    });

    $(document).off('click', '#bl-scope-group-add').on('click', '#bl-scope-group-add', () => {
        const group = { id: createScopeTagGroupId(), name: '未命名分组' };
        persistScopeTagGroups([...getScopeTagGroups(), group], { focusGroupId: group.id });
    });

    $(document).off('click', '#bl-scope-group-done').on('click', '#bl-scope-group-done', () => {
        $('#bl-scope-group-manager-modal').prop('hidden', true);
    });

    $(document).off('input', '.bl-scope-group-name-input').on('input', '.bl-scope-group-name-input', function() {
        const groupId = String($(this).attr('data-group-id') || '');
        const nextName = String($(this).val() || '').trim();
        if (!groupId) return;
        settings.scopeTagGroups = normalizeScopeTagGroupList(getScopeTagGroups().map((group) => (
            group.id === groupId ? { ...group, name: nextName || group.name } : group
        )));
        saveSettingsDebounced();
        renderScopeTagsModal();
        renderScopeTagGroupOptions($('#bl-scope-tag-group-select').val() || DEFAULT_SCOPE_TAG_GROUP_ID);
    });

    const moveScopeGroup = (groupId, direction) => {
        const groups = getScopeTagGroups();
        const index = groups.findIndex((group) => group.id === groupId);
        const targetIndex = direction === 'up' ? index - 1 : index + 1;
        if (index < 0 || targetIndex < 0 || targetIndex >= groups.length) return;
        [groups[index], groups[targetIndex]] = [groups[targetIndex], groups[index]];
        persistScopeTagGroups(groups);
    };

    $(document).off('click', '.bl-scope-group-move-up').on('click', '.bl-scope-group-move-up', function() {
        moveScopeGroup(String($(this).attr('data-group-id') || ''), 'up');
    });

    $(document).off('click', '.bl-scope-group-move-down').on('click', '.bl-scope-group-move-down', function() {
        moveScopeGroup(String($(this).attr('data-group-id') || ''), 'down');
    });

    $(document).off('click', '.bl-scope-group-delete').on('click', '.bl-scope-group-delete', function() {
        const groupId = String($(this).attr('data-group-id') || '');
        if (!groupId || groupId === DEFAULT_SCOPE_TAG_GROUP_ID) return;
        const group = getScopeTagGroups().find((item) => item.id === groupId);
        if (!group) return;
        if (!confirm(`确定删除分组 "${group.name}" 吗？\n该分组内的标签会移至默认分组。`)) return;
        const currentScopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        settings.scopeTags = currentScopeTags.map((tag) => (
            tag.groupId === groupId ? { ...tag, groupId: DEFAULT_SCOPE_TAG_GROUP_ID } : tag
        ));
        settings.scopeTagCollapsedGroups = normalizeScopeTagCollapsedGroupList(
            (settings.scopeTagCollapsedGroups || []).filter((id) => id !== groupId),
            getScopeTagGroups().filter((item) => item.id !== groupId)
        );
        persistScopeTagGroups(getScopeTagGroups().filter((item) => item.id !== groupId));
    });

    $(document).off('click', '#bl-scope-tag-mode-toggle').on('click', '#bl-scope-tag-mode-toggle', () => {
        setScopeTagMode(settings.scopeTagMode === 'cleanse-inside' ? 'protect' : 'cleanse-inside');
    });

    $(document).off('click', '#bl-scope-mode-protect, #bl-scope-mode-cleanse').on('click', '#bl-scope-mode-protect, #bl-scope-mode-cleanse', function() {
        setScopeTagMode(String($(this).data('mode') || 'protect'));
    });

    $(document).off('click', '#bl-scope-tags-close').on('click', '#bl-scope-tags-close', () => {
        closeScopeTagsModal({ reset: true });
    });

    $(document).off('click', '#bl-scope-tag-reset').on('click', '#bl-scope-tag-reset', () => {
        resetScopeTagEditor();
    });

    $(document).off('click', '#bl-scope-tag-save').on('click', '#bl-scope-tag-save', () => {
        saveScopeTag();
    });

    $(document).off('keydown', '#bl-scope-tag-label-input').on('keydown', '#bl-scope-tag-label-input', function(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        saveScopeTag();
    });

    $(document).off('keydown', '#bl-scope-tag-input').on('keydown', '#bl-scope-tag-input', function(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        saveScopeTag();
    });

    $(document).off('click', '.bl-rule-search-menu-toggle').on('click', '.bl-rule-search-menu-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const nextKey = String($(this).data('key') || '');
        runtimeState.ruleSearchExpandedMenuKey = runtimeState.ruleSearchExpandedMenuKey === nextKey ? '' : nextKey;
        renderRuleSearchModal();
    });

    $(document).off('click', '.bl-rule-search-menu-item').on('click', '.bl-rule-search-menu-item', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const action = String($(this).data('action') || '');
        const ruleIndex = Number($(this).attr('data-rule-index'));
        const subRuleIndex = Number($(this).attr('data-subrule-index'));
        const rules = extension_settings[extensionName].rules || [];
        if (!Number.isInteger(ruleIndex) || ruleIndex < 0 || ruleIndex >= rules.length) return;
        if (!Number.isInteger(subRuleIndex) || subRuleIndex < 0 || subRuleIndex >= (rules[ruleIndex]?.subRules || []).length) return;

        runtimeState.ruleSearchExpandedMenuKey = '';
        closeRuleSearchModal();

        if (action === 'group') {
            openEditModal(ruleIndex, { source: 'search', returnMode: 'group', subRuleIndex });
            return;
        }

        if (action === 'subrule') {
            openEditModal(ruleIndex, { source: 'search', returnMode: 'subrule', subRuleIndex });
            openSingleRuleModal(subRuleIndex, { hideEditModal: true });
        }
    });

    $(document).off('click', '#bl-rule-search-modal').on('click', '#bl-rule-search-modal', function(e) {
        if ($(e.target).closest('.bl-rule-search-menu-wrap').length > 0) return;
        if (!runtimeState.ruleSearchExpandedMenuKey) return;
        runtimeState.ruleSearchExpandedMenuKey = '';
        renderRuleSearchModal();
    });

    $(document).off('click', '#bl-scope-tags-modal').on('click', '#bl-scope-tags-modal', function(e) {
        if ($(e.target).closest('.bl-scope-tag-menu-wrap').length === 0) closeScopeTagActionMenu();
        if (e.target && e.target.id === 'bl-scope-tags-modal') closeScopeTagsModal({ reset: true });
    });

    $(document).off('click', '#bl-scope-tag-editor-modal').on('click', '#bl-scope-tag-editor-modal', function(e) {
        if (e.target && e.target.id === 'bl-scope-tag-editor-modal') resetScopeTagEditor();
    });

    $(document).off('click', '#bl-scope-group-manager-modal').on('click', '#bl-scope-group-manager-modal', function(e) {
        if (e.target && e.target.id === 'bl-scope-group-manager-modal') $('#bl-scope-group-manager-modal').prop('hidden', true);
    });

    $(document).off('click', '.bl-scope-tag-chip-main, .bl-scope-tag-edit').on('click', '.bl-scope-tag-chip-main, .bl-scope-tag-edit', function(e) {
        e.preventDefault();
        const tagId = String($(this).attr('data-id') || '');
        const scopeTag = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed).find((tag) => tag.id === tagId);
        if (!scopeTag) return;
        openScopeTagEditor(scopeTag);
    });

    $(document).off('change', '.bl-scope-tag-toggle').on('change', '.bl-scope-tag-toggle', function() {
        const tagId = String($(this).attr('data-id') || '');
        const checked = $(this).prop('checked');
        const currentScopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        const targetTag = currentScopeTags.find((tag) => tag.id === tagId);
        const togglesCotGroup = isCotScopeTagEntry(targetTag);
        const scopeTags = currentScopeTags.map((tag) => {
            if (togglesCotGroup && isCotScopeTagEntry(tag)) return { ...tag, enabled: checked };
            return tag.id === tagId ? { ...tag, enabled: checked } : tag;
        });
        persistScopeTags(scopeTags);
    });

    $(document).off('click', '.bl-scope-tag-del').on('click', '.bl-scope-tag-del', function(e) {
        e.preventDefault();
        const tagId = String($(this).attr('data-id') || '');
        const scopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        const scopeTag = scopeTags.find((tag) => tag.id === tagId);
        if (!scopeTag) return;
        const deletesCotGroup = isCotScopeTagEntry(scopeTag);
        const displayName = deletesCotGroup ? '<thinking> OR <think>' : scopeTag.startTag;
        if (!confirm(`确定删除范围标签 ${displayName} 吗？`)) return;
        const dismissedBuiltinKeys = [...normalizeScopeTagBuiltinDismissedList(settings.scopeTagBuiltinDismissed)];
        if (deletesCotGroup) dismissedBuiltinKeys.push(...getCotScopeTagBuiltinKeys());
        else if (scopeTag.builtinKey) dismissedBuiltinKeys.push(scopeTag.builtinKey);
        const nextScopeTags = deletesCotGroup
            ? scopeTags.filter((tag) => !isCotScopeTagEntry(tag))
            : scopeTags.filter((tag) => tag.id !== tagId);
        persistScopeTags(nextScopeTags, { dismissedBuiltinKeys });
        if (getScopeTagEditId() === tagId) resetScopeTagEditor();
        showToast('范围标签已删除');
    });

    $(document).off('click', '#bl-batch-toggle').on('click', '#bl-batch-toggle', function() {
        const $popup = $('#bl-purifier-popup');
        const isBatchMode = !$popup.hasClass('bl-is-batch-mode');
        $popup.toggleClass('bl-is-batch-mode', isBatchMode);
        $('#bl-batch-operations').toggle(isBatchMode);
        $popup.find('.bl-batch-checkbox-label').toggle(isBatchMode);
        $(this).toggleClass('bl-active', isBatchMode);
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
            markRulesDataDirty();
            saveSettingsDebounced();
            renderTagsPreserveBatchSelection();
        }
    });

    $(document).off('change', '.batch-item-checkbox').on('change', '.batch-item-checkbox', () => syncBatchSelectionStateFromDom(extension_settings[extensionName].rules || []));

    const getDiffMessageByIndex = (index) => {
        const { chat } = getAppContext();
        return Array.isArray(chat) && Number.isInteger(index) && index >= 0 && index < chat.length ? chat[index] : null;
    };

    const closeDiffActionsMenu = () => {
        $('#bl-diff-actions-menu').prop('hidden', true);
        $('#bl-diff-menu-toggle').attr('aria-expanded', 'false');
    };

    const openDiffActionsMenu = () => {
        $('#bl-diff-actions-menu').prop('hidden', false);
        $('#bl-diff-menu-toggle').attr('aria-expanded', 'true');
    };

    const syncDiffLimitControlState = (editing = false) => {
        const currentSettings = extension_settings[extensionName];
        const normalized = normalizeDiffTrackedMessageLimit(currentSettings.diffTrackedMessageLimit);
        currentSettings.diffTrackedMessageLimit = normalized;
        $('#bl-diff-limit-text').text(`最近 ${normalized} 层`);
        $('#bl-diff-limit-input')
            .attr('min', minTrackedDiffMessages)
            .attr('max', maxTrackedDiffMessages)
            .val(normalized);
        $('#bl-diff-limit-edit').prop('hidden', editing === true);
        $('#bl-diff-limit-editor').prop('hidden', editing !== true);
    };

    const closeDiffLimitEditor = () => {
        syncDiffLimitControlState(false);
    };

    const applyDiffLimitDraft = () => {
        const currentSettings = extension_settings[extensionName];
        const previous = normalizeDiffTrackedMessageLimit(currentSettings.diffTrackedMessageLimit);
        const next = normalizeDiffTrackedMessageLimit($('#bl-diff-limit-input').val());
        currentSettings.diffTrackedMessageLimit = next;
        closeDiffLimitEditor();
        if (next === previous) return;

        saveSettingsDebounced();
        syncTrackedIndicesToLatestAssistantMessages();
        injectDiffButtons();
        if (runtimeState.currentDiffIndex !== undefined) renderDiffModalContent(runtimeState.currentDiffIndex);
        showToast(`透视楼层已设为最近 ${next} 层`);
    };

    const closeDiffRelatedModal = ({ clearSelection = true } = {}) => {
        $('#bl-diff-related-body').empty();
        $('#bl-diff-related-modal').hide();
        if (clearSelection) $('#bl-diff-modal-content .bl-diff-change-selected').removeClass('bl-diff-change-selected');
    };

    const syncDiffRelatedModeState = () => {
        const enabled = runtimeState.diffRelatedRuleMode === true;
        $('#bl-diff-modal').toggleClass('bl-diff-related-mode', enabled);
        $('#bl-diff-related-mode-icon').attr('class', enabled ? 'fa-solid fa-crosshairs bl-related-active-icon' : 'fa-solid fa-crosshairs');
        $('#bl-diff-related-mode-text').text(enabled ? '相关规则：开启' : '相关规则：关闭');
        $('#bl-diff-related-mode-toggle').attr('title', enabled ? '关闭相关规则模式' : '点击差异文本后推测相关规则');
        if (!enabled) closeDiffRelatedModal();
    };

    const readDiffChangeNumber = (element, name) => {
        const value = Number(element?.getAttribute?.(`data-bl-${name}`));
        return Number.isFinite(value) ? value : null;
    };

    const getAdjacentDiffChangeElement = (element, direction) => {
        let node = element?.[direction] || null;
        while (node) {
            if (node.nodeType === Node.TEXT_NODE && String(node.textContent || '').trim() === '') {
                node = node[direction];
                continue;
            }
            if (node.nodeType === Node.ELEMENT_NODE && node.matches?.('del.bl-diff-change, ins.bl-diff-change')) return node;
            return null;
        }
        return null;
    };

    const getContextWindow = (text = '', start = 0, end = start, radius = 160) => {
        const source = String(text || '');
        const safeStart = Math.max(0, Math.min(source.length, Number(start) || 0));
        const safeEnd = Math.max(safeStart, Math.min(source.length, Number(end) || safeStart));
        return source.slice(Math.max(0, safeStart - radius), Math.min(source.length, safeEnd + radius));
    };

    const buildDiffChangeFromElement = (element) => {
        const index = runtimeState.currentDiffIndex;
        const pair = getDiffComparisonForMessage(index);
        if (!pair || !element) return null;

        const clickedType = element.getAttribute('data-bl-diff-type') || (element.tagName === 'DEL' ? 'delete' : 'insert');
        const clickedText = String(element.textContent || '');
        const previousChange = getAdjacentDiffChangeElement(element, 'previousSibling');
        const nextChange = getAdjacentDiffChangeElement(element, 'nextSibling');
        const pairedDelete = clickedType === 'delete' ? element : (previousChange?.tagName === 'DEL' ? previousChange : null);
        const pairedInsert = clickedType === 'insert' ? element : (nextChange?.tagName === 'INS' ? nextChange : null);
        const oldStart = readDiffChangeNumber(pairedDelete || element, 'old-start') ?? readDiffChangeNumber(element, 'old-start') ?? 0;
        const oldEnd = readDiffChangeNumber(pairedDelete || element, 'old-end') ?? oldStart;
        const newStart = readDiffChangeNumber(pairedInsert || element, 'new-start') ?? readDiffChangeNumber(element, 'new-start') ?? 0;
        const newEnd = readDiffChangeNumber(pairedInsert || element, 'new-end') ?? newStart;
        const deletedText = pairedDelete ? String(pairedDelete.textContent || '') : (clickedType === 'delete' ? clickedText : '');
        const insertedText = pairedInsert ? String(pairedInsert.textContent || '') : (clickedType === 'insert' ? clickedText : '');

        return {
            clickedType,
            clickedText,
            deletedText,
            insertedText,
            beforeText: deletedText,
            afterText: insertedText,
            oldStart,
            oldEnd,
            newStart,
            newEnd,
            oldContext: getContextWindow(pair.sourceDisplayText || '', oldStart, oldEnd),
            newContext: getContextWindow(pair.cleanedDisplayText || '', newStart, newEnd),
        };
    };

    const summarizeCandidateTargets = (candidate) => {
        const targets = Array.isArray(candidate.targets) ? candidate.targets.filter(Boolean) : [];
        const replacements = Array.isArray(candidate.replacements) ? candidate.replacements.filter(Boolean) : [];
        const targetText = targets.length > 0 ? targets.join(' / ') : '（空查找词）';
        const replacementText = replacements.length > 0 ? replacements.join(' / ') : '删除';
        return `${targetText} -> ${replacementText}`;
    };

    const renderRelatedRulesModal = (change, candidates) => {
        const $modal = $('#bl-diff-related-modal');
        const $body = $('#bl-diff-related-body');
        if (!$modal.length || !$body.length) return;
        const clickedText = change?.clickedText ? escapeHtml(change.clickedText).slice(0, 120) : '（空）';
        if (!Array.isArray(candidates) || candidates.length === 0) {
            $body.html(`
                <div class="bl-diff-related-head">
                    <strong><i class="fa-solid fa-crosshairs"></i> 未找到明显相关规则</strong>
                    <span>点击文本：${clickedText}</span>
                </div>
                <div class="bl-diff-related-note">这是相关规则推测，不保证为实际触发规则。</div>
            `);
            $modal.css('display', 'flex');
            return;
        }

        const items = candidates.map((candidate) => {
            const reasons = Array.isArray(candidate.reasons) && candidate.reasons.length > 0
                ? candidate.reasons.slice(0, 2).join('，')
                : '相关文本命中';
            return `
                <button type="button" class="bl-diff-related-candidate" data-rule-index="${candidate.ruleIndex}" data-subrule-index="${candidate.subRuleIndex}">
                    <span class="bl-diff-related-candidate-main">
                        <span class="bl-tag bl-badge-compact">${escapeHtml(candidate.modeLabel || candidate.mode || '规则')}</span>
                        <strong>${escapeHtml(candidate.groupName || `合集 ${candidate.ruleIndex + 1}`)}</strong>
                    </span>
                    <span class="bl-diff-related-candidate-preview">${escapeHtml(summarizeCandidateTargets(candidate))}</span>
                    <span class="bl-diff-related-candidate-reason">${escapeHtml(reasons)} · 分数 ${Math.round(candidate.score)}</span>
                </button>
            `;
        }).join('');

        $body.html(`
            <div class="bl-diff-related-head">
                <strong><i class="fa-solid fa-crosshairs"></i> 可能相关规则</strong>
                <span>点击文本：${clickedText}</span>
            </div>
            <div class="bl-diff-related-note">相关规则推测，不保证为实际触发规则。最多显示 10 条。</div>
            <div class="bl-diff-related-list">${items}</div>
        `);
        $modal.css('display', 'flex');
    };

    const showRelatedRulesForDiffElement = (element) => {
        const change = buildDiffChangeFromElement(element);
        if (!change) return;
        const rules = extension_settings[extensionName]?.rules || [];
        const candidates = findRelatedRulesForDiffChange(change, rules, { maxCount: 10 });
        renderRelatedRulesModal(change, candidates);
    };

    const syncDiffModeToggleState = (mode) => {
        const isFullMode = mode === 'full';
        const nextText = isFullMode ? '切回片段' : '全文模式';
        const nextTitle = isFullMode ? '切回片段模式' : '切换到全文模式';
        $('#bl-diff-mode-text').text(nextText);
        $('#bl-diff-mode-icon').attr('class', isFullMode ? 'fa-solid fa-list-ul' : 'fa-solid fa-file-lines');
        $('#bl-diff-mode-toggle').attr('title', nextTitle).attr('aria-label', nextTitle);
    };

    const syncDiffPositionMenuState = (settings) => {
        const shouldExposeTopButton = settings.diffButtonInExtraMenu === true;
        $('#bl-diff-menu-pos-icon').attr('class', shouldExposeTopButton ? 'fa-solid fa-thumbtack' : 'fa-solid fa-ellipsis');
        $('#bl-diff-menu-pos-text').text(shouldExposeTopButton ? '顶部按钮：外显' : '顶部按钮：收纳');
        $('#bl-diff-menu-pos-toggle').attr('title', shouldExposeTopButton ? '将顶部按钮恢复为外显' : '将顶部按钮收纳进菜单');
    };

    const syncDiffBottomMenuState = (settings) => {
        const isBottomVisible = settings.showBottomDiffButton !== false;
        $('#bl-diff-menu-bottom-icon').attr('class', isBottomVisible ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye');
        $('#bl-diff-menu-bottom-text').text(isBottomVisible ? '尾部按钮：隐藏' : '尾部按钮：显示');
        $('#bl-diff-menu-bottom-toggle').attr('title', isBottomVisible ? '隐藏消息尾部按钮' : '显示消息尾部按钮');
    };

    const syncDiffPreferenceMenuState = () => {
        const settings = extension_settings[extensionName];
        syncDiffLimitControlState(false);
        syncDiffRelatedModeState();
        syncDiffPositionMenuState(settings);
        syncDiffBottomMenuState(settings);
    };

    const syncDiffRevertToggleState = (msg) => {
        const isReverted = msg?.__bl_is_reverted === true;
        const revertTitle = isReverted ? '重新净化文本' : '撤回净化并保护原文';
        $('#bl-diff-revert-icon').attr('class', isReverted ? 'fas fa-wand-magic-sparkles' : 'fas fa-rotate-left');
        $('#bl-diff-revert-text').text(isReverted ? '重新净化' : '撤回净化');
        $('#bl-diff-revert-toggle').attr('title', revertTitle);
        $('#bl-diff-mode-toggle').toggle(!isReverted);
    };

    const refreshMessageAfterRevertToggle = (index, msg) => {
        const { chat } = getAppContext();
        if (!Number.isInteger(index) || index < 0 || !Array.isArray(chat) || !msg) return;
        const finishRefresh = () => {
            const messageNode = getMessageDomNode(index);
            if (messageNode && msg.__bl_is_reverted !== true) purifyDOM(messageNode);
            injectDiffButtons([index]);
            renderDiffModalContent(index);
        };
        const refreshAndFinish = () => {
            refreshMessageDisplay(index, { allowReloadFallback: true });
            finishRefresh();
        };
        refreshAndFinish();
        window.requestAnimationFrame?.(() => finishRefresh());
        window.setTimeout(refreshAndFinish, 50);
        window.setTimeout(() => {
            refreshMessageDisplay(index, { emitRenderedEvent: 'auto' });
            finishRefresh();
        }, 100);
        window.setTimeout(finishRefresh, 150);
        queueIncrementalChatSave();
    };

    const toggleCurrentDiffRevert = () => {
        const index = runtimeState.currentDiffIndex;
        const msg = getDiffMessageByIndex(index);
        if (!Number.isInteger(index) || index < 0 || !msg || typeof msg !== 'object') return;

        if (msg.__bl_is_reverted === true) {
            const sourceMes = typeof msg.mes === 'string' ? msg.mes : '';
            delete msg.__bl_is_reverted;
            cleanseMessageDataAtIndex(index, { diffSourceMes: sourceMes });
        } else {
            const originalMes = getCurrentMessageOriginalMes(msg);
            if (originalMes) {
                msg.mes = originalMes;
                setCurrentSwipeText(msg, originalMes);
            }
            msg.__bl_is_reverted = true;
            clearTrackedDiffEntry(index);
        }

        closeDiffActionsMenu();
        refreshMessageAfterRevertToggle(index, msg);
    };

    const closeDiffModal = () => {
        closeDiffActionsMenu();
        closeDiffRelatedModal();
        runtimeState.diffRelatedRuleMode = false;
        syncDiffRelatedModeState();
        $('#bl-diff-modal').hide();
    };

    function renderDiffModalContent(index) {
        const settings = extension_settings[extensionName];
        const mode = settings.diffViewMode || 'snippet';
        const msg = getDiffMessageByIndex(index);
        const contentEl = $('#bl-diff-modal-content');
        closeDiffRelatedModal();
        syncDiffPreferenceMenuState();
        syncDiffModeToggleState(mode);
        syncDiffRevertToggleState(msg);

        if (msg?.__bl_is_reverted) {
            contentEl.html('<div class="bl-diff-empty"><i class="fas fa-shield-halved" style="margin-right:6px;"></i>此消息已撤回并处于免净化保护状态，当前显示为原始文本。点击 <i class="fas fa-wand-magic-sparkles bl-diff-inline-icon"></i> 重新净化文本。</div>');
            return;
        }

        refreshDiffCacheIfStale(index);
        const state = getDiffStateForMessage(index);
        const cached = getDiffSnippetsForMessage(index);

        if (state.status !== 'ready') {
            contentEl.html('<div class="bl-diff-loading"><i class="fas fa-spinner fa-spin"></i><span>Loading...</span></div>');
            return;
        }
        if (mode === 'full') {
            contentEl.html(`<div class="bl-diff-full-text">${cached.fullDiff || '<div class="bl-diff-empty">当前消息未触发差异。</div>'}</div>`);
        } else {
            contentEl.html(cached.snippets.length > 0 ? cached.snippets.join('<hr class="bl-diff-divider">') : '<div class="bl-diff-empty">当前消息未触发差异。</div>');
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
        runtimeState.currentDiffIndex = index;
        closeDiffRelatedModal();
        renderDiffModalContent(index);
        closeDiffActionsMenu();
        $('#bl-diff-modal').css('display', 'flex');
    });

    $(document).off('click', '#bl-diff-menu-toggle').on('click', '#bl-diff-menu-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if ($('#bl-diff-actions-menu').prop('hidden')) openDiffActionsMenu();
        else closeDiffActionsMenu();
    });

    $(document).off('click', '#bl-diff-actions-menu').on('click', '#bl-diff-actions-menu', function(e) {
        e.stopPropagation();
    });

    $(document).off('click.bl-diff-menu').on('click.bl-diff-menu', function(e) {
        if ($(e.target).closest('#bl-diff-menu-toggle, #bl-diff-actions-menu').length === 0) closeDiffActionsMenu();
    });

    $(document).off('click', '#bl-diff-menu-pos-toggle').on('click', '#bl-diff-menu-pos-toggle', function() {
        const settings = extension_settings[extensionName];
        settings.diffButtonInExtraMenu = !settings.diffButtonInExtraMenu;
        saveSettingsDebounced();
        syncDiffPreferenceMenuState();
        closeDiffActionsMenu();
        injectDiffButtons();
    });

    $(document).off('click', '#bl-diff-menu-bottom-toggle').on('click', '#bl-diff-menu-bottom-toggle', function() {
        const settings = extension_settings[extensionName];
        settings.showBottomDiffButton = settings.showBottomDiffButton === false;
        saveSettingsDebounced();
        syncDiffPreferenceMenuState();
        closeDiffActionsMenu();
        injectDiffButtons();
    });

    $(document).off('click', '#bl-diff-mode-toggle').on('click', '#bl-diff-mode-toggle', function() {
        const settings = extension_settings[extensionName];
        settings.diffViewMode = settings.diffViewMode === 'full' ? 'snippet' : 'full';
        saveSettingsDebounced();
        if (runtimeState.currentDiffIndex !== undefined) renderDiffModalContent(runtimeState.currentDiffIndex);
    });

    $(document).off('click', '#bl-diff-related-mode-toggle').on('click', '#bl-diff-related-mode-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        runtimeState.diffRelatedRuleMode = runtimeState.diffRelatedRuleMode !== true;
        syncDiffRelatedModeState();
        closeDiffActionsMenu();
    });

    $(document).off('click', '#bl-diff-limit-edit').on('click', '#bl-diff-limit-edit', function(e) {
        e.preventDefault();
        e.stopPropagation();
        closeDiffActionsMenu();
        syncDiffLimitControlState(true);
        $('#bl-diff-limit-input').trigger('focus').trigger('select');
    });

    $(document).off('click', '#bl-diff-limit-confirm').on('click', '#bl-diff-limit-confirm', function(e) {
        e.preventDefault();
        e.stopPropagation();
        applyDiffLimitDraft();
    });

    $(document).off('click', '#bl-diff-limit-cancel').on('click', '#bl-diff-limit-cancel', function(e) {
        e.preventDefault();
        e.stopPropagation();
        closeDiffLimitEditor();
    });

    $(document).off('keydown', '#bl-diff-limit-input').on('keydown', '#bl-diff-limit-input', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            applyDiffLimitDraft();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeDiffLimitEditor();
        }
    });

    $(document).off('click', '#bl-diff-revert-toggle').on('click', '#bl-diff-revert-toggle', () => toggleCurrentDiffRevert());

    $(document).off('click', '#bl-diff-modal-content del.bl-diff-change, #bl-diff-modal-content ins.bl-diff-change').on('click', '#bl-diff-modal-content del.bl-diff-change, #bl-diff-modal-content ins.bl-diff-change', function(e) {
        if (runtimeState.diffRelatedRuleMode !== true) return;
        e.preventDefault();
        e.stopPropagation();
        $('#bl-diff-modal-content .bl-diff-change').removeClass('bl-diff-change-selected');
        $(this).addClass('bl-diff-change-selected');
        showRelatedRulesForDiffElement(this);
    });

    $(document).off('click', '.bl-diff-related-candidate').on('click', '.bl-diff-related-candidate', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const ruleIndex = Number($(this).attr('data-rule-index'));
        const subRuleIndex = Number($(this).attr('data-subrule-index'));
        const rules = extension_settings[extensionName]?.rules || [];
        if (!Number.isInteger(ruleIndex) || ruleIndex < 0 || ruleIndex >= rules.length) return;
        if (!Number.isInteger(subRuleIndex) || subRuleIndex < 0 || subRuleIndex >= (rules[ruleIndex]?.subRules || []).length) return;
        closeDiffRelatedModal();
        openEditModal(ruleIndex, { source: 'search', returnMode: 'related', subRuleIndex });
        openSingleRuleModal(subRuleIndex, { hideEditModal: true });
    });

    $(document).off('click', '#bl-diff-related-close').on('click', '#bl-diff-related-close', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeDiffRelatedModal();
    });
    $(document).off('click', '#bl-diff-related-modal').on('click', '#bl-diff-related-modal', function(e) {
        if (e.target && e.target.id === 'bl-diff-related-modal') closeDiffRelatedModal();
    });

    $(document).off('click', '#bl-diff-modal-close').on('click', '#bl-diff-modal-close', () => closeDiffModal());
    $(document).off('click', '#bl-diff-modal').on('click', '#bl-diff-modal', function(e) { if (e.target && e.target.id === 'bl-diff-modal') closeDiffModal(); });
    
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
        markRulesDataDirty();
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
        markRulesDataDirty();
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
        markRulesDataDirty();
        saveSettingsDebounced();
        renderTagsPreserveBatchSelection();
        performGlobalCleanse();
    });

    $(document).off('click', '.bl-rule-del').on('click', '.bl-rule-del', function() {
        if (!confirm('确定要删除这个规则分组吗？删除后无法恢复。')) return; 
        const rules = extension_settings[extensionName].rules || [];
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        const deletingCount = shouldBatchTransferRule(index, rules) ? getSelectedIndexesFromState(rules).length : 1;
        if (handleDeleteRule(index, rules)) {
            markRulesDataDirty();
            saveSettingsDebounced();
            renderTagsPreserveBatchSelection();
            showToast(deletingCount > 1 ? `已删除 ${deletingCount} 个合集` : '合集删除成功');
        }
    });

    $(document).off('click', '#bl-add-subrule-btn').on('click', '#bl-add-subrule-btn', () => openSingleRuleModal(-1));

    $(document).off('change', '.bl-subrule-toggle').on('change', '.bl-subrule-toggle', function() {
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= runtimeState.currentEditingSubrules.length) return;
        runtimeState.currentEditingSubrules[index].enabled = $(this).prop('checked');
        renderSubrulesToModal();
    });

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
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= runtimeState.currentEditingSubrules.length) return;
        if (!confirm('确定要删除该映射规则吗？')) return;
        runtimeState.currentEditingSubrules.splice(index, 1);
        renderSubrulesToModal();
        showToast('词条删除成功');
    });

    $(document).off('click', '.bl-edit-subrule-btn').on('click', '.bl-edit-subrule-btn', function() {
        openSingleRuleModal($(this).data('index'));
    });

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
        applySubruleModeUI(String($(this).val() || 'simple'));
    });

    $(document).off('input', '#bl-modal-sub-target').on('input', '#bl-modal-sub-target', () => {
        if ($('#bl-modal-sub-mode').val() === 'regex') validateRegexTargetField();
    });

    $(document).off('click', '#bl-modal-sub-regex-recognize').on('click', '#bl-modal-sub-regex-recognize', () => {
        const result = recognizeRegexReplacementInput();
        if (!result.ok) {
            showToast('留空会直接删除，直接保存条目即可。');
            $('#bl-modal-sub-rep').trigger('focus');
            return;
        }
    });

    $(document).off('click', '.bl-regex-replacement-chip-main').on('click', '.bl-regex-replacement-chip-main', function() {
        if (startEditingRegexReplacementInput($(this).data('index'))) {
            $('#bl-modal-sub-rep').trigger('focus');
        }
    });

    $(document).off('click', '.bl-regex-replacement-chip-remove').on('click', '.bl-regex-replacement-chip-remove', function(e) {
        e.preventDefault();
        e.stopPropagation();
        removeRegexReplacementInput($(this).data('index'));
    });

    $(document).off('click', '#bl-modal-sub-save').on('click', '#bl-modal-sub-save', function() {
        const mode = String($('#bl-modal-sub-mode').val() || 'simple');
        const tStr = String($('#bl-modal-sub-target').val() || '');
        const remarkStr = String($('#bl-modal-sub-remark').val() || '').trim();
        const isDirectSearchFlow = isSearchDirectSubruleFlow();
        const isRelatedFlow = isRelatedDirectSubruleFlow();

        if (mode === 'regex') {
            const validation = validateRegexTargetField();
            if (!validation.ok) {
                showToast(`正则规则有误：${validation.uiMessage || formatRegexTargetError(validation.error)}`);
                $('#bl-modal-sub-target').trigger('focus');
                return;
            }
        } else {
            clearRegexTargetValidationState();
        }

        if (mode === 'regex' && hasPendingRegexReplacementInput()) {
            showToast('替换框里还有未处理的内容，请先点右侧按钮。');
            $('#bl-modal-sub-rep').trigger('focus');
            return;
        }
        
        const targets = parseInputToWords(tStr, mode, { isTarget: true });
        const replacements = getSingleRuleReplacementValues(mode);

        if (targets.length === 0) {
            showToast("查找内容不能为空！");
            $('#bl-modal-sub-target').trigger('focus');
            return;
        }

        const previousSubRule = runtimeState.currentSubruleEditIndex >= 0
            ? runtimeState.currentEditingSubrules[runtimeState.currentSubruleEditIndex]
            : null;
        const subRule = {
            targets,
            replacements,
            mode,
            remark: remarkStr,
            enabled: previousSubRule?.enabled !== false,
        };

        if (runtimeState.currentSubruleEditIndex === -1) {
            runtimeState.currentEditingSubrules.push(subRule);
        } else {
            runtimeState.currentEditingSubrules[runtimeState.currentSubruleEditIndex] = subRule;
        }

        clearRegexTargetValidationState();
        if (isDirectSearchFlow || isRelatedFlow) {
            const saveResult = saveCurrentEditingRule({ toastMessage: '条目保存成功', focusLatest: false });
            if (!saveResult.ok) return;
            $('#bl-subrule-edit-modal').fadeOut(150, () => {
                $('#bl-rule-edit-modal').hide();
                clearRuleSearchEditFlow();
                if (isDirectSearchFlow) openRuleSearchModal();
                else if (runtimeState.currentDiffIndex !== undefined) renderDiffModalContent(runtimeState.currentDiffIndex);
            });
            return;
        }

        $('#bl-subrule-edit-modal').fadeOut(150);
        renderSubrulesToModal();

        if (runtimeState.currentSubruleEditIndex === -1) {
            const container = $('#bl-edit-subrules-container');
            container.scrollTop(container[0].scrollHeight);
        }
    });

    $(document).off('click', '#bl-modal-sub-cancel').on('click', '#bl-modal-sub-cancel', () => {
        clearRegexTargetValidationState();
        if (isSearchDirectSubruleFlow() || isRelatedDirectSubruleFlow()) {
            const shouldReturnSearch = isSearchDirectSubruleFlow();
            $('#bl-subrule-edit-modal').fadeOut(150, () => {
                $('#bl-rule-edit-modal').hide();
                clearRuleSearchEditFlow();
                if (shouldReturnSearch) openRuleSearchModal();
            });
            return;
        }
        $('#bl-subrule-edit-modal').fadeOut(150);
    });

    $(document).off('click', '#bl-edit-cancel-x').on('click', '#bl-edit-cancel-x', () => {
        $('#bl-rule-edit-modal').hide();
        if (isSearchGroupEditFlow()) {
            clearRuleSearchEditFlow();
            openRuleSearchModal();
        }
    });
    $(document).off('click', '#bl-transfer-cancel').on('click', '#bl-transfer-cancel', () => closeTransferModal());
    $(document).off('click', '#bl-transfer-copy').on('click', '#bl-transfer-copy', () => runRuleTransfer(false));
    $(document).off('click', '#bl-transfer-move').on('click', '#bl-transfer-move', () => runRuleTransfer(true));
    $(document).off('click', '#bl-rule-transfer-modal').on('click', '#bl-rule-transfer-modal', function(e) {
        if (e.target && e.target.id === 'bl-rule-transfer-modal') closeTransferModal();
    });

    $(document).off('click', '#bl-edit-save').on('click', '#bl-edit-save', () => {
        const saveResult = saveCurrentEditingRule({ toastMessage: '合集保存成功', focusLatest: true });
        if (!saveResult.ok) return;
        $('#bl-rule-edit-modal').hide();
        if (isSearchGroupEditFlow()) {
            clearRuleSearchEditFlow();
            openRuleSearchModal();
        }
    });

    $(document).off('click', '#bl-deep-clean-btn').on('click', '#bl-deep-clean-btn', () => showConfirmModal(() => performDeepCleanse()));

    $(document).off('change', '#bl-preset-select').on('change', '#bl-preset-select', function() {
        const settings = extension_settings[extensionName];
        const oldPreset = settings.activePreset;
        const newPreset = $(this).val();

        if (oldPreset && newPreset !== oldPreset && checkUnsavedChanges()) {
            if (confirm(`预设 "${oldPreset}" 有未保存的改动，是否在切换前保存？\n点击【确定】保存，点击【取消】放弃改动。`)) {
                settings.presets[oldPreset] = JSON.parse(JSON.stringify(settings.rules));
                saveSettingsDebounced();
            }
        }

        applyPresetByName(newPreset, { skipRender: true });
        renderTags();
        refreshCharacterBindingUI();
    });

    $(document).off('change.bl-purifier-chat-preset-binding', '#settings_preset_openai').on('change.bl-purifier-chat-preset-binding', '#settings_preset_openai', function() {
        setTimeout(() => {
            applyCharacterPresetBinding(true, { skipCleanse: true });
            refreshCharacterBindingUI();
        }, 0);
    });

    $(document).off('click', '#bl-default-toggle').on('click', '#bl-default-toggle', function() {
        const settings = extension_settings[extensionName];
        const activePreset = String(settings.activePreset || '');
        if (!activePreset) { alert('请先在下拉框中选择一个净化预设。'); return; }
        const isDefaultActive = settings.defaultPreset === activePreset;
        settings.defaultPreset = isDefaultActive ? "" : activePreset;
        saveSettingsDebounced();
        refreshCharacterBindingUI();
        showToast(isDefaultActive ? '已取消全局默认' : `已设为全局默认：${activePreset}`);
    });

    $(document).off('click', '#bl-character-bind-toggle').on('click', '#bl-character-bind-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const $menu = $('#bl-bind-menu');
        const shouldOpen = $menu.prop('hidden');
        $menu.prop('hidden', !shouldOpen);
        $(this).attr('aria-expanded', String(shouldOpen));
        refreshCharacterBindingUI();
    });

    $(document).off('click', '.bl-bind-menu-item').on('click', '.bl-bind-menu-item', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if ($(this).prop('disabled')) return;
        const settings = extension_settings[extensionName];
        const action = String($(this).attr('data-bind-action') || '');
        const activePreset = String(settings.activePreset || '');
        const context = getCurrentCharacterContext();
        const chatCompletionPresetName = getCurrentChatCompletionPresetName();
        const activeUsage = getPresetBindingUsage(activePreset);

        if (action === 'character') {
            if (!activePreset) { alert('请先在下拉框中选择一个净化预设。'); return; }
            if (!context.key) { alert('当前页面未识别到可绑定角色。'); refreshCharacterBindingUI(); return; }
            if (activeUsage.hasChatCompletionPresetBindings && settings.characterBindings?.[context.key] !== activePreset) {
                const shouldSwitch = confirm(`净化预设「${activePreset}」当前是对话补全预设绑定。是否切换为角色绑定？\n这会移除它已有的 ${activeUsage.chatCompletionPresetNames.length} 个对话补全预设绑定。`);
                if (!shouldSwitch) {
                    refreshCharacterBindingUI();
                    return;
                }
                removeBindingEntriesForPreset(settings.chatCompletionPresetBindings, activePreset);
            }
            if (!settings.characterBindings) settings.characterBindings = {};
            settings.characterBindings[context.key] = activePreset;
            runtimeState.lastCharacterContextKey = context.key;
            runtimeState.lastPresetBindingSignature = "";
            applyPresetByName(activePreset, { skipRender: true });
            saveSettingsDebounced();
            refreshCharacterBindingUI();
            $('#bl-bind-menu').prop('hidden', true);
            $('#bl-character-bind-toggle').attr('aria-expanded', 'false');
            showToast(`已绑定：${context.name} → ${activePreset}`);
            return;
        }

        if (action === 'chat-preset') {
            if (!activePreset) { alert('请先在下拉框中选择一个净化预设。'); return; }
            if (!chatCompletionPresetName) { alert('当前没有识别到 ST 对话补全预设。'); refreshCharacterBindingUI(); return; }
            if (activeUsage.hasCharacterBindings && settings.chatCompletionPresetBindings?.[chatCompletionPresetName] !== activePreset) {
                const shouldSwitch = confirm(`净化预设「${activePreset}」当前是角色绑定。是否切换为对话补全预设绑定？\n这会移除它已有的 ${activeUsage.characterKeys.length} 个角色绑定。`);
                if (!shouldSwitch) {
                    refreshCharacterBindingUI();
                    return;
                }
                removeBindingEntriesForPreset(settings.characterBindings, activePreset);
            }
            if (!settings.chatCompletionPresetBindings || typeof settings.chatCompletionPresetBindings !== 'object') settings.chatCompletionPresetBindings = {};
            settings.chatCompletionPresetBindings[chatCompletionPresetName] = activePreset;
            runtimeState.lastPresetBindingSignature = "";
            applyPresetByName(activePreset, { skipRender: true });
            saveSettingsDebounced();
            refreshCharacterBindingUI();
            $('#bl-bind-menu').prop('hidden', true);
            $('#bl-character-bind-toggle').attr('aria-expanded', 'false');
            showToast(`已绑定：对话补全预设 ${chatCompletionPresetName} → ${activePreset}`);
            return;
        }

        if (action === 'unbind-character') {
            const removedRolePreset = context.key ? settings.characterBindings?.[context.key] : '';
            const removedChatPreset = chatCompletionPresetName ? settings.chatCompletionPresetBindings?.[chatCompletionPresetName] : '';
            if (removedRolePreset) {
                delete settings.characterBindings[context.key];
            } else if (removedChatPreset) {
                delete settings.chatCompletionPresetBindings[chatCompletionPresetName];
            } else {
                refreshCharacterBindingUI();
                return;
            }
            runtimeState.lastCharacterContextKey = "";
            runtimeState.lastPresetBindingSignature = "";
            applyCharacterPresetBinding(true);
            saveSettingsDebounced();
            refreshCharacterBindingUI();
            $('#bl-bind-menu').prop('hidden', true);
            $('#bl-character-bind-toggle').attr('aria-expanded', 'false');
            showToast(removedRolePreset ? '已取消当前角色绑定，改为跟随全局默认' : '已取消当前对话补全预设绑定，改为跟随全局默认');
            return;
        }

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
        Object.keys(settings.chatCompletionPresetBindings || {}).forEach((name) => {
            if (settings.chatCompletionPresetBindings[name] === oldName) settings.chatCompletionPresetBindings[name] = newName;
        });
        settings.activePreset = newName;
        markPresetsUiDirty(true);
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
            Object.keys(settings.chatCompletionPresetBindings || {}).forEach((presetName) => {
                if (settings.chatCompletionPresetBindings[presetName] === name) delete settings.chatCompletionPresetBindings[presetName];
            });
            settings.activePreset = "";
            settings.rules = [];
            markRulesDataDirty({ presetsUi: true });
            saveSettingsDebounced();
            renderTags();
            updateToolbarUI();
            performGlobalCleanse();
            showToast("删除成功");
        }
    });

    $(document).off('click', '#bl-preset-new').on('click', '#bl-preset-new', function() {
        const settings = extension_settings[extensionName];
        const name = prompt("输入新存档名称：");
        if (!name) return;
        if (settings.presets[name]) { alert("存档名称已存在。"); return; }
        settings.presets[name] = [];
        settings.activePreset = name;
        settings.rules = [];
        markRulesDataDirty({ presetsUi: true });
        saveSettingsDebounced();
        updateToolbarUI();
        renderTags(); // 必须重新渲染以清空列表
    });

    $(document).off('click', '#bl-preset-save').on('click', '#bl-preset-save', function() {
        const settings = extension_settings[extensionName];
        if (!settings.activePreset) { showToast("当前为临时规则，请点击“新建”保存为新存档。"); return; }
        settings.presets[settings.activePreset] = JSON.parse(JSON.stringify(settings.rules));
        saveSettingsDebounced();
        showToast("保存成功");
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
        input.accept = '.json,application/json';
        input.style.position = 'fixed';
        input.style.left = '-1000px';
        input.style.top = '0';
        input.style.width = '1px';
        input.style.height = '1px';
        input.style.opacity = '0';
        input.style.pointerEvents = 'none';
        document.body.appendChild(input);
        const cleanupInput = () => {
            window.setTimeout(() => {
                if (input.parentNode) input.parentNode.removeChild(input);
            }, 0);
        };
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) {
                cleanupInput();
                return;
            }
            const reader = new FileReader();
            reader.onload = event => {
                try {
                    const importedRules = normalizeImportedRulesPayload(JSON.parse(event.target.result));
                    if (!Array.isArray(importedRules)) throw new Error("格式非数组");

                    const defaultName = file.name.replace(/\.json$/i, '');
                    if (!confirmBeforeImportChoiceIfUnsaved()) return;
                    openImportChoiceModal(importedRules, defaultName);
                } catch (err) {
                    alert("导入失败：检查文件是否为合法规则数组。");
                } finally {
                    cleanupInput();
                }
            };
            reader.onerror = cleanupInput;
            reader.readAsText(file);
        };
        input.click();
        window.setTimeout(cleanupInput, 120000);
    });

    $(document).off('click', '#bl-import-only').on('click', '#bl-import-only', () => importPresetOnly());
    $(document).off('click', '#bl-import-switch').on('click', '#bl-import-switch', () => importPresetAndSwitch());
    $(document).off('click', '#bl-import-preview').on('click', '#bl-import-preview', () => importPresetAsTemporaryPreview());
    $(document).off('click', '#bl-import-choice-close').on('click', '#bl-import-choice-close', () => closeImportChoiceModal());
    $(document).off('click', '#bl-preset-import-choice-modal').on('click', '#bl-preset-import-choice-modal', function(e) {
        if (e.target && e.target.id === 'bl-preset-import-choice-modal') closeImportChoiceModal();
    });
    $(document).off('keydown', '#bl-import-preset-name').on('keydown', '#bl-import-preset-name', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            importPresetOnly();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeImportChoiceModal();
        }
    });

    const markPendingFromPayload = (payload, options = {}) => {
        const { chat } = getAppContext();
        let index = getMessageIndexFromEvent(payload);
        if (index < 0) index = getLatestMessageIndex();
        if (index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return;
        captureDiffRawSource(index);
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

    if (isTauriTavernHost() || isBaiBaiToolkitInstalled()) {
        let updateCleanseTimer = null;
        const pendingRenderedCleanseIndices = new Set();
        const shouldSkipOwnRenderedEvent = (index) => {
            const until = runtimeState.hostRenderedEventSuppressUntil?.get(index);
            if (!Number.isFinite(until)) return false;
            if (Date.now() <= until) return true;
            runtimeState.hostRenderedEventSuppressUntil.delete(index);
            return false;
        };
        const scheduleRenderedMessageCleanse = (payload, delay = 120) => {
            const explicitIndex = getMessageIndexFromEvent(payload);
            const index = explicitIndex >= 0 ? explicitIndex : getLatestMessageIndex();
            if (index < 0) return;
            if (shouldSkipOwnRenderedEvent(index)) return;
            pendingRenderedCleanseIndices.add(index);
            markPendingFromPayload(index);
            if (updateCleanseTimer) clearTimeout(updateCleanseTimer);
            updateCleanseTimer = setTimeout(() => {
                const indices = [...pendingRenderedCleanseIndices];
                pendingRenderedCleanseIndices.clear();
                indices.forEach((messageIndex) => {
                    performIncrementalCleanse(messageIndex, { visualOnly: false, fallbackLatest: true });
                });
            }, delay);
        };

        if (event_types.MESSAGE_UPDATED) eventSource.on(event_types.MESSAGE_UPDATED, (payload) => scheduleRenderedMessageCleanse(payload, 120));
        if (event_types.CHARACTER_MESSAGE_RENDERED) eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (payload) => scheduleRenderedMessageCleanse(payload, 180));
    }

    if (event_types.GENERATION_STARTED) eventSource.on(event_types.GENERATION_STARTED, () => { runtimeState.isStreamingGeneration = true; });
    if (event_types.STREAM_TOKEN_RECEIVED) eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => { runtimeState.isStreamingGeneration = true; });
    if (event_types.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, (payload) => delayedIncrementalCleanse(payload));
    if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, (payload) => delayedIncrementalCleanse(payload));
    if (event_types.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, (payload) => delayedIncrementalCleanse(payload));
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, (payload) => delayedIncrementalCleanse(payload));
    if (event_types.PRESET_CHANGED) {
        eventSource.on(event_types.PRESET_CHANGED, (payload) => {
            if (payload && payload.apiId && payload.apiId !== 'openai') return;
            setTimeout(() => applyCharacterPresetBinding(true, { skipCleanse: true }), 0);
        });
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            resetDiffRuntimeState();
            runtimeState.currentDiffIndex = undefined;
            $('#bl-diff-modal').hide();
            applyCharacterPresetBinding(true, { skipCleanse: true });
            restoreDiffStateFromChatMetadata();
            setTimeout(() => { injectDiffButtons(); performGlobalCleanse({ deferLargeChat: true }); }, 120);
        });
    }

    setInterval(() => applyCharacterPresetBinding(false, { skipCleanse: true }), 1200);
}
