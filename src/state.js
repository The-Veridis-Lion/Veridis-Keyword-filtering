export const extensionName = "ultimate_purifier";
export const diffMetadataKey = `${extensionName}_diff_state_v3`;
export const maxTrackedDiffMessages = 3;

export const defaultSettings = {
    rules: [],
    presets: {},
    activePreset: "",
    defaultPreset: "",
    characterBindings: {},
    enableVisualDiff: true,
    diffViewMode: "snippet",
    diffButtonInExtraMenu: false,
    deepCleanTimeoutSec: 120,
    themeMode: "auto",
    logLevel: 2  // 0=off, 1=error, 2=warn(default), 3=info, 4=debug
};

export const runtimeState = {
    activeProcessors: [],
    isRegexDirty: true,
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
    batchSelectedRuleIds: [],
    currentTransferRuleIndexes: [],
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
