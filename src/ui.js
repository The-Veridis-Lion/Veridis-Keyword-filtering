import { extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';
import { deepClone, getCurrentCharacterContext, getPresetForCharacter, parseInputToWords } from './utils.js';
import { performGlobalCleanse } from './core.js';
import { performDeepCleanse } from './cleanse.js';

function safeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function showToast(message) {
    $('.bl-toast').remove();
    // 替换为 100% 兼容的 fas fa-exclamation-circle 图标
    const $toast = $('<div class="bl-toast" role="status" aria-live="polite"><i class="fas fa-exclamation-circle" style="margin-right: 6px; font-size: 15px;"></i><span class="bl-toast-text"></span></div>');
    $toast.find('.bl-toast-text').text(String(message || ''));
    $('body').append($toast);
    setTimeout(() => $toast.addClass('show'), 10);
    setTimeout(() => {
        $toast.removeClass('show');
        setTimeout(() => $toast.remove(), 300);
    }, 2000);
}

export function setupUI() {
    logger.debug('[setupUI] 开始初始化 UI');
    $('#bl-purifier-popup, #bl-rule-edit-modal, #bl-confirm-modal, #bl-rule-transfer-modal, #bl-diff-modal, #bl-subrule-edit-modal, .bl-toast').remove();

    if (!$('#bl-wand-btn').length) {
        $('#data_bank_wand_container').append(`
            <div id="bl-wand-btn" title="词汇映射管理">
                <i class="fa-solid fa-language fa-fw"></i><span>词汇映射</span>
            </div>`);
    }

    $('body').append(`
        <div id="bl-purifier-popup" data-bl-theme="auto" style="display:none;">
            <div class="header">
                <div class="title">
                    <i class="fas fa-globe"></i>
                    全局映射预设
                </div>
                <div class="icon-group">
                    <button id="bl-theme-toggle" title="切换主题"><i class="fas fa-circle-half-stroke"></i></button>
                    <button id="bl-default-toggle" title="设为默认预设" class="bl-bind-toggle"><i class="fas fa-star"></i></button>
                    <button id="bl-character-bind-toggle" title="将当前角色绑定到当前预设" class="bl-bind-toggle"><i class="fas fa-link-slash"></i></button>
                    <button id="bl-preset-import" title="导入存档"><i class="fas fa-file-import"></i></button>
                    <button id="bl-preset-export" title="导出存档"><i class="fas fa-file-export"></i></button>
                    <button id="bl-close-btn" title="关闭"><i class="fas fa-times"></i></button>
                </div>
            </div>

            <div class="toolbar">
                <select id="bl-preset-select" class="select-box"></select>
                <div class="icon-group">
                    <button id="bl-preset-rename" title="重命名"><i class="fas fa-pen"></i></button>
                    <button id="bl-preset-save" title="保存"><i class="fas fa-save"></i></button>
                    <button id="bl-preset-new" title="新建"><i class="fas fa-plus"></i></button>
                    <button id="bl-preset-delete" title="删除存档"><i class="fas fa-trash"></i></button>
                </div>
            </div>

            <div class="action-buttons">
                <button id="bl-open-new-rule-btn" class="btn-secondary"><i class="fas fa-folder-plus"></i> 新增规则分组</button>
                <button class="btn-secondary" id="bl-batch-toggle"><i class="fas fa-list-check"></i> 批量编辑模式</button>
            </div>

            <div class="batch-operations" id="bl-batch-operations">
                <button class="batch-btn" id="bl-btn-select-all"><i class="far fa-check-square"></i> 全选</button>
                <button class="batch-btn" id="bl-btn-select-invert"><i class="fas fa-minus-square"></i> 反选</button>
                <button class="batch-btn" id="bl-btn-batch-transfer"><i class="fas fa-copy"></i> 复制 / 转移</button>
                <button class="batch-btn danger" id="bl-btn-batch-delete"><i class="fas fa-trash"></i> 删除</button>
            </div>

            <div class="divider"></div>

            <div id="bl-tags-container" class="card-list" style="overflow-y:auto; flex:1;"></div>

            <div class="bottom-bar">
                <label class="checkbox-label" title="开启后，被修改过的消息旁会显示溯源按钮">
                    <input type="checkbox" id="bl-diff-global-toggle">
                    <span class="custom-checkbox square"></span>
                    <span class="bottom-text">透视模式</span>
                </label>
                <button id="bl-deep-clean-btn" class="btn-danger"><i class="fas fa-broom"></i> 深度清理</button>
            </div>
        </div>`);

    $('body').append(`
        <div id="bl-rule-edit-modal" class="bl-modal-shell">
            <div class="bl-modal-card bl-edit-modal-card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-shrink: 0;">
                    <h3 id="bl-edit-modal-title" class="bl-edit-modal-title" style="margin: 0; display: flex; align-items: center; gap: 8px;">
                        <i class="fas fa-pen"></i> 编辑规则合集
                    </h3>
                    <button id="bl-edit-cancel-x" class="bl-icon-btn" style="background: transparent !important; border: none !important; box-shadow: none !important; font-size: 20px !important; color: var(--text-mute); padding: 0 !important; min-width: auto !important; height: auto !important; cursor: pointer;">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="bl-edit-field">
                    <label class="bl-field-label">规则组合集名称</label>
                    <input type="text" id="bl-edit-name" class="bl-input" placeholder="例如：程度副词与认知失能净化" style="background: var(--bg-button) !important; border: 1px solid var(--border-color) !important; color: var(--text-main) !important;">
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
        <div id="bl-diff-modal" style="display:none;">
            <div class="bl-diff-modal-card">
                <div class="bl-diff-modal-header">
                    <h3 class="bl-diff-modal-title"><i class="fa-solid fa-eye"></i> 净化前文透视</h3>
                    <div class="bl-diff-header-actions">
                        <button id="bl-diff-revert-toggle" class="bl-icon-btn bl-diff-header-btn" title="撤回净化并保护原文">
                            <i id="bl-diff-revert-icon" class="fas fa-rotate-left"></i> <span id="bl-diff-revert-text">撤回</span>
                        </button>
                        <button id="bl-diff-pos-toggle" class="bl-icon-btn bl-diff-header-btn" title="将顶部按钮收纳进三点菜单">
                            <i id="bl-diff-pos-icon" class="fa-solid fa-ellipsis"></i> <span id="bl-diff-pos-text">收纳按钮</span>
                        </button>
                        <button id="bl-diff-mode-toggle" class="bl-icon-btn bl-diff-header-btn" title="切换视图模式">
                            <i id="bl-diff-mode-icon" class="fa-solid fa-file-lines"></i> <span id="bl-diff-mode-text">全文模式</span>
                        </button>
                        <button id="bl-diff-modal-close" class="bl-diff-modal-close" aria-label="关闭">&times;</button>
                    </div>
                </div>
                <div id="bl-diff-modal-content" class="bl-diff-modal-content"></div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-subrule-edit-modal" class="bl-modal-shell" style="z-index: 10000005;">
            <div class="bl-modal-card bl-edit-modal-card" style="padding: 20px !important;">
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
                    <button id="bl-modal-sub-save" class="bl-icon-btn bl-subrule-save-btn" title="完成保存"><i class="fas fa-check"></i></button>
                </div>
                
                <div class="bl-subrule-field" style="margin-bottom: 12px;">
                    <label class="bl-field-label" style="margin-bottom: 6px; font-weight: 600;">备注说明 (可选)</label>
                    <input type="text" id="bl-modal-sub-remark" class="bl-input" placeholder="例如：处理特定角色的口头禅" style="background: var(--bg-button) !important; border: none !important; border-radius: 8px !important; font-size: 14px !important; padding: 10px 14px !important;">
                </div>
                
                <div class="bl-subrule-field" style="margin-bottom: 12px;">
                    <label class="bl-field-label" style="margin-bottom: 6px; font-weight: 600;">查找内容</label>
                    <textarea id="bl-modal-sub-target" class="bl-textarea" rows="4" style="background: var(--bg-button) !important; border: none !important; border-radius: 8px !important; font-size: 14px !important; padding: 10px 14px !important;"></textarea>
                    <div id="bl-modal-sub-target-error" class="bl-field-error" aria-live="polite"></div>
                </div>
                
                <div class="bl-subrule-field" style="margin-bottom: 15px;">
                    <label class="bl-field-label" style="margin-bottom: 6px; font-weight: 600;">替换为</label>
                    <textarea id="bl-modal-sub-rep" class="bl-textarea" rows="4" style="background: var(--bg-button) !important; border: none !important; border-radius: 8px !important; font-size: 14px !important; padding: 10px 14px !important;"></textarea>
                </div>
                
                <button id="bl-modal-sub-cancel" class="bl-secondary-btn" style="margin-top: auto; border: none !important; background: var(--bg-button) !important;">取消修改</button>
            </div>
        </div>
    `);
} 

export function focusLatestRuleCard() {
    const container = document.getElementById('bl-tags-container');
    if (!container) return;

    const cards = container.querySelectorAll('.card');
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

export function showDeepCleanOverlay() {
    $('body').append(`
        <div id="bl-loading-overlay" class="bl-loading-overlay">
            <h2 class="bl-loading-title"><i class="fas fa-spinner fa-spin"></i> 正在执行全方位深度清理 (包含角色卡与世界书)...</h2>
            <p id="bl-loading-status">正在初始化清理任务，请稍候。</p>
            <div class="bl-progress-track"><div id="bl-progress-fill" class="bl-progress-fill"></div></div>
            <p id="bl-progress-percent" class="bl-progress-percent">0%</p>
        </div>
    `);
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
    $confirmBtn.prop('disabled', true).addClass('is-disabled');

    let timeLeft = 3;
    $confirmBtn.text(`确认清理 (${timeLeft}s)`);

    const timer = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            $confirmBtn.text(`确认清理 (${timeLeft}s)`);
        } else {
            clearInterval(timer);
            $confirmBtn.prop('disabled', false)
                .removeClass('is-disabled')
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
    runtimeState.isRegexDirty = true;
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
        return;
    }
    Object.keys(settings.characterBindings).forEach((key) => {
        const preset = settings.characterBindings[key];
        if (!preset || !presets[preset]) delete settings.characterBindings[key];
    });
}

export function refreshCharacterBindingUI() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const context = getCurrentCharacterContext();
    const activePreset = String(settings.activePreset || '');
    const $defaultBtn = $('#bl-default-toggle');
    const $bindBtn = $('#bl-character-bind-toggle');
    const currentBound = context.key ? (settings.characterBindings?.[context.key] || '') : '';

    if ($defaultBtn.length && $bindBtn.length) {
        const isDefaultActive = !!(activePreset && settings.defaultPreset === activePreset);
        $defaultBtn.toggleClass('bl-bind-active', isDefaultActive);
        $defaultBtn.prop('disabled', !activePreset);
        $defaultBtn.attr('title', activePreset ? (isDefaultActive ? `已设为默认预设：${activePreset}（点击取消）` : `将当前预设设为默认：${activePreset}`) : '请先选择一个预设');

        const isCharacterBound = !!(context.key && activePreset && currentBound === activePreset);
        $bindBtn.toggleClass('bl-bind-active', isCharacterBound);
        $bindBtn.prop('disabled', !activePreset || !context.key);
        $bindBtn.find('i').removeClass('fa-link fa-link-slash').addClass(isCharacterBound ? 'fa-link' : 'fa-link-slash');
        $bindBtn.attr('title', !activePreset ? '请先选择一个预设' : !context.key ? '未检测到当前角色，无法绑定' : (isCharacterBound ? `已绑定：${context.name} → ${activePreset}（点击解除）` : `绑定当前角色：${context.name} → ${activePreset}`));
    }
}

