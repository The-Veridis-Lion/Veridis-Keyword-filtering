import * as extensionsModule from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, saveChat, chat_metadata, chat } from "../../../../script.js";

import { defaultSettings, extensionName, initAppContext, runtimeState, markRulesDataDirty, normalizeDiffTrackedMessageLimit } from './src/state.js';
import { logger } from './src/log.js';
import { bindEvents, initRealtimeInterceptor } from './src/events.js';
import { setupUI, updateToolbarUI, applyCharacterPresetBinding, cleanupInvalidPresetBindings } from './src/ui.js';
import { restoreDiffStateFromChatMetadata, injectDiffButtons } from './src/diff.js';
import { performGlobalCleanse } from './src/core.js';
import { mergeScopeTagsWithBuiltins, normalizeScopeTagBuiltinDismissedList, normalizeScopeTagCollapsedGroupList, normalizeScopeTagGroupList } from './src/utils.js';

const { extension_settings, getContext: getSillyTavernContext } = extensionsModule;

initAppContext({
    extension_settings,
    saveSettingsDebounced,
    eventSource,
    event_types,
    saveChat,
    chat_metadata,
    chat,
    getSillyTavernContext,
});

function ensureSettingsShape() {
    const settings = extension_settings[extensionName];
    if (!settings) return;
    if (!settings.rules) settings.rules = [];
    if (!settings.presets) settings.presets = {};
    if (settings.activePreset === undefined) settings.activePreset = "";
    if (settings.defaultPreset === undefined) settings.defaultPreset = "";
    if (!settings.characterBindings || typeof settings.characterBindings !== 'object') settings.characterBindings = {};
    settings.scopeTagGroups = normalizeScopeTagGroupList(settings.scopeTagGroups);
    settings.scopeTagCollapsedGroups = normalizeScopeTagCollapsedGroupList(settings.scopeTagCollapsedGroups, settings.scopeTagGroups);
    settings.scopeTagBuiltinDismissed = normalizeScopeTagBuiltinDismissedList(settings.scopeTagBuiltinDismissed);
    settings.scopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
    if (!['protect', 'cleanse-inside'].includes(settings.scopeTagMode)) settings.scopeTagMode = 'protect';
    if (settings.enableVisualDiff === undefined) settings.enableVisualDiff = true;
    if (!settings.diffViewMode) settings.diffViewMode = 'snippet';
    if (settings.diffButtonInExtraMenu === undefined) settings.diffButtonInExtraMenu = false;
    if (settings.showBottomDiffButton === undefined) settings.showBottomDiffButton = true;
    settings.diffTrackedMessageLimit = normalizeDiffTrackedMessageLimit(settings.diffTrackedMessageLimit);
    if (settings.logLevel === undefined) settings.logLevel = 2;
    if (settings.skipUserMessages === undefined) settings.skipUserMessages = false;
    if (settings.protectPersonaDescription === undefined) settings.protectPersonaDescription = false;
    cleanupInvalidPresetBindings();
}

function normalizeRuleShape(rule, index = 0) {
    if (!rule || typeof rule !== 'object') return;
    if (!rule.name) rule.name = `合集 ${index + 1}`;
    if (rule.enabled === undefined) rule.enabled = true;

    if (rule.targets) {
        rule.subRules = [{
            targets: rule.targets,
            replacements: rule.replacements || [],
            mode: 'text',
            enabled: true,
        }];
        delete rule.targets;
        delete rule.replacements;
    }

    if (!Array.isArray(rule.subRules)) rule.subRules = [];
    rule.subRules.forEach((sub) => {
        if (!sub || typeof sub !== 'object') return;
        if (!sub.mode) sub.mode = 'text';
        if (sub.enabled === undefined) sub.enabled = true;
    });
}

function normalizeRulesListShape(rules) {
    if (!Array.isArray(rules)) return;
    rules.forEach((rule, index) => normalizeRuleShape(rule, index));
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
        markRulesDataDirty();
    }

    if (settings) {
        ensureSettingsShape();
        Object.values(settings.presets || {}).forEach((presetRules) => normalizeRulesListShape(presetRules));

        if (settings.rules && settings.rules.length > 0) {
            normalizeRulesListShape(settings.rules);

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
