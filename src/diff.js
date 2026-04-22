import { diffMetadataKey, extensionName, getAppContext, maxTrackedDiffMessages, runtimeState } from './state.js';
import { logger } from './log.js';
import { applyReplacements, queueIncrementalChatSave } from './core.js';
import { getMessageDomNode } from './dom.js';

/**
 * 将原始文本进行 HTML 转义，避免差异片段注入标签。
 * @param {string} [value=''] 需要转义的文本。
 * @returns {string} 已转义的安全 HTML 文本。
 */
export function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function hashString(value = '') {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return `h${(hash >>> 0).toString(16)}`;
}

export function isAssistantMessage(msg) {
    return !!(msg && typeof msg === 'object' && msg.is_user !== true && msg.is_system !== true);
}

export function computeMessageSignature(msg) {
    if (!msg || typeof msg !== 'object') return '';
    const base = typeof msg.mes === 'string' ? msg.mes : '';
    const name = typeof msg.name === 'string' ? msg.name : '';
    const swipeInfo = msg.swipe_id ?? msg.swipeId ?? msg.swipes?.length ?? '';

    const storedSourceSignature = typeof msg.__bl_diff_source_signature === 'string'
        ? msg.__bl_diff_source_signature
        : '';
    const lastCleanedMes = typeof msg.__bl_diff_last_cleaned_mes === 'string'
        ? msg.__bl_diff_last_cleaned_mes
        : '';

    // 正式替换后 msg.mes 会被写成净化后的文本。
    // 如果随后同一条消息又收到一次结束事件，这里仍需返回“原始源文本”的签名，
    // 避免把同一条消息误判成新内容，导致对比缓存被空结果覆盖。
    if (storedSourceSignature && lastCleanedMes && base === lastCleanedMes) {
        return storedSourceSignature;
    }

    return hashString(`${name}
${swipeInfo}
${base}`);
}

export function getLatestAssistantMessageIndices(chat, limit = maxTrackedDiffMessages) {
    if (!Array.isArray(chat) || limit <= 0) return [];
    const picked = [];
    for (let i = chat.length - 1; i >= 0 && picked.length < limit; i--) {
        if (isAssistantMessage(chat[i])) picked.push(i);
    }
    return picked.reverse();
}

function sanitizeCacheEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    return {
        snippets: Array.isArray(entry.snippets) ? entry.snippets.filter(v => typeof v === 'string') : [],
        fullDiff: typeof entry.fullDiff === 'string' ? entry.fullDiff : '',
        signature: typeof entry.signature === 'string' ? entry.signature : '',
    };
}

function sanitizeStateEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const status = entry.status === 'pending' ? 'pending' : 'ready';
    return {
        status,
        signature: typeof entry.signature === 'string' ? entry.signature : '',
        updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : Date.now(),
    };
}

function notifyDiffStateChanged(reason = 'state', index = runtimeState.currentDiffIndex) {
    if (typeof runtimeState.diffModalRefresh === 'function') {
        try {
            runtimeState.diffModalRefresh(index, { reason, changedIndex: index });
        } catch (err) {
            logger.warn(`刷新对比弹窗失败`, err);
        }
    }
}

function persistTrackedDiffState() {
    const { chat_metadata } = getAppContext();
    if (!chat_metadata || typeof chat_metadata !== 'object') return;

    const order = runtimeState.trackedDiffMessageOrder
        .filter(index => Number.isInteger(index) && index >= 0)
        .slice(-maxTrackedDiffMessages);

    if (order.length === 0) {
        delete chat_metadata[diffMetadataKey];
        queueIncrementalChatSave();
        return;
    }

    const entries = {};
    for (const index of order) {
        const state = sanitizeStateEntry(runtimeState.diffMessageStates.get(index));
        if (!state) continue;
        const cache = sanitizeCacheEntry(runtimeState.diffSnippetsCache.get(index)) || { snippets: [], fullDiff: '', signature: state.signature || '' };
        entries[String(index)] = {
            status: state.status,
            signature: state.signature || cache.signature || '',
            updatedAt: state.updatedAt,
            snippets: cache.snippets,
            fullDiff: cache.fullDiff,
        };
    }

    chat_metadata[diffMetadataKey] = { version: 1, order, entries };
    queueIncrementalChatSave();
}

export function resetDiffRuntimeState() {
    logger.debug('重置差异运行时状态');
    runtimeState.diffSnippetsCache.clear();
    runtimeState.diffMessageStates.clear();
    runtimeState.trackedDiffMessageOrder = [];
    runtimeState.currentDiffIndex = undefined;
}