export function applyCharacterPresetBinding(force = false, options = {}) {
    const { extension_settings } = getAppContext();
    const context = getCurrentCharacterContext();
    if (!context.key) {
        runtimeState.lastCharacterContextKey = "";
        refreshCharacterBindingUI();
        return;
    }

    const characterChanged = context.key !== runtimeState.lastCharacterContextKey;
    if (!force && !characterChanged) return;
    runtimeState.lastCharacterContextKey = context.key;

    const presetName = getPresetForCharacter(context.key);
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
    select.empty();
    select.append('<option value="">-- 临时规则 (未绑定存档) --</option>');

    if (settings.presets) {
        for (let name in settings.presets) {
            select.append($('<option>', { value: name, text: name }));
        }
    }
    select.val(settings.activePreset || "");
    refreshCharacterBindingUI();
}

export function renderTags() {
    const { extension_settings } = getAppContext();
    const rules = extension_settings[extensionName]?.rules || [];
    const html = rules.map((r, i) => {
        const name = safeHtml(r.name) || `未命名合集 ${i + 1}`;
        const subRules = r.subRules || [];
        const maxPreview = 3;

        const subRulesHtml = subRules.slice(0, maxPreview).map((sub) => {
            const mode = sub.mode || 'text';
            const tagText = mode === 'regex' ? '正则' : mode === 'simple' ? '简易' : '普通';
            const tPreview = safeHtml((sub.targets || []).join(mode === 'text' ? ', ' : ' | ')) || '（空）';
            const rPreview = safeHtml((sub.replacements || []).join(', ')) || '【直接删除】';
            return `
                <div class="rule-item">
                    <span class="tag">${tagText}</span>
                    <span class="source">${tPreview}</span>
                    <i class="fas fa-arrow-right arrow"></i>
                    <span class="target">${rPreview}</span>
                </div>`;
        }).join('');

        const moreHtml = subRules.length > maxPreview
            ? `<div class="more-text">... 以及其他 ${subRules.length - maxPreview} 组映射</div>`
            : '';
        const bodyHtml = subRules.length > 0
            ? `<div class="card-body">${subRulesHtml}${moreHtml}</div>`
            : '';

        const isEnabled = r.enabled !== false;
        const checkedAttr = isEnabled ? 'checked' : '';
        const moveUpDisabled = i === 0 ? 'disabled' : '';
        const moveDownDisabled = i === rules.length - 1 ? 'disabled' : '';
        const headerClass = subRules.length > 0 ? 'card-header has-border' : 'card-header';

        return `
            <div class="card ${!isEnabled ? 'is-disabled' : ''}" data-index="${i}">
                <div class="${headerClass}">
                    <div class="header-left">
                        <label class="batch-checkbox-label">
                            <input type="checkbox" class="batch-item-checkbox" data-index="${i}">
                            <span class="custom-checkbox square-2px"></span>
                        </label>
                        <label class="checkbox-label">
                            <input type="checkbox" class="bl-rule-toggle" data-index="${i}" ${checkedAttr}>
                            <span class="custom-checkbox"></span>
                            <span class="group-title">${name}</span>
                        </label>
                    </div>
                    <div class="icon-group compact">
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

    $('#bl-tags-container').html(html || '<div class="bl-empty-state">当前无规则，请点击上方按钮新增</div>');
}

export function renderSubrulesToModal() {
    const container = $('#bl-edit-subrules-container');
    container.empty();

    if (runtimeState.currentEditingSubrules.length === 0) {
        container.html('<div style="text-align:center; color:var(--bl-text-secondary); font-size:12px; padding:20px;">当前合集没有映射规则，请点击下方按钮添加。</div>');
        return;
    }

    runtimeState.currentEditingSubrules.forEach((sub, i) => {
        const mode = sub.mode || 'text';
        const remark = sub.remark ? sub.remark.trim() : '';
        const moveUpDisabled = i === 0 ? 'disabled' : '';
        const moveDownDisabled = i === runtimeState.currentEditingSubrules.length - 1 ? 'disabled' : '';

        const badgeBaseStyle = "display:inline-flex; align-items:center; justify-content:center; padding:4px 10px; border-radius:6px; font-size:13px; font-weight:800; color:#fff; min-width:45px; margin:0; line-height:1; flex-shrink:0;";
        let badgeHTML = '';
        if (mode === 'regex') badgeHTML = `<span style="${badgeBaseStyle} background:var(--bl-accent-color);">正则</span>`;
        else if (mode === 'simple') badgeHTML = `<span style="${badgeBaseStyle} background:color-mix(in srgb, var(--bl-accent-color) 72%, #3b82f6 28%);">简易</span>`;
        else badgeHTML = `<span style="${badgeBaseStyle} background:var(--bl-text-secondary); color:var(--bl-background-popup);">普通</span>`;

        let tPreview = safeHtml(sub.targets.join(mode === 'text' ? ', ' : ' | '));
        let rPreview = safeHtml(sub.replacements.join(', '));
        if (!rPreview) rPreview = '【直接删除】';

        let remarkHTML = '';
        if (remark) {
            remarkHTML = `
                <div style="margin-top: 8px; padding-top: 10px; border-top: 1px dotted color-mix(in srgb, var(--bl-text-primary) 35%, rgba(128,128,128,0.5)); font-size: 11px; color: var(--text-mute); font-style: italic;">
                    <i class="fas fa-info-circle" style="margin-right: 4px;"></i>${safeHtml(remark)}
                </div>
            `;
        }

        container.append(`
            <div style="flex-shrink: 0 !important; background: var(--bl-background-secondary); border: 1px solid var(--bl-border-color); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; display: flex; flex-direction: column; box-shadow: 0 4px 10px rgba(0,0,0,0.04);">
                <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px dotted color-mix(in srgb, var(--bl-text-primary) 35%, rgba(128,128,128,0.5));">
                    <div style="display: flex; align-items: center; margin: 0; padding: 0;">
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
                    <i class="fas fa-arrow-right" style="color: var(--text-mute); font-size: 11px; margin: 0 6px;"></i> 
                    <span style="font-size: 13px !important;">${rPreview}</span>
                </div>
                ${remarkHTML}
            </div>
        `);
    });
}

export function openSingleRuleModal(index) {
    runtimeState.currentSubruleEditIndex = index;
    let mode = 'simple';
    let tStr = '';
    let rStr = '';
    let remark = '';

    if (index >= 0 && runtimeState.currentEditingSubrules[index]) {
        const sub = runtimeState.currentEditingSubrules[index];
        mode = sub.mode || 'simple';
        tStr = (sub.targets || []).join(mode === 'text' ? ', ' : '\n');
        rStr = (sub.replacements || []).join(mode === 'regex' ? '\n' : ', ');
        remark = sub.remark || '';
    }

    $('#bl-modal-sub-mode').val(mode);
    $('#bl-modal-sub-target').val(tStr);
    $('#bl-modal-sub-rep').val(rStr);
    $('#bl-modal-sub-remark').val(remark);
    
    $('#bl-modal-sub-mode').trigger('change');
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
    $select.empty();
    targetNames.forEach(name => $select.append($('<option>', { value: name, text: name })));
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
    }

    runtimeState.isRegexDirty = true;
    closeTransferModal();
    saveSettingsDebounced();
    renderTags();
}

export function openEditModal(index = -1) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    runtimeState.currentEditingIndex = index;
    const modal = $('#bl-rule-edit-modal');

    if (index === -1) {
        $('#bl-edit-modal-title').html('<i class="fas fa-folder-plus"></i> 新增规则合集');
        $('#bl-edit-name').val('');
        runtimeState.currentEditingSubrules = [{ targets: [], replacements: [], mode: 'simple', isEditing: false }];
    } else {
        const rule = settings.rules[index];
        $('#bl-edit-modal-title').html('<i class="fas fa-pen"></i> 编辑规则合集');
        $('#bl-edit-name').val(rule.name || '');
        runtimeState.currentEditingSubrules = JSON.parse(JSON.stringify(rule.subRules || []));
        runtimeState.currentEditingSubrules.forEach(sub => sub.isEditing = false);
    }

    renderSubrulesToModal();
    modal.css('display', 'flex');
}
