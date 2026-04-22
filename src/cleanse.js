import { defaultSettings, extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';
import { applyReplacements, buildProcessors } from './core.js';
import { showDeepCleanOverlay, updateDeepCleanOverlay } from './ui.js';

/**
 * 判断是否应跳过数据库扩展字段（全局设置模式）。
 * 兼容逻辑：当根命名空间属于 shujuku_v120 且键名命中 Prompt/Settings/Template 时放行不清理。
 * @param {string[]} [pathKeys=[]] 当前字段路径键列表。
 * @param {boolean} [isGlobalSettings=false] 是否处于全局设置扫描。
 * @returns {boolean} true 表示跳过该字段。
 */
export function shouldSkipDbExtensionField(pathKeys = [], isGlobalSettings = false) {
    if (!isGlobalSettings || pathKeys.length < 2) return false;
    const rootNamespace = String(pathKeys[0] || '');
    if (!rootNamespace.includes('shujuku_v120')) return false;
    const currentKey = String(pathKeys[pathKeys.length - 1] || '');
    return /(Prompt|Settings|Template)/.test(currentKey);
}

function shouldSkipDbExtensionFieldByMeta(depth, rootNamespace, currentKey, isGlobalSettings = false) {
    if (!isGlobalSettings || depth < 2) return false;
    const rootNs = String(rootNamespace || '');
    if (!rootNs.includes('shujuku_v120')) return false;
    const key = String(currentKey || '');
    return /(Prompt|Settings|Template)/.test(key);
}

/**
 * 同步深度清理对象中的所有字符串字段。
 * @param {object} rootObj 待清理对象。
 * @returns {number} 命中并替换的字段数量。
 */
export function deepCleanObjectSync(rootObj) {
    if (!rootObj || typeof rootObj !== 'object') return 0;
    let changes = 0;
    const stack = [rootObj];
    const seen = new Set();

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current || seen.has(current)) continue;
        seen.add(current);

        for (let key in current) {
            if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
            const val = current[key];
            if (typeof val === 'string') {
                const cleaned = applyReplacements(val);
                if (cleaned !== val) {
                    current[key] = cleaned;
                    changes++;
                }
            } else if (val && typeof val === 'object') {
                stack.push(val);
            }
        }
    }
    return changes;
}

/**
 * 异步深层洗刷：分片遍历 + 超时截止，防止长任务导致页面卡死。
 * @param {object} rootObj 待清理对象根节点。
 * @param {boolean} [isGlobalSettings=false] 是否对全局设置执行清理（会应用白名单跳过规则）。
 * @param {{onProgress?: Function, deadline?: number}} [options={}] 进度回调与绝对截止时间。
 * @returns {Promise<number>} 命中并替换的字段数量。
 */
export async function safeDeepScrub(rootObj, isGlobalSettings = false, options = {}) {
    let changes = 0;
    if (!rootObj || typeof rootObj !== 'object') return changes;
    const stack = [{ node: rootObj, depth: 0, rootNamespace: '' }];
    const seen = new Set();
    buildProcessors();

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const deadline = Number.isFinite(options.deadline) ? options.deadline : Infinity;
    let iterations = 0;

    while (stack.length > 0) {
        if (Date.now() > deadline) throw new Error('DEEP_CLEAN_TIMEOUT');

        if (++iterations % 500 === 0) {
            if (onProgress) onProgress({ visited: seen.size, pending: stack.length, changes });
            await new Promise(r => setTimeout(r, 0));
        }

        const currentItem = stack.pop();
        const current = currentItem?.node;
        const depth = currentItem?.depth || 0;
        const rootNamespace = currentItem?.rootNamespace || '';
        if (!current || seen.has(current)) continue;
        seen.add(current);

        try {
            for (let key in current) {
                if (Object.prototype.hasOwnProperty.call(current, key)) {
                    if (isGlobalSettings && key === extensionName) continue;
                    const nextDepth = depth + 1;
                    const nextRootNamespace = depth === 0 ? key : rootNamespace;
                    if (shouldSkipDbExtensionFieldByMeta(nextDepth, nextRootNamespace, key, isGlobalSettings)) continue;
                    const val = current[key];
                    if (typeof val === 'string') {
                        const cleaned = applyReplacements(val);
                        if (val !== cleaned) {
                            current[key] = cleaned;
                            changes++;
                        }
                    } else if (val !== null && typeof val === 'object') {
                        stack.push({ node: val, depth: nextDepth, rootNamespace: nextRootNamespace });
                    }
                }
            }
        } catch (e) { }
    }

    if (onProgress) onProgress({ visited: seen.size, pending: stack.length, changes });
    return changes;
}

