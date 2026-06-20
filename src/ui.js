import { extensionName, getAppContext, runtimeState, markRulesDataDirty, markRulesUiDirty, markPresetsUiDirty } from './state.js';
import { logger } from './log.js';
import { COT_SCOPE_TAG_DISPLAY_TEXT, DEFAULT_SCOPE_TAG_GROUP_ID, DEFAULT_SCOPE_TAG_GROUP_NAME, deepClone, getCurrentCharacterContext, getCurrentChatCompletionPresetName, getPresetBindingResolution, getPresetBindingUsage, getPresetForCharacter, isCotScopeTagEntry, mergeScopeTagsWithBuiltins, normalizeScopeTagCollapsedGroupList, normalizeScopeTagGroupList, parseInputToWords } from './utils.js';
import { performGlobalCleanse } from './core.js';
import { performDeepCleanse } from './cleanse.js';

function safeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatReplacementCandidatePreview(value) {
    const normalized = String(value ?? '').replace(/\r/g, '');
    return normalized ? safeHtml(normalized).replace(/\n/g, ' ↵ ') : '【直接删除】';
}

function formatReplacementPreview(replacements, mode = 'text') {
    if (!Array.isArray(replacements) || replacements.length === 0) return '【直接删除】';
    if (mode === 'regex') {
        return replacements.map((value) => `〔${formatReplacementCandidatePreview(value)}〕`).join(' / ');
    }
    return replacements.map(formatReplacementCandidatePreview).join(', ');
}

function normalizeReplacementList(replacements) {
    return Array.isArray(replacements) ? replacements.map((value) => String(value ?? '')) : [];
}

function getRulePreviewTagText(mode = 'text') {
    if (mode === 'regex') return '正则';
    if (mode === 'simple') return '简易';
    return '普通';
}

function getRuleSourcePreviewText(sub = {}) {
    const mode = sub.mode || 'text';
    return safeHtml((sub.targets || []).join(mode === 'text' ? ', ' : ' | ')) || '（空）';
}

function getRuleSearchMenuKey(ruleIndex, subRuleIndex) {
    return `${ruleIndex}:${subRuleIndex}`;
}

function applyTauriMobileSurface(selector, surface) {
    $(selector).attr('data-tt-mobile-surface', surface);
}

function annotateTauriMobileSurfaces() {
    applyTauriMobileSurface('#bl-purifier-popup', 'fullscreen-window');
    applyTauriMobileSurface('.bl-modal-shell, #bl-rule-transfer-modal, #bl-diff-modal, #bl-loading-overlay', 'backdrop');
    applyTauriMobileSurface('.bl-modal-card, .bl-transfer-content, .bl-diff-modal-card, .bl-loading-panel, .bl-scope-tag-editor-card, .bl-scope-group-manager-card', 'fullscreen-window');
    applyTauriMobileSurface('.bl-toast', 'free-window');
}

function buildRuleSearchHaystack(sub = {}) {
    const mode = sub.mode || 'text';
    const targets = Array.isArray(sub.targets) ? sub.targets.join(mode === 'text' ? ' ' : '\n') : '';
    const replacements = Array.isArray(sub.replacements) ? sub.replacements.join('\n') : '';
    return `${targets}\n${replacements}`.toLowerCase();
}

function buildRuleSearchResults(keyword) {
    const normalizedKeyword = String(keyword || '').trim().toLowerCase();
    if (!normalizedKeyword) return [];

    const { extension_settings } = getAppContext();
    const rules = extension_settings?.[extensionName]?.rules || [];
    const results = [];

    rules.forEach((rule, ruleIndex) => {
        (rule.subRules || []).forEach((sub, subRuleIndex) => {
            if (!buildRuleSearchHaystack(sub).includes(normalizedKeyword)) return;
            const mode = sub.mode || 'text';
            results.push({
                key: getRuleSearchMenuKey(ruleIndex, subRuleIndex),
                ruleIndex,
                subRuleIndex,
                groupName: safeHtml(rule.name || `合集 ${ruleIndex + 1}`),
                tagText: getRulePreviewTagText(mode),
                sourcePreview: getRuleSourcePreviewText(sub),
                replacementPreview: formatReplacementPreview(sub.replacements || [], mode),
                isEnabled: rule.enabled !== false && sub.enabled !== false,
            });
        });
    });

    return results;
}

function getRegexReplacementEditIndex() {
    const rawIndex = Number($('#bl-modal-sub-rep').data('regex-edit-index'));
    return Number.isInteger(rawIndex) ? rawIndex : -1;
}

function getRegexReplacementChipValues() {
    return $('#bl-modal-sub-regex-list').children('.bl-regex-replacement-chip').map(function() {
        return String($(this).data('value') ?? '');
    }).get();
}

function buildRegexReplacementChip(value = '') {
    const normalizedValue = String(value ?? '');
    const preview = formatReplacementCandidatePreview(normalizedValue);
    const $chip = $(`
        <div class="bl-regex-replacement-chip" data-index="0">
            <button type="button" class="bl-regex-replacement-chip-main" data-index="0" title="点击编辑替换项"></button>
            <button type="button" class="bl-regex-replacement-chip-remove" data-index="0" title="删除替换项">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `);
    $chip.data('value', normalizedValue);
    $chip.find('.bl-regex-replacement-chip-main').html(preview).attr('title', normalizedValue || '点击编辑替换项');
    return $chip;
}

function appendRegexReplacementInputs(values = [], options = {}) {
    const normalizedValues = normalizeReplacementList(values);
    const { sync = true } = options;
    if (normalizedValues.length === 0) return $();

    const $container = $('#bl-modal-sub-regex-list');
    const fragment = document.createDocumentFragment();
    const nodes = [];
    normalizedValues.forEach((value) => {
        const node = buildRegexReplacementChip(value)[0];
        nodes.push(node);
        fragment.appendChild(node);
    });
    $container.append(fragment);
    if (sync) syncRegexReplacementInputState();
    return $(nodes);
}

function syncRegexReplacementInputState() {
    const $container = $('#bl-modal-sub-regex-list');
    const $textarea = $('#bl-modal-sub-rep');
    $container.children('.bl-regex-replacement-empty').remove();
    const $items = $container.children('.bl-regex-replacement-chip');
    let editIndex = getRegexReplacementEditIndex();
    if (editIndex >= $items.length) {
        editIndex = -1;
        $textarea.data('regex-edit-index', -1);
    }
    $items.each((index, element) => {
        const $element = $(element);
        $element.attr('data-index', index);
        $element.toggleClass('is-active', index === editIndex);
        $element.find('.bl-regex-replacement-chip-main').attr('data-index', index);
        $element.find('.bl-regex-replacement-chip-remove').attr('data-index', index);
    });
    const isEditing = editIndex >= 0;
    const defaultPlaceholder = String($textarea.data('regex-default-placeholder') || '');
    const editPlaceholder = String($textarea.data('regex-edit-placeholder') || defaultPlaceholder);
    const isRegexEditorVisible = !$('#bl-modal-sub-regex-actions').prop('hidden');
    if ($items.length === 0 && isRegexEditorVisible) {
        $container.append(`
            <div class="bl-regex-replacement-empty" aria-live="polite">
                <i class="fas fa-eraser"></i>
                <span>未添加替换项，命中后将直接删除。</span>
            </div>
        `);
    }
    $container.prop('hidden', $items.length === 0 && !isRegexEditorVisible);
    $('#bl-modal-sub-regex-recognize').text(isEditing ? '更新替换项' : '按行识别');
    $textarea.attr('placeholder', isEditing ? editPlaceholder : defaultPlaceholder);
}

export function showToast(message) {
    $('.bl-toast').remove();
    const themeMode = String($('#bl-purifier-popup').attr('data-bl-theme') || 'auto');
    // 替换为 100% 兼容的 fas fa-exclamation-circle 图标
    const $toast = $(`<div class="bl-toast" data-bl-theme="${themeMode}" data-tt-mobile-surface="free-window" role="status" aria-live="polite"><i class="fas fa-exclamation-circle" style="margin-right: 6px; font-size: 15px;"></i><span class="bl-toast-text"></span></div>`);
    $toast.find('.bl-toast-text').text(String(message || ''));
    $('body').append($toast);
    setTimeout(() => $toast.addClass('bl-show'), 10);
    setTimeout(() => {
        $toast.removeClass('bl-show');
        setTimeout(() => $toast.remove(), 300);
    }, 2000);
}

