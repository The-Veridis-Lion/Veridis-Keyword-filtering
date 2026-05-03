import { extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';
import { buildSimpleWildcardPattern, compileRegexTarget } from './utils.js';
import { deepCleanObjectSync } from './cleanse.js';
import { buildDiffSnippetsFromText, computeMessageSignature, ensureMessageDiffButton, getLatestTrackableDiffIndices, hasRealDiffCache, injectDiffButtons, isAssistantMessage, markDiffComparisonPending, syncTrackedIndicesToLatestAssistantMessages, writeReadyDiffCache, clearTrackedDiffEntry } from './diff.js';
import { getMessageDomNode, purifyDOM } from './dom.js';

/**
 * 按当前规则构建净化处理器。
 * @returns {Array} 处理器数组。
 */
export function buildProcessors() {
    if (!runtimeState.isRegexDirty) return runtimeState.activeProcessors;
    const { extension_settings } = getAppContext();
    const rules = extension_settings[extensionName]?.rules || [];

    let textTargets = [];
    let wordToReplacements = Object.create(null);
    let processors = [];

    for (const rule of rules) {
        if (rule.enabled === false) continue;
        const subRulesToProcess = Array.isArray(rule.subRules) ? rule.subRules : [];

        for (const sub of subRulesToProcess) {
            const mode = sub.mode || 'text';
            const targets = Array.isArray(sub.targets) ? sub.targets : [];
            const replacements = Array.isArray(sub.replacements) ? sub.replacements : [];

            if (mode === 'text') {
                for (const t of targets) {
                    if (t) {
                        textTargets.push(t);
                        wordToReplacements[t] = replacements;
                    }
                }
            } else if (mode === 'regex') {
                for (const t of targets) {
                    if (t) {
                        const compiled = compileRegexTarget(t);
                        if (!compiled.ok) {
                            logger.warn(`忽略非法正则表达式: ${t} (${compiled.error.message})`);
                            continue;
                        }
                        processors.push({ regex: compiled.value.regex, replacements, kind: 'regex' });
                    }
                }
            } else if (mode === 'simple') {
                for (const t of targets) {
                    if (t) {
                        try {
                            let escaped = t.replace(/[.+^$()[\]\\]/g, '\\$&');
                            // 展开 {A,B} 备选分组，并将 * 转为受限通配片段。
                            escaped = escaped.replace(/\{([^}]+)\}/g, (match, group) => {
                                return '(?:' + group.split(',').map(s => s.trim()).join('|') + ')';
                            });
                            escaped = escaped.replace(/\*/g, buildSimpleWildcardPattern());

                            let testRegex = new RegExp(escaped, 'gmu');
                            if (testRegex.test("")) {
                                logger.warn(`拦截到危险的简易空匹配规则，已忽略: ${t}`);
                                return;
                            }

                            processors.push({ regex: testRegex, replacements, kind: 'simple' });
                        } catch (e) {
                            logger.warn(`简易规则解析失败: ${t}`);
                        }
                    }
                }
            }
        }
    }

    if (textTargets.length > 0) {
        const uniqueTargets = [...new Set(textTargets)];
        const sorted = uniqueTargets.sort((a, b) => b.length - a.length);
        const escaped = sorted.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const textRegex = new RegExp(`(${escaped.join('|')})`, 'gmu');
        processors.unshift({ regex: textRegex, replacerMap: wordToReplacements, kind: 'text' });
    }

    runtimeState.activeProcessors = processors;
    runtimeState.isRegexDirty = false;
    const regexProcessorCount = processors.filter((processor) => processor.kind === 'regex').length;
    const simpleProcessorCount = processors.filter((processor) => processor.kind === 'simple').length;
    logger.info(`规则处理器构建完成，共 ${processors.length} 个处理器（文本:${textTargets.length} | 正则:${regexProcessorCount} | 简易:${simpleProcessorCount}）`);
    return runtimeState.activeProcessors;
}

/**
 * 从替换词列表中选择一个替换值（可选确定性模式）。
 * @param {string[]} replacements 候选替换词列表。
 * @param {string} [deterministicKey=""] 确定性模式键。
 * @returns {string} 最终替换词。
 */
