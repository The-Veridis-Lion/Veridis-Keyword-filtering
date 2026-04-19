export const extensionName = "ultimate_purifier";

export const defaultSettings = {
    rules: [],
    presets: {},
    activePreset: "",
    defaultPreset: "",
    characterBindings: {},
    enableVisualDiff: true,
    diffViewMode: "snippet",
    diffButtonInExtraMenu: false, // <-- 新增：收纳按钮设置默认值
    deepCleanTimeoutSec: 120
};

export const runtimeState = {
    activeProcessors: [],
    isRegexDirty: true,
    currentEditingIndex: -1,
    currentEditingSubrules: [],
    currentTransferRuleIndex: -1,
    lastCharacterContextKey: "",
    isStreamingGeneration: false,
    chatSaveTimer: null,
    chatSaveInFlight: false,
    pendingChatSave: false,
    isBooted: false,
    diffSnippetsCache: new Map(),
    currentDiffIndex: undefined,
};

const appContext = {
    extension_settings: null,
    saveSettingsDebounced: null,
    eventSource: null,
    event_types: null,
    saveChat: null,
    chat_metadata: null,
    chat: null,
};

export function initAppContext(context) {
    Object.assign(appContext, context);
}

export function getAppContext() {
    return appContext;
}

export function markRegexDirty(dirty = true) {
    runtimeState.isRegexDirty = dirty;
}