/**
 * 获取深度清理超时时间（毫秒），并对配置进行边界收敛。
 * @returns {number} 介于 10000 到 1800000 之间的超时毫秒值。
 */
export function getDeepCleanTimeoutMs() {
    const { extension_settings } = getAppContext();
    const raw = Number(extension_settings[extensionName]?.deepCleanTimeoutSec);
    const safeSeconds = Number.isFinite(raw) ? Math.min(Math.max(raw, 10), 1800) : defaultSettings.deepCleanTimeoutSec;
    return safeSeconds * 1000;
}

/**
 * 执行全域深度清理流程：分阶段洗刷、进度展示、超时保护与最终落盘。
 * @returns {Promise<void>}
 */
export async function performDeepCleanse() {
    logger.info('[performDeepCleanse] 深度清理开始');
    const { chat, chat_metadata, extension_settings, saveChat, saveSettingsDebounced } = getAppContext();
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) {
        alert('没有开启的屏蔽规则，无需清理。');
        return;
    }

    showDeepCleanOverlay();
    await new Promise(r => setTimeout(r, 100));

    try {
        let scrubbedItems = 0;
        const timeoutMs = getDeepCleanTimeoutMs();
        const startAt = Date.now();
        const deadline = startAt + timeoutMs;

        const phases = [];
        if (chat && Array.isArray(chat)) phases.push({ label: '聊天记录', root: chat, isGlobalSettings: false });
        if (typeof chat_metadata === 'object' && chat_metadata !== null) phases.push({ label: '聊天元数据', root: chat_metadata, isGlobalSettings: false });
        if (typeof extension_settings === 'object' && extension_settings !== null) phases.push({ label: '插件设置', root: extension_settings, isGlobalSettings: true });
        if (typeof window.characters !== 'undefined' && Array.isArray(window.characters)) phases.push({ label: '角色卡', root: window.characters, isGlobalSettings: false });
        if (typeof window.world_info !== 'undefined' && window.world_info !== null) phases.push({ label: '世界书', root: window.world_info, isGlobalSettings: false });
        if (typeof window.power_user !== 'undefined' && window.power_user !== null && window.power_user.personas) phases.push({ label: '人设', root: window.power_user.personas, isGlobalSettings: false });

        for (let i = 0; i < phases.length; i++) {
            const phase = phases[i];
            logger.info(`深度清理阶段 ${i + 1}/${phases.length}: ${phase.label}`);
            const phaseBase = i / phases.length;
            const phaseSpan = 1 / phases.length;

            scrubbedItems += await safeDeepScrub(phase.root, phase.isGlobalSettings, {
                deadline,
                onProgress: ({ visited, pending, changes }) => {
                    const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
                    const dynamic = (visited + pending > 0) ? (visited / (visited + pending)) : 0;
                    updateDeepCleanOverlay(
                        phaseBase + dynamic * phaseSpan,
                        `正在清理 ${phase.label}（已扫描 ${visited}，剩余队列 ${pending}，命中 ${changes}）｜耗时 ${elapsed}s / 超时 ${Math.round(timeoutMs / 1000)}s`
                    );
                }
            });

            updateDeepCleanOverlay((i + 1) / phases.length, `已完成 ${phase.label}，准备进入下一阶段...`);
        }

        updateDeepCleanOverlay(0.97, '正在同步数据到磁盘，请稍候。');

        if (scrubbedItems > 0) {
            const saveChatPromise = saveChat();
            if (saveChatPromise instanceof Promise) await saveChatPromise;

            saveSettingsDebounced();
            const remainingMs = Math.max(300, Math.min(2000, deadline - Date.now()));
            await new Promise(r => setTimeout(r, remainingMs));

            updateDeepCleanOverlay(1, '清理完成，正在准备刷新页面...');
            await new Promise(r => setTimeout(r, 180));
            $('#bl-loading-overlay').remove();

            alert(`清理完成，共处理 ${scrubbedItems} 处匹配项。\n\n页面即将刷新，请在刷新后将系统预设切换回常用预设！`);
            location.reload();
        } else {
            updateDeepCleanOverlay(1, '未发现残留，任务结束。');
            await new Promise(r => setTimeout(r, 260));
            $('#bl-loading-overlay').remove();
            alert('未发现需要替换的数据残留。');
        }
    } catch (e) {
        logger.error(`深度清理出错`, e);
        $('#bl-loading-overlay').remove();
        if (e && e.message === 'DEEP_CLEAN_TIMEOUT') {
            const timeoutSec = Math.round(getDeepCleanTimeoutMs() / 1000);
            alert(`清理超时（${timeoutSec}s）已自动中止。\n建议减少规则范围或调大 deepCleanTimeoutSec 后重试。`);
        } else {
            alert('清理失败，请查看控制台。');
        }
    }
}
