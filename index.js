import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, saveChat, chat_metadata, chat } from "../../../../script.js";

import { defaultSettings, extensionName, initAppContext, runtimeState } from './src/state.js';
import { logger } from './src/log.js';
import { bindEvents, initRealtimeInterceptor } from './src/events.js';
import { setupUI, updateToolbarUI, applyCharacterPresetBinding, cleanupInvalidPresetBindings } from './src/ui.js';
import { restoreDiffStateFromChatMetadata, injectDiffButtons } from './src/diff.js';
import { performGlobalCleanse } from './src/core.js';

initAppContext({
    extension_settings,
    saveSettingsDebounced,
    eventSource,
    event_types,
    saveChat,
    chat_metadata,
    chat,
});

function ensureSettingsShape() {
    const settings = extension_settings[extensionName];
    if (!settings) return;
    if (!settings.rules) settings.rules = [];
    if (!settings.presets) settings.presets = {};
    if (settings.activePreset === undefined) settings.activePreset = "";
    if (settings.defaultPreset === undefined) settings.defaultPreset = "";
    if (!settings.characterBindings || typeof settings.characterBindings !== 'object') settings.characterBindings = {};
    if (settings.enableVisualDiff === undefined) settings.enableVisualDiff = true;
    if (!settings.diffViewMode) settings.diffViewMode = 'snippet';
    if (settings.diffButtonInExtraMenu === undefined) settings.diffButtonInExtraMenu = false;
    if (settings.logLevel === undefined) settings.logLevel = 2;
    if (settings.skipUserMessages === undefined) settings.skipUserMessages = false;
    cleanupInvalidPresetBindings();

    const timeoutSec = Number(settings.deepCleanTimeoutSec);
    settings.deepCleanTimeoutSec = Number.isFinite(timeoutSec)
        ? Math.min(Math.max(timeoutSec, 10), 1800)
        : defaultSettings.deepCleanTimeoutSec;
}

function migrateOldData() {
    const settings = extension_settings[extensionName];
    if (settings && settings.bannedWords) {
        if (settings.bannedWords.length > 0) {
            settings.rules = settings.rules || [];
            settings.rules.push({
                name: "旧版本过滤词",
                subRules: [{ targets: [...settings.bannedWords], replacements: [], mode: 'text' }],
                enabled: true
            });
        }
        delete settings.bannedWords;
        runtimeState.isRegexDirty = true;
    }

    if (settings) {
        ensureSettingsShape();

        if (settings.rules && settings.rules.length > 0) {
            settings.rules.forEach((r, i) => {
                if (!r.name) r.name = `合集 ${i + 1}`;
                if (r.enabled === undefined) r.enabled = true;

                if (r.targets) {
                    r.subRules = [{
                        targets: r.targets,
                        replacements: r.replacements || [],
                        mode: 'text'
                    }];
                    delete r.targets;
                    delete r.replacements;
                }
                if (!r.subRules) r.subRules = [];
                r.subRules.forEach(sub => { if (!sub.mode) sub.mode = 'text'; });
            });

            if (Object.keys(settings.presets).length === 0) {
                settings.presets["默认存档"] = JSON.parse(JSON.stringify(settings.rules));
                settings.activePreset = "默认存档";
            }
        }
        saveSettingsDebounced();
    }
}

jQuery(() => {
    if (runtimeState.isBooted) return;
    extension_settings[extensionName] = extension_settings[extensionName] || { ...defaultSettings };

    migrateOldData();
    ensureSettingsShape();

    const boot = () => {
        if (runtimeState.isBooted) return;
        runtimeState.isBooted = true;
        logger.info('[屏蔽词净化助手] 启动初始化开始...');
        setupUI();
        bindEvents();
        initRealtimeInterceptor();
        updateToolbarUI();
        applyCharacterPresetBinding(true, { skipCleanse: true });
        restoreDiffStateFromChatMetadata();
        setTimeout(() => {
            injectDiffButtons();
            performGlobalCleanse();
        }, 80);
        logger.info('[屏蔽词净化助手] 启动初始化完成');
    };

    if (typeof eventSource !== 'undefined' && event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, boot);
        if (document.getElementById('send_textarea')) boot();
    }
});