export function setupUI() {
    logger.debug('[setupUI] 开始初始化 UI');
    $('#bl-purifier-popup, #bl-rule-edit-modal, #bl-confirm-modal, #bl-rule-transfer-modal, #bl-preset-import-choice-modal, #bl-rule-search-modal, #bl-scope-tags-modal, #bl-diff-modal, #bl-subrule-edit-modal, #bl-loading-overlay, .bl-toast').remove();

    const ensureExtensionPanelEntry = () => {
        if ($('#bl-extension-settings-entry').length || !$('#extensions_settings').length) return;
        $('#extensions_settings').append(`
            <div id="bl-extension-settings-entry" class="inline-drawer bl-extension-settings-entry">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>屏蔽词净化助手</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down interactable"></div>
                </div>
                <div class="inline-drawer-content">
                    <button id="bl-wand-btn-panel" type="button" class="menu_button bl-extension-open-btn">
                        <i class="fa-solid fa-language fa-fw"></i>
                        <span>打开词汇映射</span>
                    </button>
                </div>
            </div>
        `);
    };

    if (!$('#bl-wand-btn').length) {
        $('#data_bank_wand_container').append(`
            <div id="bl-wand-btn" title="词汇映射管理">
                <i class="fa-solid fa-language fa-fw"></i><span>词汇映射</span>
            </div>`);
    }
    ensureExtensionPanelEntry();
    window.setTimeout(ensureExtensionPanelEntry, 500);

    $('body').append(`
        <div id="bl-purifier-popup" data-bl-theme="auto" style="display:none;">
            <div class="bl-header">
                <div class="bl-title">
                    <i class="fas fa-globe"></i>
                    全局映射预设
                </div>
                <div class="bl-icon-group">
                    <button id="bl-theme-toggle" type="button" title="切换主题" aria-label="切换主题"><i class="fas fa-circle-half-stroke"></i></button>
                    <button id="bl-default-toggle" title="设为全局默认净化预设" class="bl-bind-toggle"><i class="fas fa-star"></i></button>
                    <div class="bl-bind-menu-wrap">
                        <button id="bl-character-bind-toggle" type="button" title="绑定管理" class="bl-bind-toggle" aria-label="绑定管理" aria-haspopup="true" aria-expanded="false"><i class="fas fa-link"></i></button>
                        <div id="bl-bind-menu" class="bl-bind-menu" role="menu" hidden>
                            <button type="button" id="bl-bind-current-character" class="bl-bind-menu-item" data-bind-action="character" role="menuitem">
                                <i class="fas fa-user-tag"></i>
                                <span class="bl-bind-menu-copy">
                                    <span class="bl-bind-menu-label">绑定当前角色</span>
                                    <span class="bl-bind-menu-note">使用当前净化预设</span>
                                </span>
                            </button>
                            <button type="button" id="bl-bind-current-chat-preset" class="bl-bind-menu-item" data-bind-action="chat-preset" role="menuitem">
                                <i class="fas fa-comments"></i>
                                <span class="bl-bind-menu-copy">
                                    <span class="bl-bind-menu-label">绑定当前对话补全预设</span>
                                    <span class="bl-bind-menu-note">跟随 ST 当前对话补全预设</span>
                                </span>
                            </button>
                            <button type="button" id="bl-unbind-current-character" class="bl-bind-menu-item" data-bind-action="unbind-character" role="menuitem">
                                <i class="fas fa-rotate-left"></i>
                                <span class="bl-bind-menu-copy">
                                    <span class="bl-bind-menu-label">取消当前绑定</span>
                                    <span class="bl-bind-menu-note">改为跟随全局默认</span>
                                </span>
                            </button>
                        </div>
                    </div>
                    <button id="bl-preset-import" title="导入存档"><i class="fas fa-file-import"></i></button>
                    <button id="bl-preset-export" title="导出存档"><i class="fas fa-file-export"></i></button>
                    <button id="bl-close-btn" title="关闭"><i class="fas fa-times"></i></button>
                </div>
            </div>

            <div class="bl-toolbar">
                <select id="bl-preset-select" class="bl-select-box"></select>
                <div class="bl-icon-group">
                    <button id="bl-preset-rename" title="重命名"><i class="fas fa-pen"></i></button>
                    <button id="bl-preset-save" title="保存"><i class="fas fa-save"></i></button>
                    <button id="bl-preset-new" title="新建"><i class="fas fa-plus"></i></button>
                    <button id="bl-preset-delete" title="删除存档"><i class="fas fa-trash"></i></button>
                    <button id="bl-preset-search" title="搜索规则"><i class="fas fa-magnifying-glass"></i></button>
                    <button id="bl-zh-compat-toggle" class="bl-zh-compat-toggle" type="button" title="简繁兼容已关闭：按当前规则精确匹配" aria-label="简繁兼容模式" aria-pressed="false"><i class="fas fa-language"></i></button>
                </div>
            </div>

            <div class="bl-action-buttons">
                <button id="bl-open-new-rule-btn" class="bl-btn-secondary"><i class="fas fa-folder-plus"></i> 新增规则分组</button>
                <button class="bl-btn-secondary" id="bl-scope-tags-btn"><i class="fas fa-tags"></i> 净化模式</button>
                <button class="bl-btn-secondary" id="bl-batch-toggle"><i class="fas fa-list-check"></i> 批量编辑模式</button>
            </div>

            <div class="bl-batch-operations" id="bl-batch-operations">
                <button class="bl-batch-btn" id="bl-btn-select-all"><i class="far fa-check-square"></i> 全选</button>
                <button class="bl-batch-btn" id="bl-btn-select-invert"><i class="fas fa-minus-square"></i> 反选</button>
                <button class="bl-batch-btn" id="bl-btn-batch-transfer"><i class="fas fa-copy"></i> 复制 / 转移</button>
                <button class="bl-batch-btn bl-danger" id="bl-btn-batch-delete"><i class="fas fa-trash"></i> 删除</button>
            </div>

            <div class="bl-divider"></div>

            <div id="bl-tags-container" class="bl-card-list" style="overflow-y:auto; flex:1;"></div>

            <div class="bl-bottom-bar">
                <label class="bl-checkbox-label" title="开启后，被修改过的消息旁会显示溯源按钮">
                    <input type="checkbox" id="bl-diff-global-toggle">
                    <span class="bl-custom-checkbox bl-square"></span>
                    <span class="bl-bottom-text">透视模式</span>
                </label>
                <label class="bl-checkbox-label" title="开启后仅过滤 AI 回复，用户消息不受影响">
                    <input type="checkbox" id="bl-skip-user-toggle">
                    <span class="bl-custom-checkbox bl-square"></span>
                    <span class="bl-bottom-text">跳过用户消息</span>
                </label>
                <button id="bl-deep-clean-btn" class="bl-btn-danger"><i class="fas fa-broom"></i> 深度清理</button>
            </div>
        </div>`);

    $('body').append(`
        <div id="bl-rule-edit-modal" class="bl-modal-shell">
            <div class="bl-modal-card bl-edit-modal-card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-shrink: 0;">
                    <h3 id="bl-edit-modal-title" class="bl-edit-modal-title" style="margin: 0; display: flex; align-items: center; gap: 8px;">
                        <i class="fas fa-pen"></i> 编辑规则合集
                    </h3>
                    <button id="bl-edit-cancel-x" class="bl-icon-btn" style="background: transparent !important; border: none !important; box-shadow: none !important; font-size: 20px !important; color: var(--bl-text-mute); padding: 0 !important; min-width: auto !important; height: auto !important; cursor: pointer;">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="bl-edit-field">
                    <label class="bl-field-label">规则组合集名称</label>
                    <input type="text" id="bl-edit-name" class="bl-input" placeholder="例如：程度副词与认知失能净化" style="background: var(--bl-bg-button) !important; border: 1px solid var(--bl-border-color-base) !important; color: var(--bl-text-main) !important;">
                </div>
                <label class="bl-field-label" style="margin-bottom:6px; flex-shrink:0;">映射规则列表</label>
                <div id="bl-edit-subrules-container"></div>
                
                <div class="bl-modal-actions">
                    <button id="bl-add-subrule-btn" class="bl-secondary-btn"><i class="fas fa-plus"></i> 新增规则</button>
                    <button id="bl-edit-save" class="bl-primary-btn"><i class="fas fa-check"></i> 保存合集</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-confirm-modal" class="bl-modal-shell">
            <div class="bl-modal-card bl-confirm-card">
                <h3 class="bl-confirm-title">⚠️ 深度清理警告</h3>
                <p class="bl-confirm-text">
                    深度清理会永久洗刷角色卡、世界书、人设、全部历史记录及<strong>当前选中的预设</strong>。
                    为了防止深度清理修改或误伤您的以上内容，请在此刻：
                    <br><br>
                    👉 <strong class="bl-warning-callout">将SillyTavern当前的预设切换至「Default」或废弃预设！<br>将插件预设切换至不含名词句式规则(已在贴内提供)。</strong>
                    <br>
                    <span class="bl-field-label">清理完成后页面会刷新，届时可切回原预设即可保证预设安全。</span>
                </p>
                <div class="bl-modal-actions bl-confirm-actions">
                    <button id="bl-modal-cancel" class="bl-secondary-btn bl-confirm-btn">取消返回</button>
                    <button id="bl-modal-confirm" disabled class="bl-primary-btn bl-confirm-btn">我已阅读警告，已完成切换 (3s)</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-zh-dictionary-modal" class="bl-modal-shell">
            <div class="bl-modal-card bl-zh-dict-card">
                <div class="bl-zh-dict-header">
                    <h3 class="bl-zh-dict-title"><i class="fas fa-language"></i> 增强简繁词典</h3>
                    <button id="bl-zh-dict-close" type="button" class="bl-icon-btn" title="关闭"><i class="fas fa-times"></i></button>
                </div>
                <p class="bl-zh-dict-text">
                    简繁兼容需要先从 GitHub 下载 OpenCC 词典包。若无法连接 GitHub，请开启代理或 VPN 后重试；下载完成并通过完整性校验后，之后会直接使用本地缓存。
                </p>
                <div id="bl-zh-dict-stats" class="bl-zh-dict-stats"></div>
                <div class="bl-zh-dict-options">
                    <label class="bl-checkbox-label" title="匹配台湾常用异体词，例如 仿佛 / 彷彿、软件 / 軟體">
                        <input type="checkbox" id="bl-zh-dict-tw" checked>
                        <span class="bl-custom-checkbox bl-square"></span>
                        <span>台湾异体</span>
                    </label>
                    <label class="bl-checkbox-label" title="匹配香港常用异体词，例如 软件 / 軟件、网络 / 網絡">
                        <input type="checkbox" id="bl-zh-dict-hk" checked>
                        <span class="bl-custom-checkbox bl-square"></span>
                        <span>香港异体</span>
                    </label>
                </div>
                <div class="bl-modal-actions bl-zh-dict-actions">
                    <button id="bl-zh-dict-cancel" type="button" class="bl-secondary-btn">取消</button>
                    <button id="bl-zh-dict-download" type="button" class="bl-primary-btn"><i class="fas fa-download"></i> 下载并启用</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-rule-transfer-modal" style="display:none;">
            <div class="bl-transfer-content">
                <h3 class="bl-edit-modal-title bl-transfer-title"><i class="fas fa-copy"></i> 复制 / 转移规则合集</h3>
                <select id="bl-transfer-target" class="bl-input bl-transfer-target"></select>
                <div class="bl-transfer-actions">
                    <button id="bl-transfer-copy" class="bl-transfer-btn bl-transfer-copy">复制到该存档</button>
                    <button id="bl-transfer-move" class="bl-transfer-btn bl-transfer-move">转移到该存档</button>
                    <button id="bl-transfer-cancel" class="bl-transfer-btn">取消</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-preset-import-choice-modal" class="bl-modal-shell">
            <div class="bl-modal-card bl-import-choice-card">
                <div class="bl-import-choice-header">
                    <h3 class="bl-edit-modal-title"><i class="fas fa-file-import"></i> 导入预设</h3>
                    <button id="bl-import-choice-close" type="button" class="bl-icon-btn" title="关闭"><i class="fas fa-times"></i></button>
                </div>
                <div class="bl-edit-field">
                    <label class="bl-field-label" for="bl-import-preset-name">预设名称</label>
                    <input type="text" id="bl-import-preset-name" class="bl-input" placeholder="导入预设名称">
                </div>
                <div id="bl-import-choice-summary" class="bl-import-choice-summary"></div>
                <div class="bl-import-choice-actions">
                    <button id="bl-import-only" type="button" class="bl-secondary-btn bl-import-choice-btn">
                        <i class="fas fa-box-archive"></i>
                        <span>只导入为新预设</span>
                    </button>
                    <button id="bl-import-switch" type="button" class="bl-primary-btn bl-import-choice-btn">
                        <i class="fas fa-right-left"></i>
                        <span>导入并切换使用</span>
                    </button>
                    <button id="bl-import-preview" type="button" class="bl-secondary-btn bl-import-choice-btn">
                        <i class="fas fa-eye"></i>
                        <span>仅临时预览</span>
                    </button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-rule-search-modal" class="bl-modal-shell">
            <div class="bl-modal-card bl-rule-search-card">
                <div class="bl-rule-search-header">
                    <button id="bl-rule-search-back" type="button" class="bl-icon-btn bl-rule-search-back" title="返回搜索页上一级">
                        <i class="fas fa-chevron-left"></i>
                    </button>
                    <div class="bl-rule-search-field">
                        <i class="fas fa-magnifying-glass bl-rule-search-field-icon"></i>
                        <input type="text" id="bl-rule-search-input" class="bl-input bl-rule-search-input" placeholder="搜索内容">
                        <button id="bl-rule-search-clear" type="button" class="bl-icon-btn bl-rule-search-clear" title="清空关键词" hidden>
                            <i class="fas fa-circle-xmark"></i>
                        </button>
                    </div>
                    <button id="bl-rule-search-submit" type="button" class="bl-rule-search-submit">搜索</button>
                </div>
                <div id="bl-rule-search-body" class="bl-rule-search-body"></div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-scope-tags-modal" class="bl-modal-shell">
            <div class="bl-modal-card bl-scope-tags-card">
                <div class="bl-scope-tags-header">
                    <h3 class="bl-scope-tags-title"><i class="fas fa-tag"></i> 预设净化模式</h3>
                    <button id="bl-scope-tags-close" type="button" class="bl-icon-btn bl-scope-tags-close" title="关闭"><i class="fas fa-times"></i></button>
                </div>

                <section class="bl-scope-mode-section" aria-labelledby="bl-scope-mode-title">
                    <div id="bl-scope-mode-title" class="bl-scope-section-title">当前模式</div>
                    <div class="bl-scope-mode-segment" role="group" aria-label="范围标签净化模式">
                        <button id="bl-scope-mode-protect" type="button" class="bl-scope-mode-option" data-mode="protect">保护特定标签</button>
                        <button id="bl-scope-mode-cleanse" type="button" class="bl-scope-mode-option" data-mode="cleanse-inside">净化特定标签</button>
                    </div>
                    <div id="bl-scope-tags-hint" class="bl-scope-tags-hint"></div>
                </section>

                <section class="bl-scope-manage-section" aria-labelledby="bl-scope-manage-title">
                    <div class="bl-scope-manage-head">
                        <h4 id="bl-scope-manage-title" class="bl-scope-section-title">管理标签</h4>
                        <div class="bl-scope-manage-actions">
                            <button id="bl-scope-tags-expand-all" type="button" class="bl-icon-btn bl-scope-manage-icon" title="全部展开" aria-label="全部展开">
                                <i class="fas fa-expand-alt"></i>
                            </button>
                            <button id="bl-scope-tags-collapse-all" type="button" class="bl-icon-btn bl-scope-manage-icon" title="全部折叠" aria-label="全部折叠">
                                <i class="fas fa-compress-alt"></i>
                            </button>
                            <div class="bl-scope-tag-menu-wrap">
                                <button id="bl-scope-tag-menu-open" type="button" class="bl-icon-btn bl-scope-manage-icon" title="标签菜单" aria-label="标签菜单" aria-haspopup="true" aria-expanded="false">
                                    <i class="fas fa-ellipsis-v"></i>
                                </button>
                                <div id="bl-scope-tag-action-menu" class="bl-scope-tag-action-menu" hidden>
                                    <button id="bl-scope-tag-add-open" type="button" class="bl-scope-tag-action-item">
                                        <i class="fas fa-plus"></i><span>添加标签</span>
                                    </button>
                                    <button id="bl-scope-group-manage-open" type="button" class="bl-scope-tag-action-item">
                                        <i class="fas fa-layer-group"></i><span>管理分组</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div id="bl-scope-tags-list" class="bl-scope-tags-list"></div>
                </section>
            </div>

            <div id="bl-scope-tag-editor-modal" class="bl-scope-tag-editor-modal" hidden>
                <div class="bl-scope-tag-editor-card" role="dialog" aria-modal="true" aria-labelledby="bl-scope-tag-editor-title">
                    <h3 id="bl-scope-tag-editor-title" class="bl-scope-tag-editor-title">新增标签</h3>
                    <div class="bl-scope-tag-editor-field">
                        <label class="bl-field-label" for="bl-scope-tag-group-select">所属分组</label>
                        <select id="bl-scope-tag-group-select" class="bl-input bl-scope-tag-input"></select>
                    </div>
                    <div class="bl-scope-tag-editor-field">
                        <label class="bl-field-label" for="bl-scope-tag-input">输入标签</label>
                        <input type="text" id="bl-scope-tag-input" class="bl-input bl-scope-tag-input" placeholder="如：状态 或 <UpdateVariable>" autocomplete="off">
                        <div class="bl-scope-tag-field-help">填写标签名或完整起始标签，会自动补齐；支持中文标签名，不支持带属性的起始标签。</div>
                    </div>
                    <div class="bl-scope-tag-editor-field">
                        <label class="bl-field-label" for="bl-scope-tag-label-input">输入备注</label>
                        <input type="text" id="bl-scope-tag-label-input" class="bl-input bl-scope-tag-input" placeholder="如：选项（选填）" autocomplete="off">
                    </div>
                    <div id="bl-scope-tag-error" class="bl-field-error" aria-live="polite"></div>
                    <div class="bl-scope-tag-editor-actions">
                        <button id="bl-scope-tag-reset" type="button" class="bl-scope-tag-cancel">取消</button>
                        <button id="bl-scope-tag-save" type="button" class="bl-scope-tag-confirm">确认</button>
                    </div>
                </div>
            </div>

            <div id="bl-scope-group-manager-modal" class="bl-scope-group-manager-modal" hidden>
                <div class="bl-scope-group-manager-card" role="dialog" aria-modal="true" aria-labelledby="bl-scope-group-manager-title">
                    <h3 id="bl-scope-group-manager-title" class="bl-scope-tag-editor-title">管理分组</h3>
                    <div id="bl-scope-group-manager-list" class="bl-scope-group-manager-list"></div>
                    <div class="bl-scope-group-manager-actions">
                        <button id="bl-scope-group-add" type="button" class="bl-scope-tag-cancel">新增分组</button>
                        <button id="bl-scope-group-done" type="button" class="bl-scope-tag-confirm">完成</button>
                    </div>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-diff-modal" style="display:none;">
            <div class="bl-diff-modal-card">
                <div class="bl-diff-modal-header">
                    <h3 class="bl-diff-modal-title"><i class="fa-solid fa-eye"></i><span class="bl-diff-title-text">净化前文透视</span></h3>
                    <div class="bl-diff-header-actions">
                        <div id="bl-diff-limit-control" class="bl-diff-limit-control">
                            <button id="bl-diff-limit-edit" type="button" class="bl-icon-btn bl-diff-header-btn bl-diff-limit-display" title="设置透视楼层数量">
                                <i class="fa-solid fa-layer-group"></i> <span id="bl-diff-limit-text">最近 3 层</span>
                            </button>
                            <div id="bl-diff-limit-editor" class="bl-diff-limit-editor" hidden>
                                <input type="number" id="bl-diff-limit-input" class="bl-diff-limit-input" inputmode="numeric" min="1" max="20" step="1" aria-label="透视楼层数量">
                                <button id="bl-diff-limit-confirm" type="button" class="bl-icon-btn bl-diff-limit-action" title="确认楼层数量"><i class="fas fa-check"></i></button>
                                <button id="bl-diff-limit-cancel" type="button" class="bl-icon-btn bl-diff-limit-action" title="取消修改"><i class="fas fa-times"></i></button>
                            </div>
                        </div>
                        <button id="bl-diff-revert-toggle" type="button" class="bl-icon-btn bl-diff-header-btn" title="撤回净化并保护原文">
                            <i id="bl-diff-revert-icon" class="fas fa-rotate-left"></i> <span id="bl-diff-revert-text">撤回</span>
                        </button>
                        <button id="bl-diff-mode-toggle" type="button" class="bl-icon-btn bl-diff-header-btn" title="切换到全文模式" aria-label="切换到全文模式">
                            <i id="bl-diff-mode-icon" class="fa-solid fa-file-lines"></i> <span id="bl-diff-mode-text">全文模式</span>
                        </button>
                        <div class="bl-diff-menu-wrap">
                            <button id="bl-diff-menu-toggle" type="button" class="bl-icon-btn bl-diff-header-btn bl-diff-menu-toggle" title="更多操作" aria-label="更多操作" aria-haspopup="true" aria-expanded="false">
                                <i class="fa-solid fa-ellipsis"></i>
                            </button>
                            <div id="bl-diff-actions-menu" class="bl-diff-actions-menu" hidden>
                                <button id="bl-diff-related-mode-toggle" type="button" class="bl-diff-actions-item" title="点击差异文本后推测相关规则">
                                    <i id="bl-diff-related-mode-icon" class="fa-solid fa-crosshairs"></i>
                                    <span id="bl-diff-related-mode-text">相关规则：关闭</span>
                                </button>
                                <button id="bl-diff-menu-pos-toggle" type="button" class="bl-diff-actions-item" title="将顶部按钮收纳进菜单">
                                    <i id="bl-diff-menu-pos-icon" class="fa-solid fa-ellipsis"></i>
                                    <span id="bl-diff-menu-pos-text">顶部按钮：收纳</span>
                                </button>
                                <button id="bl-diff-menu-bottom-toggle" type="button" class="bl-diff-actions-item" title="隐藏消息尾部按钮">
                                    <i id="bl-diff-menu-bottom-icon" class="fa-solid fa-eye-slash"></i>
                                    <span id="bl-diff-menu-bottom-text">尾部按钮：隐藏</span>
                                </button>
                            </div>
                        </div>
                        <button id="bl-diff-modal-close" type="button" class="bl-diff-modal-close" aria-label="关闭">&times;</button>
                    </div>
                </div>
                <div id="bl-diff-modal-content" class="bl-diff-modal-content"></div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-diff-related-modal" class="bl-modal-shell">
            <div class="bl-modal-card bl-diff-related-card">
                <div class="bl-diff-related-modal-header">
                    <h3 class="bl-edit-modal-title bl-diff-related-title"><i class="fa-solid fa-crosshairs"></i> 可能相关规则</h3>
                    <button id="bl-diff-related-close" type="button" class="bl-icon-btn" title="关闭"><i class="fas fa-times"></i></button>
                </div>
                <div id="bl-diff-related-body" class="bl-diff-related-body"></div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-subrule-edit-modal" class="bl-modal-shell" style="z-index: 10000005;">
            <div class="bl-modal-card bl-edit-modal-card bl-subrule-modal-card" style="padding: 20px !important;">
                <div class="bl-subrule-modal-header">
                    <div class="bl-subrule-mode-block">
                        <div class="bl-subrule-mode-select-wrap">
                            <select id="bl-modal-sub-mode" class="bl-input bl-subrule-mode-select">
                                <option value="simple">🧩 简易组合</option>
                                <option value="text">📝 普通文本</option>
                                <option value="regex">⚙️ 正则表达式</option>
                            </select>
                            <i class="fas fa-chevron-down bl-subrule-mode-arrow"></i>
                        </div>
                        <div id="bl-modal-sub-mode-hint" class="bl-subrule-mode-hint" aria-live="polite"></div>
                    </div>
                    <button id="bl-modal-sub-cancel" type="button" class="bl-icon-btn bl-subrule-close-btn" title="关闭"><i class="fas fa-times"></i></button>
                </div>
                
                <div class="bl-subrule-modal-body">
                    <div class="bl-subrule-field" style="margin-bottom: 12px;">
                        <label class="bl-field-label" style="margin-bottom: 6px; font-weight: 600;">备注说明 (可选)</label>
                        <input type="text" id="bl-modal-sub-remark" class="bl-input" placeholder="例如：处理特定角色的口头禅" style="background: var(--bl-bg-button) !important; border: none !important; border-radius: 8px !important; font-size: 14px !important; padding: 10px 14px !important;">
                    </div>
                    
                    <div class="bl-subrule-field" style="margin-bottom: 12px;">
                        <label class="bl-field-label" style="margin-bottom: 6px; font-weight: 600;">查找内容</label>
                        <div id="bl-modal-sub-target-error" class="bl-field-error" aria-live="polite"></div>
                        <textarea id="bl-modal-sub-target" class="bl-textarea" rows="4" style="background: var(--bl-bg-button) !important; border: none !important; border-radius: 8px !important; font-size: 14px !important; padding: 10px 14px !important;"></textarea>
                    </div>
                    
                    <div class="bl-subrule-field" style="margin-bottom: 15px;">
                        <div class="bl-subrule-replacement-head">
                            <label class="bl-field-label" style="margin-bottom: 0; font-weight: 600;">替换为</label>
                            <div id="bl-modal-sub-regex-actions" class="bl-regex-replacement-actions" hidden>
                                <button id="bl-modal-sub-regex-recognize" type="button" class="bl-subrule-mini-btn">按行识别</button>
                            </div>
                        </div>
                        <textarea id="bl-modal-sub-rep" class="bl-textarea" rows="4" style="background: var(--bl-bg-button) !important; border: none !important; border-radius: 8px !important; font-size: 14px !important; padding: 10px 14px !important;"></textarea>
                        <div id="bl-modal-sub-regex-list" class="bl-regex-replacement-list" hidden></div>
                    </div>
                </div>
                
                <div class="bl-subrule-footer">
                    <button id="bl-modal-sub-save" type="button" class="bl-primary-btn bl-subrule-footer-save">保存条目</button>
                </div>
            </div>
        </div>
    `);

    markRulesUiDirty(true);
    markPresetsUiDirty(true);
    annotateTauriMobileSurfaces();
} 