export function pickReplacement(replacements, deterministicKey = "") {
    if (!Array.isArray(replacements) || replacements.length === 0) return '';
    if (!deterministicKey) {
        const randIndex = Math.floor(Math.random() * replacements.length);
        return replacements[randIndex];
    }

    let hash = 0;
    for (let i = 0; i < deterministicKey.length; i++) {
        hash = ((hash << 5) - hash) + deterministicKey.charCodeAt(i);
        hash |= 0;
    }
    const idx = Math.abs(hash) % replacements.length;
    return replacements[idx];
}

function extractRegexCaptures(args) {
    const hasNamedGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
    const trailingMetaCount = hasNamedGroups ? 3 : 2;
    const captureCount = Math.max(0, args.length - trailingMetaCount);
    return args.slice(0, captureCount);
}

function renderRegexReplacementTemplate(template, captures) {
    const source = String(template ?? '');
    let output = '';

    for (let index = 0; index < source.length; index++) {
        const char = source[index];

        if (char === '\\') {
            const nextChar = source[index + 1];
            if (nextChar === undefined) {
                output += '\\';
                continue;
            }
            if (nextChar === 'n') output += '\n';
            else if (nextChar === 'r') output += '\r';
            else if (nextChar === 't') output += '\t';
            else if (nextChar === '\\') output += '\\';
            else if (nextChar === '$') output += '$';
            else output += `\\${nextChar}`;
            index++;
            continue;
        }

        if (char === '$') {
            const firstDigit = source[index + 1];
            if (/[1-9]/.test(firstDigit || '')) {
                let captureDigits = firstDigit;
                const secondDigit = source[index + 2];
                if (/\d/.test(secondDigit || '')) captureDigits += secondDigit;
                const captureIndex = Number(captureDigits) - 1;
                output += captures[captureIndex] ?? '';
                index += captureDigits.length;
                continue;
            }
        }

        output += char;
    }

    return output;
}

/**
 * 对文本应用规则替换。
 * @param {string} originalText 原始文本。
 * @param {{deterministic?: boolean}} [options={}] 替换选项。
 * @returns {string} 替换后的文本。
 */
export function applyReplacements(originalText, options = {}) {
    if (typeof originalText !== 'string' || !originalText) return originalText;
    const deterministic = options.deterministic === true;
    let text = originalText;
    const processors = buildProcessors();

    processors.forEach((proc, procIndex) => {
        text = text.replace(proc.regex, (match, ...args) => {
            if (proc.kind === 'regex') {
                const reps = proc.replacements;
                if (!reps || reps.length === 0) return '';
                const repKey = deterministic ? `${procIndex}|${match}` : '';
                const rep = pickReplacement(reps, repKey);
                return renderRegexReplacementTemplate(rep, extractRegexCaptures(args));
            }

            if (proc.kind === 'simple') {
                const reps = proc.replacements;
                if (!reps || reps.length === 0) return '';
                const repKey = deterministic ? `${procIndex}|${match}` : '';
                return String(pickReplacement(reps, repKey) ?? '');
            }

            const reps = proc.replacerMap[match];
            if (!reps || reps.length === 0) return '';
            const repKey = deterministic ? `${procIndex}|${match}` : '';
            return pickReplacement(reps, repKey);
        });
    });
    return text;
}

/**
 * 在流式展示场景下执行确定性视觉替换。
 * @param {string} originalText 原始文本。
 * @returns {string} 视觉掩码后的文本。
 */
export function applyVisualMask(originalText) {
    if (typeof originalText !== 'string' || !originalText) return originalText;
    return applyReplacements(originalText, { deterministic: true });
}

/**
 * 排队执行增量聊天保存。
 * @returns {void}
 */
export function queueIncrementalChatSave() {
    const { saveChat } = getAppContext();
    runtimeState.pendingChatSave = true;
    if (runtimeState.chatSaveTimer) return;

    runtimeState.chatSaveTimer = setTimeout(async () => {
        runtimeState.chatSaveTimer = null;
        if (!runtimeState.pendingChatSave) return;
        if (runtimeState.chatSaveInFlight) {
            queueIncrementalChatSave();
            return;
        }

        runtimeState.pendingChatSave = false;
        runtimeState.chatSaveInFlight = true;
        try {
            if (typeof saveChat === 'function') {
                const result = saveChat();
                if (result instanceof Promise) await result;
            }
        } catch (e) {
            logger.error(`增量存盘失败`, e);
        } finally {
            runtimeState.chatSaveInFlight = false;
            if (runtimeState.pendingChatSave) queueIncrementalChatSave();
        }
    }, 600);
}

