import { getAppContext } from './state.js';
import { logger } from './log.js';

const tauriReadyTimeoutMs = 4000;
const baiBaiSaveDelayMs = 900;
const defaultSaveDelayMs = 600;
const maxBaiBaiSaveDefers = 8;
const loreFrameDetectCacheMs = 1500;
const loreFrameScriptIds = ['online-content-floating-window', 'serial-forum-floating-window'];
export const loreFrameDomSelector = loreFrameScriptIds
    .flatMap((scriptId) => [
        `#${scriptId}-iframe`,
        `#${scriptId}-launcher`,
        `[script_id="${scriptId}"]`,
        `[data-script-id="${scriptId}"]`,
        `[data-${scriptId}-source-button]`,
    ])
    .join(', ');
let loreFrameDetected = false;
let loreFrameLastDomCheckAt = 0;

function getGlobalObject() {
    return typeof globalThis !== 'undefined' ? globalThis : window;
}

function timeout(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTauriTavernHost() {
    const root = getGlobalObject();
    return Boolean(root.__TAURITAVERN__ || root.__TAURITAVERN_MAIN_READY__);
}

export async function waitForTauriTavernReady() {
    if (!isTauriTavernHost()) return false;

    const root = getGlobalObject();
    const ready = root.__TAURITAVERN__?.ready || root.__TAURITAVERN_MAIN_READY__;
    if (!ready || typeof ready.then !== 'function') return true;

    try {
        await Promise.race([ready, timeout(tauriReadyTimeoutMs)]);
        return true;
    } catch (error) {
        logger.warn('等待 TauriTavern 宿主 ready 失败，继续按标准 SillyTavern 初始化', error);
        return false;
    }
}

export function getSillyTavernContextSnapshot() {
    const { getSillyTavernContext } = getAppContext();
    if (typeof getSillyTavernContext === 'function') {
        try {
            const context = getSillyTavernContext();
            if (context && typeof context === 'object') return context;
        } catch (error) {
            logger.warn('获取 SillyTavern 上下文失败', error);
        }
    }

    try {
        const context = getGlobalObject().SillyTavern?.getContext?.();
        if (context && typeof context === 'object') return context;
    } catch (error) {
        logger.warn('从 globalThis.SillyTavern 获取上下文失败', error);
    }

    return {};
}

export function isBaiBaiToolkitInstalled() {
    const root = getGlobalObject();
    return Boolean(
        root.__baiBaiToolkitExtensionInstalled
        || root.__baiBaiToolkitSaveGenerateFetchPatched
        || root.__baiBaiToolkitSaveRequestGzipFetchPatched,
    );
}

export function isLoreFrameInstalled() {
    const root = getGlobalObject();
    if (loreFrameDetected) return true;
    if (loreFrameScriptIds.some((scriptId) => root[scriptId])) {
        loreFrameDetected = true;
        return true;
    }

    if (typeof document === 'undefined') return false;
    const now = Date.now();
    if (now - loreFrameLastDomCheckAt < loreFrameDetectCacheMs) return false;
    loreFrameLastDomCheckAt = now;

    try {
        loreFrameDetected = Boolean(document.querySelector(loreFrameDomSelector));
        return loreFrameDetected;
    } catch (error) {
        logger.warn('LoreFrame 兼容检测失败', error);
        return false;
    }
}

export function getRecommendedChatSaveDelay() {
    return shouldDelayChatSaveForHost() ? baiBaiSaveDelayMs : defaultSaveDelayMs;
}

export function getMaxHostChatSaveDefers() {
    return maxBaiBaiSaveDefers;
}

export function getPreferredSaveChatFunction() {
    if (isTauriTavernHost()) {
        const context = getSillyTavernContextSnapshot();
        if (typeof context.saveChat === 'function') return context.saveChat;
    }

    const { saveChat } = getAppContext();
    return typeof saveChat === 'function' ? saveChat : null;
}

export async function runPreferredSaveChat() {
    const saveChat = getPreferredSaveChatFunction();
    if (typeof saveChat !== 'function') return false;

    const result = saveChat();
    if (result && typeof result.then === 'function') await result;
    return true;
}

function getBaiBaiSaveGenerateState() {
    const root = getGlobalObject();
    const state = root.__baiBaiToolkitSaveGenerateFetchPatched;
    return state && typeof state === 'object' ? state : null;
}

export function shouldDelayChatSaveForHost() {
    const state = getBaiBaiSaveGenerateState();
    if (!state) return false;

    const hasPendingJob = Array.isArray(state.pendingJobs)
        && state.pendingJobs.some((job) => job && job.consumed !== true);
    const hasActiveGenerate = state.activeGenerateChatIds instanceof Set && state.activeGenerateChatIds.size > 0;
    const hasLocalGuard = state.localRequestGuards instanceof Map && state.localRequestGuards.size > 0;
    const hasResumeCheck = state.resumeCheckPromises instanceof Map && state.resumeCheckPromises.size > 0;
    return Boolean(
        hasPendingJob
        || hasActiveGenerate
        || hasLocalGuard
        || hasResumeCheck
        || state.activeSaveGenerateCancelTarget
        || state.resumeCheckTimer,
    );
}

export function markHostChatDirtyFromIndex(index) {
    if (!isTauriTavernHost()) return false;
    if (!Number.isInteger(index) || index < 0) return false;

    const { markWindowedChatDirtyFromIndex } = getAppContext();
    if (typeof markWindowedChatDirtyFromIndex !== 'function') return false;

    try {
        markWindowedChatDirtyFromIndex(index);
        return true;
    } catch (error) {
        logger.warn(`宿主 dirty 标记失败 index=${index}`, error);
        return false;
    }
}