export function clearRuleSearchEditFlow() {
    runtimeState.searchEditFlow.active = false;
    runtimeState.searchEditFlow.returnMode = '';
    runtimeState.searchEditFlow.ruleIndex = -1;
    runtimeState.searchEditFlow.subRuleIndex = -1;
}

export function resetRuleSearchState() {
    runtimeState.ruleSearchKeyword = '';
    runtimeState.ruleSearchDraftKeyword = '';
    runtimeState.ruleSearchHasSearched = false;
    runtimeState.ruleSearchExpandedMenuKey = '';
    clearRuleSearchEditFlow();
}

export function syncRuleSearchInputUi(options = {}) {
    const { syncValue = false } = options;
    const draftKeyword = String(runtimeState.ruleSearchDraftKeyword || '');
    const $input = $('#bl-rule-search-input');
    const $clear = $('#bl-rule-search-clear');
    if (syncValue && $input.length) $input.val(draftKeyword);
    const hasValue = draftKeyword.length > 0;
    $clear.prop('hidden', !hasValue).toggleClass('is-visible', hasValue);
}

export function renderRuleSearchModal() {
    const $body = $('#bl-rule-search-body');
    if (!$body.length) return;

    const keyword = String(runtimeState.ruleSearchKeyword || '').trim();
    syncRuleSearchInputUi();

    if (!runtimeState.ruleSearchHasSearched || !keyword) {
        $body.html(`
            <div class="bl-rule-search-empty">
                <div class="bl-rule-search-empty-icon"><i class="fas fa-magnifying-glass"></i></div>
                <div class="bl-rule-search-empty-title">请输入关键词</div>
                <div class="bl-rule-search-empty-text">点击“搜索”查找对应规则</div>
            </div>
        `);
        return;
    }

    const results = buildRuleSearchResults(keyword);
    if (results.length === 0) {
        $body.html(`
            <div class="bl-rule-search-empty">
                <div class="bl-rule-search-empty-icon"><i class="fas fa-circle-info"></i></div>
                <div class="bl-rule-search-empty-title">未找到匹配规则</div>
                <div class="bl-rule-search-empty-text">当前只搜索每条映射的查找词与替换词</div>
            </div>
        `);
        return;
    }

    const html = results.map((item) => {
        const menuHtml = runtimeState.ruleSearchExpandedMenuKey === item.key
            ? `
                <div class="bl-rule-search-menu">
                    <button type="button" class="bl-rule-search-menu-item" data-action="group" data-rule-index="${item.ruleIndex}" data-subrule-index="${item.subRuleIndex}">
                        分组详情
                    </button>
                    <button type="button" class="bl-rule-search-menu-item" data-action="subrule" data-rule-index="${item.ruleIndex}" data-subrule-index="${item.subRuleIndex}">
                        编辑条目
                    </button>
                </div>
            `
            : '';

        return `
            <div class="bl-rule-search-result-card ${item.isEnabled ? '' : 'bl-is-disabled'}" data-rule-index="${item.ruleIndex}" data-subrule-index="${item.subRuleIndex}">
                <div class="bl-rule-search-result-head">
                    <div class="bl-rule-search-result-group">
                        <i class="fas fa-folder-open"></i>
                        所属分组：${item.groupName}
                    </div>
                    <div class="bl-rule-search-menu-wrap">
                        <button type="button" class="bl-icon-btn bl-rule-search-menu-toggle" data-key="${item.key}" title="更多操作">
                            <i class="fas fa-ellipsis"></i>
                        </button>
                        ${menuHtml}
                    </div>
                </div>
                <div class="bl-rule-search-result-preview">
                    <span class="bl-tag">${item.tagText}</span>
                    <span class="bl-source">${item.sourcePreview}</span>
                    <i class="fas fa-arrow-right bl-arrow"></i>
                    <span class="bl-target">${item.replacementPreview}</span>
                </div>
            </div>
        `;
    }).join('');

    $body.html(`<div class="bl-rule-search-results">${html}</div>`);
}