/**
 * 从事件负载中解析消息索引。
 * @param {number|object} payload 事件载荷或直接索引。
 * @returns {number} 解析出的索引，失败返回 -1。
 */
export function getMessageIndexFromEvent(payload) {
    if (Number.isInteger(payload)) return payload;
    if (!payload || typeof payload !== 'object') return -1;
    const candidates = [payload.messageId, payload.message_id, payload.mesid, payload.index, payload.id];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0) return n;
    }
    return -1;
}

/**
 * 获取当前聊天中的最后一条消息索引。
 * @returns {number} 最新消息索引，不存在则为 -1。
 */
export function getLatestMessageIndex() {
    const { chat } = getAppContext();
    return Array.isArray(chat) && chat.length > 0 ? chat.length - 1 : -1;
}

/**
 * 解析“可追踪非 user 消息”的最新索引。
 * @param {number|object} payload 事件载荷或消息索引。
 * @returns {number} 可追踪消息索引，失败返回 -1。
 */
export function resolveLatestTrackableMessageIndex(payload) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat)) return -1;

    const explicit = getMessageIndexFromEvent(payload);

    if (explicit >= 0 && explicit < chat.length) {
        if (isAssistantMessage(chat[explicit])) return explicit;

        for (let i = explicit + 1; i < chat.length; i++) {
            if (isAssistantMessage(chat[i])) return i;
        }
    }

    for (let i = chat.length - 1; i >= 0; i--) {
        if (isAssistantMessage(chat[i])) return i;
    }

    return -1;
}

/**
 * 清理指定索引消息的数据并更新差异缓存。
 * @param {number} index 消息索引。
 * @returns {boolean} 是否发生数据变更。
 */
export function cleanseMessageDataAtIndex(index, options = {}) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) return false;
    const msg = chat[index];
    if (!msg || typeof msg !== 'object') return false;
    if (msg.__bl_is_reverted) return false;

    const isAssistant = isAssistantMessage(msg);
    if (!isAssistant) {
        clearTrackedDiffEntry(index);
        return false;
    }

    const diffSourceMes = typeof options.diffSourceMes === 'string' ? options.diffSourceMes : null;
    const currentMes = typeof msg.mes === 'string' ? msg.mes : '';
    const sourceMes = diffSourceMes || currentMes;

    const sourceSignature = computeMessageSignature({
        ...msg,
        mes: sourceMes,
        __bl_diff_source_signature: '',
        __bl_diff_last_cleaned_mes: '',
    });
    let changed = false;

    const diffResult = buildDiffSnippetsFromText(sourceMes);
    const dataResult = buildDiffSnippetsFromText(currentMes);
    const mainCache = {
        snippets: Array.from(new Set(diffResult.snippets || [])),
        fullDiff: diffResult.fullDiff || '',
    };

    if (typeof msg.mes === 'string' && dataResult.cleanedText !== msg.mes) {
        if (typeof msg.__bl_original_mes !== 'string') msg.__bl_original_mes = sourceMes;
        msg.mes = dataResult.cleanedText;
        changed = true;
    }

    if (Array.isArray(msg.swipes)) {
        for (let i = 0; i < msg.swipes.length; i++) {
            if (typeof msg.swipes[i] === 'string') {
                const { cleanedText } = buildDiffSnippetsFromText(msg.swipes[i]);
                if (cleanedText !== msg.swipes[i]) {
                    msg.swipes[i] = cleanedText;
                    changed = true;
                }
            } else if (msg.swipes[i] && typeof msg.swipes[i] === 'object' && typeof msg.swipes[i].mes === 'string') {
                const { cleanedText } = buildDiffSnippetsFromText(msg.swipes[i].mes);
                if (cleanedText !== msg.swipes[i].mes) {
                    msg.swipes[i].mes = cleanedText;
                    changed = true;
                }
            }
        }
    }

    msg.__bl_diff_source_signature = sourceSignature;
    msg.__bl_diff_last_cleaned_mes = typeof msg.mes === 'string' ? msg.mes : '';
    writeReadyDiffCache(index, sourceSignature, {
        snippets: mainCache.snippets,
        fullDiff: mainCache.fullDiff,
        signature: sourceSignature,
    }, {
        preserveExistingRealDiff: options.preserveExistingRealDiff === true,
    });
    runtimeState.diffRawSourceCache.delete(index);

    return changed;
}

