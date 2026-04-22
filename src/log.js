/**
 * 日志模块：[屏蔽词净化助手]
 *
 * 支持四级日志，通过设置项 `extension_settings[extensionName].logLevel` 控制：
 *   0 = off（全部禁用）
 *   1 = error（仅错误）
 *   2 = warn  （默认，警告及以上）
 *   3 = info  （信息及以上）
 *   4 = debug （全部，包括 debug）
 *
 * 修改设置项后无需重载，下次调用即生效。
 */

import { extensionName, getAppContext } from './state.js';

const LOG_PREFIX = '[屏蔽词净化助手]';

function getLogLevel() {
    try {
        const { extension_settings } = getAppContext();
        const level = extension_settings?.[extensionName]?.logLevel;
        return typeof level === 'number' && level >= 0 && level <= 4 ? level : 2;
    } catch (_) {
        return 2;
    }
}

const LEVEL_NUM = { error: 1, warn: 2, info: 3, debug: 4 };

function shouldLog(level) {
    const threshold = getLogLevel();
    if (threshold === 0) return false;
    return (LEVEL_NUM[level] ?? 2) <= threshold;
}

function formatTime() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZoneName: 'short' });
}

function output(level, message, args) {
    const tag = level.toUpperCase().padEnd(5);
    const stamp = formatTime();
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'info' ? console.info : console.log;
    fn(`${LOG_PREFIX} [${stamp}] [${tag}] ${message}`, ...args);
}

export const logger = {
    warn(message, ...args) {
        if (shouldLog('warn'))  output('warn',  message, args);
    },
    error(message, ...args) {
        if (shouldLog('error')) output('error', message, args);
    },
    info(message, ...args) {
        if (shouldLog('info'))  output('info',  message, args);
    },
    debug(message, ...args) {
        if (shouldLog('debug')) output('debug', message, args);
    },
};
