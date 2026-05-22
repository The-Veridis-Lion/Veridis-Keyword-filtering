export const extensionName = "ultimate_purifier";
export const diffMetadataKey = `${extensionName}_diff_state_v3`;
export const minTrackedDiffMessages = 1;
export const defaultTrackedDiffMessages = 3;
export const maxTrackedDiffMessages = 20;
export const defaultDeepCleanTimeoutSec = 120;

export const defaultSettings = {
    rules: [],
    presets: {},
    activePreset: "",
    defaultPreset: "",
    characterBindings: {},
    scopeTags: [],
    scopeTagBuiltinDismissed: [],
    scopeTagMode: "protect",
    enableVisualDiff: true,
    diffViewMode: "snippet",
    diffButtonInExtraMenu: false,
    showBottomDiffButton: true,
    diffTrackedMessageLimit: defaultTrackedDiffMessages,
    themeMode: "auto",
    logLevel: 2,  // 0=off, 1=error, 2=warn(default), 3=info, 4=debug
    skipUserMessages: false,
    protectPersonaDescription: false,
};

export const runtimeState = {
    activeProcessors: [],
    isRegexDirty: true,
    rulesUiDirty: true,
    presetsUiDirty: true,
    ruleSearchKeyword: "",
    ruleSearchDraftKeyword: "",
    ruleSearchHasSearched: false,
    ruleSearchExpandedMenuKey: "",
    searchEditFlow: {
        active: false,
        returnMode: "",
        ruleIndex: -1,
        subRuleIndex: -1,
    },
    currentEditingIndex: -1,
    currentEditingSubrules: [],
    currentSubruleEditIndex: -1,
    currentTransferRuleIndex: -1,
    lastCharacterContextKey: "",
    isStreamingGeneration: false,
    chatSaveTimer: null,
    chatSaveInFlight: false,
    pendingChatSave: false,
    isBooted: false,
    diffSnippetsCache: new Map(),
    diffRawSourceCache: new Map(),
    nonStreamingRawMessageCache: new Map(),
    diffMessageStates: new Map(),
    trackedDiffMessageOrder: [],
    currentDiffIndex: undefined,
    diffModalRefresh: null,
    diffRelatedRuleMode: false,
    batchSelectedRuleIds: [],
    currentTransferRuleIndexes: [],
    importPresetDraft: null,
};

const appContext = {
    extension_settings: null,
    saveSettingsDebounced: null,
    eventSource: null,
    event_types: null,
    saveChat: null,
    chat_metadata: null,
    chat: null,
    getSillyTavernContext: null,
};

export function initAppContext(context) {
    Object.assign(appContext, context);
}

export function getAppContext() {
    return appContext;
}

function normalizeIntegerSetting(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.round(parsed), min), max);
}

export function normalizeDiffTrackedMessageLimit(value) {
    return normalizeIntegerSetting(value, minTrackedDiffMessages, maxTrackedDiffMessages, defaultTrackedDiffMessages);
}

export function getDiffTrackedMessageLimit() {
    const settings = appContext.extension_settings?.[extensionName];
    return normalizeDiffTrackedMessageLimit(settings?.diffTrackedMessageLimit);
}

export function markRegexDirty(dirty = true) {
    runtimeState.isRegexDirty = dirty;
}

export function markRulesUiDirty(dirty = true) {
    runtimeState.rulesUiDirty = dirty;
}

export function markPresetsUiDirty(dirty = true) {
    runtimeState.presetsUiDirty = dirty;
}

export function markRulesDataDirty(options = {}) {
    const { rulesUi = true, presetsUi = false } = options;
    markRegexDirty(true);
    if (rulesUi) markRulesUiDirty(true);
    if (presetsUi) markPresetsUiDirty(true);
}