/**
 * 非流式生成结束后的专用收敛流程。
 * @param {number|object} payload 事件载荷或消息索引。
 * @returns {void}
 */
export function performNonStreamingFinalCleanse(payload) {
    const { chat } = getAppContext();

    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) return;

    const index = resolveLatestTrackableMessageIndex(payload);
    if (index < 0 || !Array.isArray(chat)) return;

    const msg = chat[index];
    if (!isAssistantMessage(msg)) return;
    if (msg?.__bl_is_reverted) {
        clearTrackedDiffEntry(index);
        injectDiffButtons([index]);
        return;
    }

    const previousState = runtimeState.diffMessageStates.get(index);
    const currentSignature = computeMessageSignature(msg);
    const alreadyFinalizedSameSource = previousState?.status === 'ready'
        && previousState.signature === currentSignature
        && typeof msg?.mes === 'string'
        && typeof msg?.__bl_diff_last_cleaned_mes === 'string'
        && msg.mes === msg.__bl_diff_last_cleaned_mes;

    if (alreadyFinalizedSameSource && hasRealDiffCache(index)) {
        const messageNode = getMessageDomNode(index);
        if (messageNode) {
            purifyDOM(messageNode);
            ensureMessageDiffButton(index, messageNode);
        }
        return;
    }

    const dataChanged = cleanseMessageDataAtIndex(index, {
        preserveExistingRealDiff: true,
    });
    runtimeState.nonStreamingRawMessageCache.delete(index);

    const messageNode = getMessageDomNode(index);
    if (messageNode) {
        purifyDOM(messageNode);
        ensureMessageDiffButton(index, messageNode);
    }

    if (dataChanged) {
        try {
            if (typeof updateMessageBlock === 'function') updateMessageBlock(index, chat[index]);
        } catch (e) {
            logger?.warn?.(`updateMessageBlock 调用失败 index=${index}`, e);
        }
        queueIncrementalChatSave();
    }
}

/**
 * 执行增量净化：处理单条消息并刷新对应 DOM。
 * @param {number|object} payload 事件载荷或消息索引。
 * @param {{visualOnly?: boolean, fallbackLatest?: boolean, skipPurifyDom?: boolean}} [options={}] 控制选项。
 * @returns {void}
 */
export function performIncrementalCleanse(payload, options = {}) {
    logger.debug(`[performIncrementalCleanse] payload=${JSON.stringify(payload)}, options=${JSON.stringify(options)}`);
    const { chat } = getAppContext();
    if (!options.skipPurifyDom) buildProcessors();
    if (!options.skipPurifyDom && runtimeState.activeProcessors.length === 0) return;

    const fallbackLatest = options.fallbackLatest === true;
    let index = getMessageIndexFromEvent(payload);
    if (index < 0 && fallbackLatest && Array.isArray(chat)) {
        for (let i = chat.length - 1; i >= 0; i--) {
            if (isAssistantMessage(chat[i])) {
                index = i;
                break;
            }
        }
    }
    if (index < 0) return;

    const msg = Array.isArray(chat) ? chat[index] : null;
    const assistant = isAssistantMessage(msg);
    if (!assistant) return;
    if (msg?.__bl_is_reverted) {
        clearTrackedDiffEntry(index);
        injectDiffButtons([index]);
        return;
    }
    if (assistant) {
        const signature = computeMessageSignature(msg);
        if (options.visualOnly) markDiffComparisonPending(index, signature);
        else {
            const previousState = runtimeState.diffMessageStates.get(index);
            const alreadyFinalizedSameSource = previousState?.status === 'ready'
                && previousState.signature === signature
                && typeof msg?.mes === 'string'
                && typeof msg?.__bl_diff_last_cleaned_mes === 'string'
                && msg.mes === msg.__bl_diff_last_cleaned_mes;

            if (alreadyFinalizedSameSource) {
                const messageNode = getMessageDomNode(index);
                if (messageNode) ensureMessageDiffButton(index, messageNode);
                return;
            }

            if (!previousState || previousState.signature !== signature) {
                markDiffComparisonPending(index, signature);
            }
        }
    }

    const dataChanged = options.visualOnly ? false : cleanseMessageDataAtIndex(index);
    const messageNode = getMessageDomNode(index);
    if (messageNode) {
        if (!options.skipPurifyDom) purifyDOM(messageNode);
        ensureMessageDiffButton(index, messageNode);
    }

    if (dataChanged) {
        try {
            if (typeof updateMessageBlock === 'function') updateMessageBlock(index, chat[index]);
        } catch (e) { logger.warn(`updateMessageBlock 调用失败 index=${index}`, e); }
        queueIncrementalChatSave();
    }
}