export function restoreDiffStateFromChatMetadata() {
    const { chat, chat_metadata } = getAppContext();
    resetDiffRuntimeState();

    const saved = chat_metadata?.[diffMetadataKey];
    if (!saved || typeof saved !== 'object') return;

    const validLatest = new Set(getLatestAssistantMessageIndices(chat));
    const rawOrder = Array.isArray(saved.order) ? saved.order : [];
    const restoredOrder = rawOrder
        .map(v => Number(v))
        .filter(index => Number.isInteger(index) && index >= 0 && validLatest.has(index))
        .slice(-maxTrackedDiffMessages);

    for (const index of restoredOrder) {
        const entry = sanitizeStateEntry(saved.entries?.[String(index)] || saved.entries?.[index]);
        if (!entry) continue;
        runtimeState.diffMessageStates.set(index, entry);
        runtimeState.diffSnippetsCache.set(index, sanitizeCacheEntry(saved.entries?.[String(index)] || {}) || { snippets: [], fullDiff: '', signature: entry.signature || '' });
    }

    runtimeState.trackedDiffMessageOrder = restoredOrder;
    logger.debug(`从 chat_metadata 恢复差异状态: 还原了 ${restoredOrder.length} 条记录`);
}

function removeTrackedIndex(index) {
    runtimeState.trackedDiffMessageOrder = runtimeState.trackedDiffMessageOrder.filter(v => v !== index);
}

function pushTrackedIndex(index) {
    removeTrackedIndex(index);
    runtimeState.trackedDiffMessageOrder.push(index);
    while (runtimeState.trackedDiffMessageOrder.length > maxTrackedDiffMessages) {
        const evicted = runtimeState.trackedDiffMessageOrder.shift();
        runtimeState.diffMessageStates.delete(evicted);
        runtimeState.diffSnippetsCache.delete(evicted);
        const oldNode = getMessageDomNode(evicted);
        if (oldNode) ensureMessageDiffButton(evicted, oldNode);
    }
}

export function syncTrackedIndicesToLatestAssistantMessages() {
    const { chat } = getAppContext();
    const latestIndices = getLatestAssistantMessageIndices(chat);
    const latestSet = new Set(latestIndices);

    for (const index of [...runtimeState.trackedDiffMessageOrder]) {
        if (!latestSet.has(index)) {
            runtimeState.diffMessageStates.delete(index);
            runtimeState.diffSnippetsCache.delete(index);
            removeTrackedIndex(index);
        }
    }

    runtimeState.trackedDiffMessageOrder = latestIndices.filter(index => runtimeState.diffMessageStates.has(index) || runtimeState.diffSnippetsCache.has(index));
}

export function isTrackedDiffMessage(index) {
    return runtimeState.trackedDiffMessageOrder.includes(index);
}

export function markDiffComparisonPending(index, signature = '', options = {}) {
    const { chat } = getAppContext();
    if (!Number.isInteger(index) || index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return false;

    const existingState = runtimeState.diffMessageStates.get(index);
    const existingCache = runtimeState.diffSnippetsCache.get(index);
    const normalizedSignature = signature || computeMessageSignature(chat[index]);
    const shouldReplace = !existingState || existingState.signature !== normalizedSignature || !isTrackedDiffMessage(index);

    if (!shouldReplace) return false;

    pushTrackedIndex(index);
    runtimeState.diffSnippetsCache.delete(index);
    runtimeState.diffMessageStates.set(index, {
        status: 'pending',
        signature: normalizedSignature,
        updatedAt: Date.now(),
    });

    if (options.skipPersist !== true) {
        if (existingCache || !existingState || existingState.status !== 'pending') {
            persistTrackedDiffState();
            injectDiffButtons([index]);
            notifyDiffStateChanged('pending', index);
            logger.debug(`标记差异待比较: index=${index}, signature=${normalizedSignature}`);
        }
    }
    return true;
}

export function writeReadyDiffCache(index, signature, cacheData = {}) {
    if (!Number.isInteger(index) || index < 0) return false;

    pushTrackedIndex(index);
    runtimeState.diffSnippetsCache.set(index, {
        snippets: Array.isArray(cacheData.snippets) ? cacheData.snippets : [],
        fullDiff: typeof cacheData.fullDiff === 'string' ? cacheData.fullDiff : '',
        signature: signature || '',
    });
    runtimeState.diffMessageStates.set(index, {
        status: 'ready',
        signature: signature || '',
        updatedAt: Date.now(),
    });

    persistTrackedDiffState();
    injectDiffButtons([index]);
    notifyDiffStateChanged('cache-written', index);
    logger.debug(`写入差异缓存: index=${index}, signature=${signature || ''}`);
    return true;
}

export function clearTrackedDiffEntry(index, options = {}) {
    const hadState = runtimeState.diffMessageStates.delete(index);
    const hadCache = runtimeState.diffSnippetsCache.delete(index);
    removeTrackedIndex(index);

    if (hadState || hadCache) {
        if (options.persist !== false) persistTrackedDiffState();
        injectDiffButtons([index]);
        notifyDiffStateChanged('cleared', index);
    }
}

export function getDiffStateForMessage(index) {
    const state = runtimeState.diffMessageStates.get(index);
    if (!state || typeof state !== 'object') return { status: 'pending', signature: '' };
    return {
        status: state.status === 'ready' ? 'ready' : 'pending',
        signature: typeof state.signature === 'string' ? state.signature : '',
    };
}

/**
 * 生成两段文本的行内差异 HTML。
 *
 * 算法说明：
 * - 先通过动态规划求出 oldStr/newStr 的最长公共子序列（LCS）长度矩阵；
 * - 再从矩阵右下角回溯，公共字符保持原样，新增字符包裹在 <ins>，删除字符包裹在 <del>；
 * - 最后合并连续同类标签，得到可读性更高的高亮结果。
 * @param {string} oldStr 原始文本。
 * @param {string} newStr 净化后文本。
 * @returns {string} 包含 <ins>/<del> 标记的差异 HTML。
 */
export function getInlineDiff(oldStr, newStr) {
    if (oldStr === newStr) return escapeHtml(oldStr);
    if (!oldStr && !newStr) return "";

    const oldChars = Array.from(oldStr);
    const newChars = Array.from(newStr);
    const m = oldChars.length;
    const n = newChars.length;

    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldChars[i - 1] === newChars[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    let i = m;
    let j = n;
    const diff = [];
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldChars[i - 1] === newChars[j - 1]) {
            diff.push(escapeHtml(oldChars[i - 1]));
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.push(`<ins>${escapeHtml(newChars[j - 1])}</ins>`);
            j--;
        } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
            diff.push(`<del>${escapeHtml(oldChars[i - 1])}</del>`);
            i--;
        }
    }

    return diff.reverse().join('')
        .replace(/<\/ins><ins>/g, '')
        .replace(/<\/del><del>/g, '');
}