export function openRuleSearchModal() {
    syncRuleSearchInputUi({ syncValue: true });
    renderRuleSearchModal();
    $('#bl-rule-search-modal').css('display', 'flex').hide().fadeIn(150);
    window.setTimeout(() => {
        $('#bl-rule-search-input').trigger('focus');
    }, 20);
}

export function closeRuleSearchModal(options = {}) {
    const { reset = false } = options;
    if (reset) {
        resetRuleSearchState();
        syncRuleSearchInputUi({ syncValue: true });
        renderRuleSearchModal();
    }
    $('#bl-rule-search-modal').fadeOut(150);
}

function getScopeTagGroupsForSettings(settings = {}) {
    return normalizeScopeTagGroupList(settings?.scopeTagGroups);
}

function getScopeTagCollapsedGroupSet(settings = {}, groups = []) {
    return new Set(normalizeScopeTagCollapsedGroupList(settings?.scopeTagCollapsedGroups, groups));
}

function getScopeTagDisplayGroupId(scopeTag, groupIds) {
    const groupId = String(scopeTag?.groupId || DEFAULT_SCOPE_TAG_GROUP_ID).trim() || DEFAULT_SCOPE_TAG_GROUP_ID;
    return groupIds.has(groupId) ? groupId : DEFAULT_SCOPE_TAG_GROUP_ID;
}