/**
 * 执行全局净化：遍历聊天数据、同步 UI 并刷新差异按钮。
 * @returns {void}
 */
export function performGlobalCleanse() {
    logger.info(`[performGlobalCleanse] 全局净化开始`);
    const { chat, saveChat } = getAppContext();
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) {
        injectDiffButtons();
        return;
    }

    let chatChanged = false;
    const latestDiffIndices = new Set(getLatestTrackableDiffIndices(3));

    if (chat && Array.isArray(chat)) {
        const { extension_settings } = getAppContext();
        const skipUser = extension_settings[extensionName]?.skipUserMessages === true;
        chat.forEach((msg, index) => {
            let msgChanged = false;
            let mainCache = { snippets: [], fullDiff: '' };
            const assistant = isAssistantMessage(msg);
            if (skipUser && !assistant) return;
            const signature = assistant ? computeMessageSignature(msg) : '';
            const isReverted = msg?.__bl_is_reverted === true;

            if (!isReverted && typeof msg?.mes === 'string') {
                const { cleanedText, snippets: mesSnippets, fullDiff } = buildDiffSnippetsFromText(msg.mes);
                mainCache = {
                    snippets: Array.from(new Set(mesSnippets)),
                    fullDiff,
                };
                if (msg.mes !== cleanedText) {
                    if (typeof msg.__bl_original_mes !== 'string') msg.__bl_original_mes = msg.mes;
                    msg.mes = cleanedText;
                    msgChanged = true;
                }
            }

            if (!isReverted && msg?.swipes && Array.isArray(msg.swipes)) {
                for (let i = 0; i < msg.swipes.length; i++) {
                    if (typeof msg.swipes[i] === 'string') {
                        const { cleanedText } = buildDiffSnippetsFromText(msg.swipes[i]);
                        if (msg.swipes[i] !== cleanedText) {
                            msg.swipes[i] = cleanedText;
                            msgChanged = true;
                        }
                    } else if (typeof msg.swipes[i] === 'object' && msg.swipes[i] !== null && typeof msg.swipes[i].mes === 'string') {
                        const { cleanedText } = buildDiffSnippetsFromText(msg.swipes[i].mes);
                        if (msg.swipes[i].mes !== cleanedText) {
                            msg.swipes[i].mes = cleanedText;
                            msgChanged = true;
                        }
                    }
                }
            }

            if (assistant && latestDiffIndices.has(index) && !isReverted) {
                writeReadyDiffCache(index, signature, mainCache, {
                    preserveExistingRealDiff: true,
                });
            } else {
                clearTrackedDiffEntry(index, { persist: false });
            }

            if (msgChanged) {
                chatChanged = true;
                try {
                    if (typeof updateMessageBlock === 'function') setTimeout(() => updateMessageBlock(index, chat[index]), 50);
                } catch (e) { logger.warn(`updateMessageBlock 调用失败 index=${index}`, e); }
            }
        });

        const latestMsg = chat.length > 0 ? chat[chat.length - 1] : null;
        if (latestMsg && typeof latestMsg === 'object') {
            ['TavernDB_ACU_Data', 'TavernDB_ACU_SummaryData'].forEach((dbKey) => {
                const dbVal = latestMsg[dbKey];
                if (dbVal && typeof dbVal === 'object') {
                    const dbChanges = deepCleanObjectSync(dbVal);
                    if (dbChanges > 0) chatChanged = true;
                }
            });
        }
    }

    syncTrackedIndicesToLatestAssistantMessages();

    if (chatChanged) {
        queueIncrementalChatSave(); // 使用排队保存
    }
    purifyDOM(document.getElementById('chat'));
    injectDiffButtons();
}