/**
 * 从原始消息文本中构建净化结果与可视化差异缓存。
 *
 * 解析逻辑：
 * - Snippet 模式：按行比较原文与净化结果，仅收集发生变化的行，生成紧凑差异片段；
 * - Full Text 模式：优先抽取 <content>...</content> 主体，再逐行生成完整对照（含未修改行）。
 * @param {string} rawText 原始消息文本。
 * @returns {{cleanedText: string, snippets: string[], fullDiff: string}} 净化文本、片段差异和全文差异。
 */
export function buildDiffSnippetsFromText(rawText) {
    if (typeof rawText !== 'string') return { cleanedText: rawText, snippets: [], fullDiff: "" };
    const parts = rawText.split('\n');
    const cleanedParts = new Array(parts.length);
    const snippets = [];

    for (let i = 0; i < parts.length; i++) {
        const originalPart = parts[i];
        const cleanedPart = applyReplacements(originalPart);
        cleanedParts[i] = cleanedPart;

        if (cleanedPart !== originalPart) {
            const inlineDiffHTML = getInlineDiff(originalPart, cleanedPart);
            snippets.push(`<div class="bl-diff-snippet">${inlineDiffHTML}</div>`);
        }
    }

    const cleanedText = cleanedParts.join('\n');

    let targetText = rawText;
    const contentMatch = rawText.match(/<content>([\s\S]*?)<\/content>/i);
    if (contentMatch) targetText = contentMatch[1].trim();

    const fullParts = targetText.split('\n');
    const fullDiffBlocks = [];

    for (let i = 0; i < fullParts.length; i++) {
        const originalPart = fullParts[i].trim();
        if (!originalPart) continue;

        const cleanedPart = applyReplacements(originalPart);
        if (cleanedPart !== originalPart) {
            const inlineDiffHTML = getInlineDiff(originalPart, cleanedPart);
            fullDiffBlocks.push(`<div class="bl-diff-full-modified">${inlineDiffHTML}</div>`);
        } else {
            fullDiffBlocks.push(`<div class="bl-diff-full-normal">${escapeHtml(originalPart)}</div>`);
        }
    }

    const fullDiff = fullDiffBlocks.join('');

    return {
        cleanedText,
        snippets,
        fullDiff,
    };
}

/**
 * 更新指定消息的差异缓存。
 * @param {number} index 消息索引。
 * @param {{snippets?: string[], fullDiff?: string, signature?: string}} cacheData 差异缓存数据。
 * @returns {void}
 */
export function updateDiffSnippetCache(index, cacheData) {
    if (!Number.isInteger(index) || index < 0) return;
    runtimeState.diffSnippetsCache.set(index, {
        snippets: Array.isArray(cacheData?.snippets) ? cacheData.snippets : [],
        fullDiff: typeof cacheData?.fullDiff === 'string' ? cacheData.fullDiff : '',
        signature: typeof cacheData?.signature === 'string' ? cacheData.signature : '',
    });
}