function buildScopeTagChipHtml(scopeTag, editId) {
    const isEnabled = scopeTag.enabled !== false;
    const checkedAttr = isEnabled ? 'checked' : '';
    const activeClass = scopeTag.id === editId ? 'is-active' : '';
    const disabledClass = isEnabled ? '' : 'bl-is-disabled';
    const labelText = String(scopeTag.label || '').trim();
    const rangeText = isCotScopeTagEntry(scopeTag)
        ? COT_SCOPE_TAG_DISPLAY_TEXT
        : `${scopeTag.startTag} ... ${scopeTag.endTag}`;
    const primaryText = labelText || '标签范围';
    const chipTitle = `${primaryText} · ${rangeText}`;
    return `
        <div class="bl-scope-tag-chip ${activeClass} ${disabledClass}" data-id="${safeHtml(scopeTag.id)}">
            <label class="bl-checkbox-label bl-scope-tag-toggle-wrap" title="启用或停用该标签">
                <input type="checkbox" class="bl-scope-tag-toggle" data-id="${safeHtml(scopeTag.id)}" ${checkedAttr}>
                <span class="bl-custom-checkbox bl-square"></span>
            </label>
            <button type="button" class="bl-scope-tag-chip-main" data-id="${safeHtml(scopeTag.id)}" title="${safeHtml(chipTitle)}">
                <span class="bl-scope-tag-chip-title">${safeHtml(primaryText)}</span>
                <span class="bl-scope-tag-chip-text">${safeHtml(rangeText)}</span>
            </button>
            <span class="bl-scope-tag-row-divider" aria-hidden="true"></span>
            <div class="bl-scope-tag-actions">
                <button type="button" class="bl-icon-btn bl-scope-tag-move" title="保持当前顺序" aria-label="保持当前顺序" disabled><i class="fas fa-arrow-up"></i></button>
                <button type="button" class="bl-icon-btn bl-scope-tag-move" title="保持当前顺序" aria-label="保持当前顺序" disabled><i class="fas fa-arrow-down"></i></button>
                <button type="button" class="bl-icon-btn bl-scope-tag-edit" data-id="${safeHtml(scopeTag.id)}" title="编辑标签" aria-label="编辑标签"><i class="fas fa-pen"></i></button>
                <button type="button" class="bl-icon-btn bl-scope-tag-del bl-danger-btn" data-id="${safeHtml(scopeTag.id)}" title="删除标签" aria-label="删除标签"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `;
}