/**
 * 确保消息节点拥有正确的“净化前文溯源”按钮状态。
 * @param {number} index 消息索引。
 * @param {Element} messageNode 消息 DOM 节点。
 * @returns {void}
 */
export function ensureMessageDiffButton(index, messageNode) {
    if (!messageNode || !Number.isInteger(index) || index < 0) return;

    const { extension_settings } = getAppContext();
    const isEnabled = extension_settings[extensionName]?.enableVisualDiff !== false;
    const isTopInExtra = extension_settings[extensionName]?.diffButtonInExtraMenu === true;
    const shouldShow = isEnabled && isTrackedDiffMessage(index);

    const buttonArea = messageNode.querySelector('.mes_buttons');
    if (buttonArea) {
        let existing = buttonArea.querySelector('.bl-diff-btn-top');
        const extraMenu = buttonArea.querySelector('.extraMesButtons');
        const targetContainer = (isTopInExtra && extraMenu) ? extraMenu : buttonArea;

        if (existing && existing.parentElement !== targetContainer) {
            existing.remove();
            existing = null;
        }

        if (!shouldShow) {
            if (existing) existing.remove();
        } else if (!existing) {
            const button = document.createElement('div');
            button.className = 'mes_button bl-diff-btn bl-diff-btn-top fa-solid fa-clock-rotate-left interactable';
            button.title = '溯源净化前文';
            button.setAttribute('data-index', String(index));
            button.setAttribute('tabindex', '0');
            button.setAttribute('role', 'button');

            if (isTopInExtra && extraMenu) {
                extraMenu.appendChild(button);
            } else {
                const editBtn = buttonArea.querySelector('.mes_edit');
                if (editBtn) buttonArea.insertBefore(button, editBtn);
                else buttonArea.appendChild(button);
            }
        } else {
            existing.setAttribute('data-index', String(index));
        }
    }

    const swipeBlock = messageNode.querySelector('.swipeRightBlock');
    if (swipeBlock) {
        const parent = swipeBlock.parentNode;
        const existingBottom = parent?.querySelector('.bl-diff-btn-bottom');

        if (!shouldShow) {
            if (existingBottom) existingBottom.remove();
        } else if (!existingBottom && parent) {
            const btnBottom = document.createElement('div');
            btnBottom.className = 'bl-diff-btn bl-diff-btn-bottom fa-solid fa-clock-rotate-left interactable';
            btnBottom.title = '溯源净化前文 (尾部触发)';
            btnBottom.setAttribute('data-index', String(index));
            btnBottom.setAttribute('tabindex', '0');
            btnBottom.setAttribute('role', 'button');
            parent.insertBefore(btnBottom, swipeBlock);
        } else if (existingBottom) {
            existingBottom.setAttribute('data-index', String(index));
        }
    }
}

function cleanupStrayDiffButtons(trackedSet) {
    document.querySelectorAll('.bl-diff-btn[data-index]').forEach((button) => {
        const index = Number(button.getAttribute('data-index'));
        if (!trackedSet.has(index)) button.remove();
    });
}

/**
 * 仅对最新 3 条可追踪消息定向注入差异按钮。
 * @param {number[]} [targetIndices=[]] 可选的定向消息索引。
 * @returns {void}
 */
export function injectDiffButtons(targetIndices = []) {
    const tracked = runtimeState.trackedDiffMessageOrder.slice(-maxTrackedDiffMessages);
    const trackedSet = new Set(tracked);
    const indices = Array.isArray(targetIndices) && targetIndices.length > 0
        ? [...new Set(targetIndices.filter(index => trackedSet.has(index)))]
        : tracked;

    cleanupStrayDiffButtons(trackedSet);
    for (const index of indices) {
        const node = getMessageDomNode(index);
        if (node) ensureMessageDiffButton(index, node);
    }
}

/**
 * 获取指定消息的差异缓存数据。
 * @param {number} index 消息索引。
 * @returns {{snippets: string[], fullDiff: string, signature: string}} 对应消息的差异片段与全文差异。
 */
export function getDiffSnippetsForMessage(index) {
    const cached = sanitizeCacheEntry(runtimeState.diffSnippetsCache.get(index));
    if (!cached) return { snippets: [], fullDiff: '', signature: '' };
    return cached;
}

/**
 * 清空全部消息差异缓存。
 * @returns {void}
 */
export function clearDiffSnippetsCache() {
    resetDiffRuntimeState();
    const { chat_metadata } = getAppContext();
    if (chat_metadata && typeof chat_metadata === 'object') delete chat_metadata[diffMetadataKey];
}