export function renderScopeTagsModal() {
    const $list = $('#bl-scope-tags-list');
    if (!$list.length) return;

    const { extension_settings } = getAppContext();
    const settings = extension_settings?.[extensionName] || {};
    const groups = getScopeTagGroupsForSettings(settings);
    const groupIds = new Set(groups.map((group) => group.id));
    const collapsedGroups = getScopeTagCollapsedGroupSet(settings, groups);
    const scopeTags = mergeScopeTagsWithBuiltins(
        settings.scopeTags,
        settings.scopeTagBuiltinDismissed
    );
    const editId = String($('#bl-scope-tag-input').data('scope-edit-id') || '');
    const isEditing = editId !== '';
    const scopeTagMode = settings.scopeTagMode === 'cleanse-inside' ? 'cleanse-inside' : 'protect';
    const isCleanseInsideMode = scopeTagMode === 'cleanse-inside';
    const displayScopeTags = [];
    let cotDisplayTag = null;

    scopeTags.forEach((scopeTag) => {
        if (!isCotScopeTagEntry(scopeTag)) {
            displayScopeTags.push(scopeTag);
            return;
        }
        if (!cotDisplayTag) {
            cotDisplayTag = {
                ...scopeTag,
                label: scopeTag.label || 'COT思维链',
                enabled: false,
                groupId: getScopeTagDisplayGroupId(scopeTag, groupIds),
            };
            displayScopeTags.push(cotDisplayTag);
        }
        if (scopeTag.enabled !== false) cotDisplayTag.enabled = true;
        if (scopeTag.id === editId) cotDisplayTag.id = scopeTag.id;
    });

    $('#bl-scope-tag-editor-title').text(isEditing ? '编辑标签' : '新增标签');
    $('#bl-scope-tag-save').text('确认');
    $('#bl-scope-tag-reset').text('取消');
    $('#bl-scope-mode-protect')
        .toggleClass('is-active', !isCleanseInsideMode)
        .attr('aria-pressed', String(!isCleanseInsideMode));
    $('#bl-scope-mode-cleanse')
        .toggleClass('is-active', isCleanseInsideMode)
        .attr('aria-pressed', String(isCleanseInsideMode));
    $('#bl-scope-tags-hint').text(isCleanseInsideMode
        ? '当前模式下，只会删除或替换列表内标签的内容，标签外内容会被保留。'
        : '当前模式下，会保护列表内标签的内容，标签外内容将被删除或替换。');

    const grouped = groups.map((group) => ({ ...group, tags: [] }));
    const groupedMap = new Map(grouped.map((group) => [group.id, group]));
    displayScopeTags.forEach((scopeTag) => {
        const groupId = getScopeTagDisplayGroupId(scopeTag, groupIds);
        const targetGroup = groupedMap.get(groupId) || groupedMap.get(DEFAULT_SCOPE_TAG_GROUP_ID) || grouped[0];
        if (targetGroup) targetGroup.tags.push(scopeTag);
    });

    const html = grouped.map((group) => {
        const isCollapsed = collapsedGroups.has(group.id);
        const groupTitle = safeHtml(group.name || DEFAULT_SCOPE_TAG_GROUP_NAME);
        const activeCount = group.tags.filter((scopeTag) => scopeTag.enabled !== false).length;
        const hasTags = group.tags.length > 0;
        const isGroupEnabled = activeCount > 0;
        const isGroupPartial = activeCount > 0 && activeCount < group.tags.length;
        const groupToggleClass = [
            'bl-scope-tag-group-toggle',
            isGroupEnabled ? 'is-on' : '',
            isGroupPartial ? 'is-partial' : '',
        ].filter(Boolean).join(' ');
        const groupToggleTitle = hasTags
            ? (isGroupEnabled ? '关闭该分组内全部标签' : '启用该分组内全部标签')
            : '此分组暂无标签';
        const groupToggleDisabled = hasTags ? '' : 'disabled';
        const tagsHtml = group.tags.length > 0
            ? group.tags.map((scopeTag) => buildScopeTagChipHtml(scopeTag, editId)).join('')
            : `<div class="bl-scope-tag-group-empty">${isCleanseInsideMode ? '此分组暂无标签。' : '此分组暂无标签。'}</div>`;
        return `
            <div class="bl-scope-tag-group ${isCollapsed ? 'is-collapsed' : ''}" data-group-id="${safeHtml(group.id)}">
                <div class="bl-scope-tag-group-head">
                    <button type="button" class="bl-scope-tag-group-collapse" data-group-id="${safeHtml(group.id)}" aria-expanded="${String(!isCollapsed)}">
                        <svg class="bl-scope-tag-group-caret" viewBox="0 0 24 24" aria-hidden="true">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                        <span class="bl-scope-tag-group-title">${groupTitle}</span>
                    </button>
                    <span class="bl-scope-tag-group-count">${group.tags.length}</span>
                    <button type="button" class="${groupToggleClass}" data-group-id="${safeHtml(group.id)}" aria-pressed="${String(isGroupEnabled)}" title="${safeHtml(groupToggleTitle)}" ${groupToggleDisabled}>
                        <span class="bl-scope-tag-group-toggle-track" aria-hidden="true">
                            <span class="bl-scope-tag-group-toggle-knob"></span>
                        </span>
                    </button>
                </div>
                <div class="bl-scope-tag-group-body">
                    <div class="bl-scope-tag-group-inner">
                        ${tagsHtml}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    $list.html(html || `<div class="bl-empty-state">${isCleanseInsideMode ? '当前没有标签，新增并启用后才会净化标签内内容。' : '当前没有标签，新增后即可保护对应标签内容。'}</div>`);
}

export function openScopeTagsModal() {
    renderScopeTagsModal();
    $('#bl-scope-tags-modal')
        .stop(true, true)
        .css('display', 'flex')
        .hide()
        .fadeIn(150, function() {
            $(this).css('display', 'flex');
        });
}

export function closeScopeTagsModal(options = {}) {
    const { reset = false } = options;
    if (reset) {
        $('#bl-scope-tag-input').val('').data('scope-edit-id', '');
        $('#bl-scope-tag-label-input').val('');
        $('#bl-scope-tag-error').removeClass('is-visible').text('');
        $('#bl-scope-tag-input').removeClass('bl-invalid').removeAttr('aria-invalid');
        $('#bl-scope-tag-editor-modal').prop('hidden', true);
        $('#bl-scope-group-manager-modal').prop('hidden', true);
        $('#bl-scope-tag-action-menu').prop('hidden', true);
        $('#bl-scope-tag-menu-open').attr('aria-expanded', 'false');
        renderScopeTagsModal();
    }
    $('#bl-scope-tags-modal').fadeOut(150);
}

export function focusLatestRuleCard() {
    const container = document.getElementById('bl-tags-container');
    if (!container) return;

    const cards = container.querySelectorAll('.bl-card');
    const latestCard = cards[cards.length - 1];
    if (!latestCard) return;

    const containerRect = container.getBoundingClientRect();
    const cardRect = latestCard.getBoundingClientRect();
    const isVisible = cardRect.top >= containerRect.top && cardRect.bottom <= containerRect.bottom;

    if (!isVisible) {
        latestCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    latestCard.classList.remove('bl-highlight-flash');
    void latestCard.offsetWidth;
    latestCard.classList.add('bl-highlight-flash');

    window.setTimeout(() => {
        latestCard.classList.remove('bl-highlight-flash');
    }, 1600);
}

function showProgressOverlay({ title, statusText, cancelText = '停止', onCancel = null }) {
    const themeMode = String($('#bl-purifier-popup').attr('data-bl-theme') || 'auto');
    $('#bl-loading-overlay').remove();
    $('body').append(`
        <div id="bl-loading-overlay" class="bl-loading-overlay" data-bl-theme="${themeMode}" data-tt-mobile-surface="backdrop">
            <div class="bl-loading-panel" data-tt-mobile-surface="fullscreen-window" role="dialog" aria-modal="true" aria-labelledby="bl-loading-title">
                <div class="bl-loading-head">
                    <h2 id="bl-loading-title" class="bl-loading-title"><i class="fas fa-spinner fa-spin"></i> ${title}</h2>
                    <button id="bl-loading-cancel" type="button" class="bl-loading-cancel" title="${cancelText}">${cancelText}</button>
                </div>
                <p id="bl-loading-status">${statusText}</p>
                <div class="bl-progress-track"><div id="bl-progress-fill" class="bl-progress-fill"></div></div>
                <p id="bl-progress-percent" class="bl-progress-percent">0%</p>
            </div>
        </div>
    `);
    annotateTauriMobileSurfaces();
    if (typeof onCancel === 'function') {
        $('#bl-loading-cancel').off('click').on('click', onCancel);
    }
}

export function showDeepCleanOverlay() {
    runtimeState.deepCleanCancelRequested = false;
    showProgressOverlay({
        title: '正在执行全方位深度清理',
        statusText: '正在初始化清理任务，请稍候。',
        cancelText: '停止',
        onCancel: () => {
            runtimeState.deepCleanCancelRequested = true;
            $('#bl-loading-cancel')
                .prop('disabled', true)
                .addClass('is-disabled')
                .text('停止中');
            $('#bl-loading-status').text('正在停止深度清理，请等待当前批次收尾。');
        },
    });
}

export function showZhDictionaryInstallOverlay(onCancel) {
    runtimeState.zhDictionaryInstallCancelRequested = false;
    showProgressOverlay({
        title: '正在安装增强简繁词典',
        statusText: '正在初始化下载任务。',
        cancelText: '取消',
        onCancel: () => {
            runtimeState.zhDictionaryInstallCancelRequested = true;
            $('#bl-loading-cancel')
                .prop('disabled', true)
                .addClass('is-disabled')
                .text('取消中');
            $('#bl-loading-status').text('正在取消下载，请等待当前请求结束。');
            if (typeof onCancel === 'function') onCancel();
        },
    });
}

export function closeLoadingOverlay() {
    $('#bl-loading-overlay').remove();
}

export function updateZhDictionaryInstallOverlay(progressRatio, statusText) {
    updateDeepCleanOverlay(progressRatio, statusText);
}

export function openZhDictionaryModal(stats = {}, options = {}) {
    const themeMode = String($('#bl-purifier-popup').attr('data-bl-theme') || 'auto');
    const bytes = Number(stats.bytes) || 0;
    const mb = bytes > 0 ? (bytes / 1024 / 1024).toFixed(2) : '1.20';
    const entries = Number(stats.entries) || 0;
    $('#bl-zh-dictionary-modal')
        .attr('data-bl-theme', themeMode)
        .css('display', 'flex');
    $('#bl-zh-dict-stats').text(`词典包约 ${mb} MB，包含 ${entries.toLocaleString('zh-CN')} 条字词与异体映射。`);
    $('#bl-zh-dict-tw').prop('checked', options.tw !== false);
    $('#bl-zh-dict-hk').prop('checked', options.hk !== false);
}

export function closeZhDictionaryModal() {
    $('#bl-zh-dictionary-modal').fadeOut(120);
}

export function updateDeepCleanOverlay(progressRatio, statusText) {
    const ratio = Math.max(0, Math.min(1, Number(progressRatio) || 0));
    $('#bl-progress-fill').css('width', `${Math.round(ratio * 100)}%`);
    $('#bl-progress-percent').text(`${Math.round(ratio * 100)}%`);
    if (statusText) $('#bl-loading-status').text(statusText);
}

export function showConfirmModal(onConfirm = () => performDeepCleanse()) {
    const $modal = $('#bl-confirm-modal');
    const $confirmBtn = $('#bl-modal-confirm');
    const $cancelBtn = $('#bl-modal-cancel');

    $modal.css('display', 'flex');
    $confirmBtn.prop('disabled', true).addClass('bl-is-disabled');

    let timeLeft = 3;
    $confirmBtn.text(`确认清理 (${timeLeft}s)`);

    const timer = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            $confirmBtn.text(`确认清理 (${timeLeft}s)`);
        } else {
            clearInterval(timer);
            $confirmBtn.prop('disabled', false)
                .removeClass('bl-is-disabled')
                .text('我已切换，确认清理！');
        }
    }, 1000);

    $cancelBtn.off('click').on('click', () => {
        clearInterval(timer);
        $modal.hide();
    });

    $confirmBtn.off('click').on('click', () => {
        if (!timeLeft) {
            clearInterval(timer);
            $modal.hide();
            onConfirm();
        }
    });
}

export function applyPresetByName(name, options = {}) {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const presetName = String(name || '');
    const presetExists = !!(presetName && settings.presets?.[presetName]);
    settings.activePreset = presetExists ? presetName : "";
    settings.rules = presetExists ? deepClone(settings.presets[presetName]) : [];
    markRulesDataDirty();
    saveSettingsDebounced();
    logger.info(`切换预设: ${presetName || '(临时规则)'}, 存在=${presetExists}`);
    if (!options.skipRender) {
        updateToolbarUI();
        renderTags();
    }
    if (!options.skipCleanse) performGlobalCleanse();
}

export function cleanupInvalidPresetBindings() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const presets = settings.presets || {};
    if (settings.defaultPreset && !presets[settings.defaultPreset]) settings.defaultPreset = "";
    if (!settings.characterBindings || typeof settings.characterBindings !== 'object') {
        settings.characterBindings = {};
    }
    if (!settings.chatCompletionPresetBindings || typeof settings.chatCompletionPresetBindings !== 'object') settings.chatCompletionPresetBindings = {};

    Object.keys(settings.characterBindings).forEach((key) => {
        const preset = settings.characterBindings[key];
        if (!preset || !presets[preset]) delete settings.characterBindings[key];
    });
    Object.keys(settings.chatCompletionPresetBindings).forEach((name) => {
        const preset = settings.chatCompletionPresetBindings[name];
        if (!preset || !presets[preset]) delete settings.chatCompletionPresetBindings[name];
    });
}

function formatBindingList(names = []) {
    if (!names.length) return '';
    const shown = names.slice(0, 2).join('、');
    return names.length > 2 ? `${shown} 等 ${names.length} 个` : shown;
}

export function refreshCharacterBindingUI() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const context = getCurrentCharacterContext();
    const activePreset = String(settings.activePreset || '');
    const chatCompletionPresetName = getCurrentChatCompletionPresetName();
    const bindingResolution = getPresetBindingResolution(context.key, { chatCompletionPresetName });
    const $defaultBtn = $('#bl-default-toggle');
    const $bindBtn = $('#bl-character-bind-toggle');
    const $bindCurrentItem = $('#bl-bind-current-character');
    const $bindChatPresetItem = $('#bl-bind-current-chat-preset');
    const $unbindItem = $('#bl-unbind-current-character');
    const currentBound = context.key ? (settings.characterBindings?.[context.key] || '') : '';
    const currentChatBound = chatCompletionPresetName ? (settings.chatCompletionPresetBindings?.[chatCompletionPresetName] || '') : '';
    const activeUsage = getPresetBindingUsage(activePreset);

    if ($defaultBtn.length && $bindBtn.length) {
        const isDefaultActive = !!(activePreset && settings.defaultPreset === activePreset);
        $defaultBtn.toggleClass('bl-bind-active', isDefaultActive);
        $defaultBtn.prop('disabled', !activePreset);
        $defaultBtn.attr('aria-pressed', String(isDefaultActive));
        $defaultBtn.attr('title', activePreset ? (isDefaultActive ? `已设为全局默认：${activePreset}（点击取消）` : `将当前净化预设设为全局默认：${activePreset}`) : '请先选择一个净化预设');

        const isCharacterBound = !!(context.key && activePreset && currentBound === activePreset);
        const isChatPresetBound = !!(chatCompletionPresetName && activePreset && currentChatBound === activePreset);
        const hasCurrentBinding = !!((context.key && currentBound) || (chatCompletionPresetName && currentChatBound));
        const roleBindingWillSwitchFromChatPreset = !!(activePreset && activeUsage.hasChatCompletionPresetBindings && !isCharacterBound);
        const chatPresetBindingWillSwitchFromRole = !!(activePreset && activeUsage.hasCharacterBindings && !isChatPresetBound);
        $bindBtn.toggleClass('bl-bind-active', hasCurrentBinding);
        $bindBtn.prop('disabled', false);
        $bindBtn.attr('aria-pressed', String(hasCurrentBinding));
        $bindBtn.find('i').removeClass('fa-link-slash').addClass('fa-link');
        $bindBtn.attr('title', !context.key
            ? (currentChatBound ? `绑定管理：当前对话预设已绑定 ${currentChatBound}` : '绑定管理：未检测到当前角色')
            : currentBound
                ? `绑定管理：${context.name} 已绑定 ${currentBound}`
                : currentChatBound
                    ? `绑定管理：对话预设 ${chatCompletionPresetName} 已绑定 ${currentChatBound}`
                    : `绑定管理：当前跟随${bindingResolution.source === 'default' ? '全局默认' : '未绑定状态'}`);

        $bindCurrentItem
            .prop('disabled', !activePreset || !context.key || isCharacterBound)
            .toggleClass('is-active', isCharacterBound);
        $bindCurrentItem.find('.bl-bind-menu-label').text(isCharacterBound ? '已绑定当前角色' : '绑定当前角色');
        $bindCurrentItem.find('.bl-bind-menu-note').text(!activePreset
            ? '请先选择净化预设'
            : !context.key
                ? '未检测到角色'
                : roleBindingWillSwitchFromChatPreset
                    ? `切换为角色绑定，会移除：${formatBindingList(activeUsage.chatCompletionPresetNames)}`
                    : currentBound && currentBound !== activePreset
                        ? `当前角色已绑定 ${currentBound}，点击改绑`
                        : `使用净化预设：${activePreset}`);

        $bindChatPresetItem
            .prop('disabled', !activePreset || !chatCompletionPresetName || isChatPresetBound)
            .toggleClass('is-active', isChatPresetBound);
        $bindChatPresetItem.find('.bl-bind-menu-label').text(isChatPresetBound ? '已绑定当前对话补全预设' : '绑定当前对话补全预设');
        $bindChatPresetItem.find('.bl-bind-menu-note').text(!activePreset
            ? '请先选择净化预设'
            : !chatCompletionPresetName
                ? '未检测到 ST 对话补全预设'
                : chatPresetBindingWillSwitchFromRole
                    ? `切换为对话补全预设绑定，会移除角色绑定：${activeUsage.characterKeys.length} 个`
                    : currentChatBound && currentChatBound !== activePreset
                        ? `当前对话预设已绑定 ${currentChatBound}，点击改绑`
                        : `跟随对话预设：${chatCompletionPresetName}`);

        $unbindItem
            .prop('disabled', !currentBound && !currentChatBound)
            .toggleClass('is-active', !!(currentBound || currentChatBound));
        $unbindItem.find('.bl-bind-menu-label').text(currentBound ? '取消角色绑定' : currentChatBound ? '取消对话预设绑定' : '取消当前绑定');
        $unbindItem.find('.bl-bind-menu-note').text(currentBound
            ? `当前角色：${currentBound}`
            : currentChatBound
                ? `当前对话预设：${currentChatBound}`
                : '当前没有绑定');
    }
}

export function applyCharacterPresetBinding(force = false, options = {}) {
    const { extension_settings } = getAppContext();
    const context = getCurrentCharacterContext();
    const chatCompletionPresetName = getCurrentChatCompletionPresetName();
    const bindingSignature = `${context.key || ''}\n${chatCompletionPresetName || ''}`;
    const bindingContextChanged = bindingSignature !== runtimeState.lastPresetBindingSignature;
    if (!force && !bindingContextChanged) return;
    runtimeState.lastCharacterContextKey = context.key;
    runtimeState.lastPresetBindingSignature = bindingSignature;

    const presetName = getPresetForCharacter(context.key, { chatCompletionPresetName });
    if (presetName && presetName !== extension_settings[extensionName].activePreset) {
        applyPresetByName(presetName, { skipRender: true, skipCleanse: options.skipCleanse === true });
    }
    refreshCharacterBindingUI();
}

export function updateToolbarUI() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    cleanupInvalidPresetBindings();
    const select = $('#bl-preset-select');
    if (!select.length) return;

    if (runtimeState.presetsUiDirty || select.children().length === 0) {
        const presetNames = settings.presets ? Object.keys(settings.presets) : [];
        const optionsHtml = ['<option value="">-- 临时规则 (未绑定存档) --</option>']
            .concat(presetNames.map((name) => `<option value="${safeHtml(name)}">${safeHtml(name)}</option>`))
            .join('');
        select.html(optionsHtml);
        markPresetsUiDirty(false);
    }
    select.val(settings.activePreset || "");
    refreshCharacterBindingUI();
}

export function addRegexReplacementInput(value = '') {
    return appendRegexReplacementInputs([value]).eq(0);
}

export function removeRegexReplacementInput(index) {
    const normalizedIndex = Number(index);
    const $items = $('#bl-modal-sub-regex-list').children('.bl-regex-replacement-chip');
    if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0 || normalizedIndex >= $items.length) return;
    const currentEditIndex = getRegexReplacementEditIndex();
    $items.eq(normalizedIndex).remove();
    if (currentEditIndex === normalizedIndex) {
        $('#bl-modal-sub-rep').data('regex-edit-index', -1);
    } else if (currentEditIndex > normalizedIndex) {
        $('#bl-modal-sub-rep').data('regex-edit-index', currentEditIndex - 1);
    }
    syncRegexReplacementInputState();
}

export function startEditingRegexReplacementInput(index) {
    const normalizedIndex = Number(index);
    const values = getRegexReplacementChipValues();
    if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0 || normalizedIndex >= values.length) return false;
    $('#bl-modal-sub-rep').val(values[normalizedIndex]).data('regex-edit-index', normalizedIndex);
    syncRegexReplacementInputState();
    return true;
}

export function recognizeRegexReplacementInput() {
    const $textarea = $('#bl-modal-sub-rep');
    const draft = String($textarea.val() ?? '');
    if (draft.trim() === '') return { ok: false, reason: 'empty' };

    const editIndex = getRegexReplacementEditIndex();
    const $items = $('#bl-modal-sub-regex-list').children('.bl-regex-replacement-chip');
    if (editIndex >= 0 && editIndex < $items.length) {
        const $item = $items.eq(editIndex);
        $item.data('value', draft);
        $item.find('.bl-regex-replacement-chip-main')
            .html(formatReplacementCandidatePreview(draft))
            .attr('title', draft || '点击编辑替换项');
        $textarea.val('').data('regex-edit-index', -1);
        syncRegexReplacementInputState();
        return { ok: true, mode: 'update' };
    }

    const lines = draft.replace(/\r/g, '').split('\n').map((line) => (line.trim() === '' ? '' : line));
    if (lines.length === 0) return { ok: false, reason: 'empty' };
    appendRegexReplacementInputs(lines, { sync: false });
    $textarea.val('').data('regex-edit-index', -1);
    syncRegexReplacementInputState();
    return { ok: true, mode: 'append', count: lines.length };
}

export function hasPendingRegexReplacementInput() {
    const draft = String($('#bl-modal-sub-rep').val() ?? '');
    if (draft.trim() === '') return false;
    const editIndex = getRegexReplacementEditIndex();
    const values = getRegexReplacementChipValues();
    return editIndex < 0 || editIndex >= values.length || draft !== values[editIndex];
}

export function setSingleRuleReplacementEditor(mode, replacements = []) {
    const normalized = normalizeReplacementList(replacements);
    const isRegexMode = mode === 'regex';
    const $textarea = $('#bl-modal-sub-rep');
    const $actions = $('#bl-modal-sub-regex-actions');
    const $list = $('#bl-modal-sub-regex-list');
    $textarea.data('regex-edit-index', -1);

    if (isRegexMode) {
        $textarea.val('');
        $list.empty();
        appendRegexReplacementInputs(normalized, { sync: false });
        $actions.prop('hidden', false);
        syncRegexReplacementInputState();
        return;
    }

    $list.empty().prop('hidden', true);
    $actions.prop('hidden', true);
    $textarea
        .val(normalized.join(mode === 'text' ? ', ' : '\n'))
        .removeData('regex-default-placeholder')
        .removeData('regex-edit-placeholder');
}

export function getSingleRuleReplacementValues(mode) {
    if (mode === 'regex') {
        return getRegexReplacementChipValues();
    }

    const rawValue = String($('#bl-modal-sub-rep').val() ?? '');
    return parseInputToWords(rawValue, mode === 'text' ? 'text' : 'regex', { isTarget: false });
}

export function renderTags() {
    const container = $('#bl-tags-container');
    if (!container.length) return;
    if (!runtimeState.rulesUiDirty && container.children().length > 0) return;

    const { extension_settings } = getAppContext();
    const rules = extension_settings[extensionName]?.rules || [];
    const html = rules.map((r, i) => {
        const name = safeHtml(r.name) || `未命名合集 ${i + 1}`;
        const subRules = r.subRules || [];
        const maxPreview = 3;

        const subRulesHtml = subRules.slice(0, maxPreview).map((sub) => {
            const mode = sub.mode || 'text';
            const tagText = getRulePreviewTagText(mode);
            const tPreview = getRuleSourcePreviewText(sub);
            const rPreview = formatReplacementPreview(sub.replacements || [], mode);
            const subEnabled = sub.enabled !== false;
            return `
                <div class="bl-rule-item ${subEnabled ? '' : 'bl-is-disabled'}">
                    <span class="bl-tag">${tagText}</span>
                    <span class="bl-source">${tPreview}</span>
                    <i class="fas fa-arrow-right bl-arrow"></i>
                    <span class="bl-target">${rPreview}</span>
                </div>`;
        }).join('');

        const moreHtml = subRules.length > maxPreview
            ? `<div class="bl-more-text">... 以及其他 ${subRules.length - maxPreview} 组映射</div>`
            : '';
        const bodyHtml = subRules.length > 0
            ? `<div class="bl-card-body">${subRulesHtml}${moreHtml}</div>`
            : '';

        const isEnabled = r.enabled !== false;
        const checkedAttr = isEnabled ? 'checked' : '';
        const moveUpDisabled = i === 0 ? 'disabled' : '';
        const moveDownDisabled = i === rules.length - 1 ? 'disabled' : '';
        const headerClass = subRules.length > 0 ? 'bl-card-header bl-has-border' : 'bl-card-header';

        return `
            <div class="bl-card ${!isEnabled ? 'bl-is-disabled' : ''}" data-index="${i}">
                <div class="${headerClass}">
                    <div class="bl-header-left">
                        <label class="bl-batch-checkbox-label">
                            <input type="checkbox" class="batch-item-checkbox" data-index="${i}">
                            <span class="bl-custom-checkbox bl-square-2px"></span>
                        </label>
                        <label class="bl-checkbox-label">
                            <input type="checkbox" class="bl-rule-toggle" data-index="${i}" ${checkedAttr}>
                            <span class="bl-custom-checkbox"></span>
                            <span class="bl-group-title">${name}</span>
                        </label>
                    </div>
                    <div class="bl-icon-group bl-compact">
                        <button class="bl-rule-move-up" data-index="${i}" title="上移合集" ${moveUpDisabled}><i class="fas fa-arrow-up"></i></button>
                        <button class="bl-rule-move-down" data-index="${i}" title="下移合集" ${moveDownDisabled}><i class="fas fa-arrow-down"></i></button>
                        <button class="bl-rule-transfer" data-index="${i}" title="复制/转移到其他存档"><i class="fas fa-copy"></i></button>
                        <button class="bl-rule-edit" data-index="${i}" title="编辑合集"><i class="fas fa-pen"></i></button>
                        <button class="bl-rule-del" data-index="${i}" title="删除合集"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
                ${bodyHtml}
            </div>`;
    }).join('');

    container.html(html || '<div class="bl-empty-state">当前无规则，请点击上方按钮新增</div>');
    markRulesUiDirty(false);
}

export function renderSubrulesToModal() {
    const container = $('#bl-edit-subrules-container');
    if (!container.length) return;
    if (runtimeState.currentEditingSubrules.length === 0) {
        container.html('<div style="text-align:center; color:var(--bl-text-secondary); font-size:12px; padding:20px;">当前合集没有映射规则，请点击下方按钮添加。</div>');
        return;
    }

    const html = runtimeState.currentEditingSubrules.map((sub, i) => {
        const mode = sub.mode || 'text';
        const remark = sub.remark ? sub.remark.trim() : '';
        const subEnabled = sub.enabled !== false;
        const checkedAttr = subEnabled ? 'checked' : '';
        const moveUpDisabled = i === 0 ? 'disabled' : '';
        const moveDownDisabled = i === runtimeState.currentEditingSubrules.length - 1 ? 'disabled' : '';

        const badgeBaseStyle = "display:inline-flex; align-items:center; justify-content:center; padding:4px 10px; border-radius:6px; font-size:13px; font-weight:800; color:#fff; min-width:45px; margin:0; line-height:1; flex-shrink:0;";
        let badgeHTML = '';
        if (mode === 'regex') badgeHTML = `<span style="${badgeBaseStyle} background:var(--bl-accent-color);">正则</span>`;
        else if (mode === 'simple') badgeHTML = `<span style="${badgeBaseStyle} background:color-mix(in srgb, var(--bl-accent-color) 72%, #3b82f6 28%);">简易</span>`;
        else badgeHTML = `<span style="${badgeBaseStyle} background:var(--bl-text-secondary); color:var(--bl-background-popup);">普通</span>`;

        const tPreview = getRuleSourcePreviewText(sub);
        const rPreview = formatReplacementPreview(sub.replacements || [], mode);

        let remarkHTML = '';
        if (remark) {
            remarkHTML = `
                <div style="margin-top: 8px; padding-top: 10px; border-top: 1px dotted color-mix(in srgb, var(--bl-text-primary) 35%, rgba(128,128,128,0.5)); font-size: 11px; color: var(--bl-text-mute); font-style: italic;">
                    <i class="fas fa-info-circle" style="margin-right: 4px;"></i>${safeHtml(remark)}
                </div>
            `;
        }

        return `
            <div class="bl-subrule-card ${subEnabled ? '' : 'bl-is-disabled'}" style="flex-shrink: 0 !important; background: var(--bl-background-secondary); border: 1px solid var(--bl-border-color); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; display: flex; flex-direction: column; box-shadow: 0 4px 10px rgba(0,0,0,0.04);">
                <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px dotted color-mix(in srgb, var(--bl-text-primary) 35%, rgba(128,128,128,0.5));">
                    <div style="display: flex; align-items: center; gap: 8px; margin: 0; padding: 0; min-width: 0;">
                        <label class="bl-checkbox-label bl-subrule-enable-label" title="${subEnabled ? '停用此条规则' : '启用此条规则'}">
                            <input type="checkbox" class="bl-subrule-toggle" data-index="${i}" ${checkedAttr}>
                            <span class="bl-custom-checkbox"></span>
                        </label>
                        ${badgeHTML}
                    </div>
                    <div class="bl-subrule-btn-group" style="display: flex; justify-content: space-between; align-items: center; flex: 0 0 35%; margin: 0; padding: 0;">
                        <button class="bl-move-subrule-up-btn bl-icon-btn" data-index="${i}" title="上移" ${moveUpDisabled} style="margin:0;"><i class="fas fa-arrow-up"></i></button>
                        <button class="bl-move-subrule-down-btn bl-icon-btn" data-index="${i}" title="下移" ${moveDownDisabled} style="margin:0;"><i class="fas fa-arrow-down"></i></button>
                        <button class="bl-edit-subrule-btn bl-icon-btn" data-index="${i}" title="独立编辑" style="margin:0;"><i class="fas fa-pen"></i></button>
                        <button class="bl-del-subrule-btn bl-icon-btn bl-danger-btn" data-index="${i}" title="删除" style="margin:0;"><i class="fas fa-trash"></i></button>
                        <button class="bl-remark-subrule-btn bl-icon-btn" data-index="${i}" title="快捷修改备注" style="margin:0;"><i class="fas fa-comment-dots"></i></button>
                    </div>
                </div>
                <div style="font-size: 13px !important; color: var(--bl-text-primary); line-height: 1.5; word-break: break-all;">
                    <b style="font-size: 13px !important;">${tPreview}</b> 
                    <i class="fas fa-arrow-right" style="color: var(--bl-text-mute); font-size: 11px; margin: 0 6px;"></i> 
                    <span style="font-size: 13px !important;">${rPreview}</span>
                </div>
                ${remarkHTML}
            </div>
        `;
    }).join('');

    container.html(html);
}

export function openSingleRuleModal(index, options = {}) {
    runtimeState.currentSubruleEditIndex = index;
    let mode = 'simple';
    let tStr = '';
    let replacements = [];
    let remark = '';

    if (index >= 0 && runtimeState.currentEditingSubrules[index]) {
        const sub = runtimeState.currentEditingSubrules[index];
        mode = sub.mode || 'simple';
        tStr = (sub.targets || []).join(mode === 'text' ? ', ' : '\n');
        replacements = Array.isArray(sub.replacements) ? sub.replacements : [];
        remark = sub.remark || '';
    }

    $('#bl-modal-sub-mode').val(mode).data('current-mode', mode);
    $('#bl-modal-sub-target').val(tStr);
    setSingleRuleReplacementEditor(mode, replacements);
    $('#bl-modal-sub-remark').val(remark);

    $('#bl-modal-sub-mode').trigger('change');
    if (options.hideEditModal === true) $('#bl-rule-edit-modal').hide();
    $('#bl-subrule-edit-modal').css('display', 'flex').hide().fadeIn(150);
}

export function openTransferModal(ruleIndexOrIndexes) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const presets = settings?.presets || {};
    const currentPreset = settings?.activePreset || "";
    const targetNames = Object.keys(presets).filter(name => name !== currentPreset);
    if (targetNames.length === 0) {
        alert('没有可用的目标存档。请先创建至少一个其他存档。');
        return;
    }

    const indexes = Array.isArray(ruleIndexOrIndexes) ? ruleIndexOrIndexes : [ruleIndexOrIndexes];
    runtimeState.currentTransferRuleIndexes = indexes
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v >= 0);
    runtimeState.currentTransferRuleIndex = runtimeState.currentTransferRuleIndexes[0] ?? -1;
    const $select = $('#bl-transfer-target');
    $select.html(targetNames.map((name) => `<option value="${safeHtml(name)}">${safeHtml(name)}</option>`).join(''));
    $('#bl-rule-transfer-modal').css('display', 'flex');
}

export function closeTransferModal() {
    runtimeState.currentTransferRuleIndex = -1;
    runtimeState.currentTransferRuleIndexes = [];
    $('#bl-rule-transfer-modal').hide();
}

export function runRuleTransfer(isMove) {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const targetPreset = String($('#bl-transfer-target').val() || '');
    const sourcePreset = String(settings.activePreset || '');
    const transferIndexes = Array.isArray(runtimeState.currentTransferRuleIndexes) && runtimeState.currentTransferRuleIndexes.length > 0
        ? runtimeState.currentTransferRuleIndexes
        : [runtimeState.currentTransferRuleIndex];
    const validIndexes = transferIndexes
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v >= 0);
    if (validIndexes.length === 0) return;
    if (!targetPreset) {
        alert('请选择目标存档。');
        return;
    }
    if (targetPreset === sourcePreset) {
        closeTransferModal();
        return;
    }

    const sourceRules = settings.rules || [];
    const uniqueIndexes = [...new Set(validIndexes)].sort((a, b) => a - b).filter((idx) => idx < sourceRules.length);
    if (uniqueIndexes.length === 0) {
        closeTransferModal();
        return;
    }

    if (!Array.isArray(settings.presets[targetPreset])) settings.presets[targetPreset] = [];
    const movingRules = uniqueIndexes.map((idx) => sourceRules[idx]).filter(Boolean);
    movingRules.forEach((rule) => settings.presets[targetPreset].push(JSON.parse(JSON.stringify(rule))));
    if (isMove) {
        for (let i = uniqueIndexes.length - 1; i >= 0; i--) {
            sourceRules.splice(uniqueIndexes[i], 1);
        }
        runtimeState.batchSelectedRuleIds = [];
        markRulesDataDirty();
    }

    closeTransferModal();
    saveSettingsDebounced();
    if (isMove) renderTags();
}

export function openEditModal(index = -1, options = {}) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const { source = 'main', returnMode = 'group', subRuleIndex = -1 } = options;
    runtimeState.currentEditingIndex = index;
    if (source === 'search') {
        runtimeState.searchEditFlow.active = true;
        runtimeState.searchEditFlow.returnMode = returnMode;
        runtimeState.searchEditFlow.ruleIndex = index;
        runtimeState.searchEditFlow.subRuleIndex = subRuleIndex;
    } else {
        clearRuleSearchEditFlow();
    }
    const modal = $('#bl-rule-edit-modal');

    if (index === -1) {
        $('#bl-edit-modal-title').html('<i class="fas fa-folder-plus"></i> 新增规则合集');
        $('#bl-edit-name').val('');
        runtimeState.currentEditingSubrules = [{ targets: [], replacements: [], mode: 'simple', enabled: true, isEditing: false }];
    } else {
        const rule = settings.rules[index];
        $('#bl-edit-modal-title').html('<i class="fas fa-pen"></i> 编辑规则合集');
        $('#bl-edit-name').val(rule.name || '');
        runtimeState.currentEditingSubrules = JSON.parse(JSON.stringify(rule.subRules || []));
        runtimeState.currentEditingSubrules.forEach(sub => {
            if (sub.enabled === undefined) sub.enabled = true;
            sub.isEditing = false;
        });
    }

    renderSubrulesToModal();
    modal.css('display', 'flex');
}
