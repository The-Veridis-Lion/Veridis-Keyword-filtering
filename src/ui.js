import { extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';
import { deepClone, getCurrentCharacterContext, getPresetForCharacter, parseInputToWords } from './utils.js';
import { performGlobalCleanse } from './core.js';
import { performDeepCleanse } from './cleanse.js';

export function setupUI() {
    logger.debug('[setupUI] 开始初始化 UI');
    $('#bl-purifier-popup, #bl-rule-edit-modal, #bl-confirm-modal, #bl-rule-transfer-modal, #bl-diff-modal').remove();

    if (!$('#bl-wand-btn').length) {
        $('#data_bank_wand_container').append(`
            <div id="bl-wand-btn" title="词汇映射管理">
                <i class="fa-solid fa-language fa-fw"></i><span>词汇映射</span>
            </div>`);
    }

    $('body').append(`
        <div id="bl-purifier-popup" style="display:none;">
        <div class="bl-header-compact">
                <h3 class="bl-title">全局映射预设</h3>
                <div class="bl-header-actions">
                    <button id="bl-default-toggle" title="设为默认预设" class="bl-icon-btn bl-bind-toggle"><i class="fas fa-star"></i></button>
                    <button id="bl-character-bind-toggle" title="将当前角色绑定到当前预设" class="bl-icon-btn bl-bind-toggle"><i class="fas fa-link-slash"></i></button>
                    <div class="bl-divider-v"></div>
                    <button id="bl-preset-import" title="导入存档" class="bl-icon-btn"><i class="fas fa-file-import"></i></button>
                    <button id="bl-preset-export" title="导出存档" class="bl-icon-btn"><i class="fas fa-file-export"></i></button>
                    <button id="bl-close-btn" class="bl-close-icon" title="关闭">&times;</button>
                </div>
            </div>
            
            <div class="bl-preset-compact-row">
                <select id="bl-preset-select" class="bl-preset-select"></select>
                <div class="bl-preset-actions">
                    <button id="bl-preset-rename" title="重命名" class="bl-icon-btn"><i class="fas fa-pen"></i></button>
                    <button id="bl-preset-save" title="保存" class="bl-icon-btn"><i class="fas fa-save"></i></button>
                    <button id="bl-preset-new" title="新建" class="bl-icon-btn"><i class="fas fa-plus"></i></button>
                    <button id="bl-preset-delete" title="删除存档" class="bl-icon-btn bl-danger-btn"><i class="fas fa-trash"></i></button>
                </div>
            </div>

            <button id="bl-open-new-rule-btn" class="bl-add-rule-btn"><i class="fas fa-folder-plus"></i> 新增规则分组</button>
            <div id="bl-tags-container" class="bl-scroll-region"></div>
            <div class="bl-footer">
                <div class="bl-footer-meta">
                    <label class="bl-toggle-switch" title="开启后，被修改过的消息旁会显示溯源按钮">
                        <input type="checkbox" id="bl-diff-global-toggle">
                        <span class="bl-toggle-slider"></span>
                    </label>
                    <span class="bl-footer-meta-text">透视模式</span>
                </div>
                <button id="bl-deep-clean-btn" class="bl-deep-clean-btn"><i class="fas fa-broom"></i> 深度清理</button>
            </div>
        </div>`);

    $('body').append(`
        <div id="bl-rule-edit-modal" class="bl-modal-shell">
            <div class="bl-modal-card bl-edit-modal-card">
                <h3 id="bl-edit-modal-title" class="bl-edit-modal-title">编辑规则合集</h3>
                <div class="bl-edit-field">
                    <label class="bl-field-label">规则组合集名称</label>
                    <input type="text" id="bl-edit-name" class="bl-input" placeholder="例如：程度副词与认知失能净化">
                </div>
                <label class="bl-field-label" style="margin-bottom:6px; flex-shrink:0;">映射规则列表</label>
                <div id="bl-edit-subrules-container"></div>
                <button id="bl-add-subrule-btn" class="bl-ghost-btn bl-add-subrule-btn"><i class="fas fa-plus"></i> 添加一组新映射</button>
                <div class="bl-modal-actions">
                    <button id="bl-edit-cancel" class="bl-secondary-btn">取消</button>
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
} // <--- 之前就是漏掉了这个大括号导致报错！！！

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
        const name = r.name || `未命名合集 ${i + 1}`;
        let subRulesHtml = '';
        const maxPreview = 3;

        (r.subRules || []).slice(0, maxPreview).forEach(sub => {
            const mode = sub.mode || 'text';
            let badgeHTML = '';
            if (mode === 'regex') badgeHTML = '<span class="bl-badge bl-badge-regex bl-badge-compact">正则</span>';
            else if (mode === 'simple') badgeHTML = '<span class="bl-badge bl-badge-simple bl-badge-compact">简易</span>';
            else badgeHTML = '<span class="bl-badge bl-badge-text bl-badge-compact">普通</span>';

            let tPreview = sub.targets.join(mode === 'text' ? ', ' : ' | ');
            let rPreview = sub.replacements.join(', ');
            if (!rPreview) rPreview = '【直接删除】';

            subRulesHtml += `
            <div class="bl-rule-preview-row">
                ${badgeHTML}
                <b class="bl-rule-preview-source">${tPreview}</b>
                <i class="fas fa-arrow-right bl-rule-preview-arrow"></i>
                <span class="bl-rule-preview-target">${rPreview}</span>
            </div>`;
        });

        if ((r.subRules || []).length > maxPreview) {
            subRulesHtml += `<div class="bl-rule-preview-more">... 以及其他 ${(r.subRules || []).length - maxPreview} 组映射</div>`;
        }
        if (!subRulesHtml) subRulesHtml = '<div class="bl-rule-preview-empty">无有效映射规则</div>';

        const isEnabled = r.enabled !== false;
        const checkedAttr = isEnabled ? 'checked' : '';
        const cardClass = isEnabled ? 'bl-rule-card' : 'bl-rule-card bl-rule-disabled';
        const moveUpDisabled = i === 0 ? 'disabled' : '';
        const moveDownDisabled = i === rules.length - 1 ? 'disabled' : '';

        return `
        <div class="${cardClass}">
            <div class="bl-rule-card-header">
                <div class="bl-rule-card-main">
                    <label class="bl-toggle-switch bl-rule-toggle-wrap" title="启用/禁用此合集">
                        <input type="checkbox" class="bl-rule-toggle" data-index="${i}" ${checkedAttr}>
                        <span class="bl-toggle-slider"></span>
                    </label>
                    <div class="bl-rule-name">
                        ${name} <span class="bl-rule-count">(${(r.subRules || []).length}组)</span>
                    </div>
                </div>
                <div class="bl-rule-actions">
                    <button class="bl-rule-move-up" data-index="${i}" title="上移合集" ${moveUpDisabled}><i class="fas fa-arrow-up"></i></button>
                    <button class="bl-rule-move-down" data-index="${i}" title="下移合集" ${moveDownDisabled}><i class="fas fa-arrow-down"></i></button>
                    <button class="bl-rule-transfer" data-index="${i}" title="复制/转移到其他存档"><i class="fas fa-copy"></i></button>
                    <button class="bl-rule-edit" data-index="${i}" title="编辑合集"><i class="fas fa-pen"></i></button>
                    <button class="bl-rule-del" data-index="${i}" title="删除合集"><i class="fas fa-trash"></i></button>
                </div>
            </div>
            <div class="bl-rule-preview">${subRulesHtml}</div>
        </div>`;
    }).join('');

    $('#bl-tags-container').html(html || '<div class="bl-empty-state">当前无规则，请点击上方按钮新增</div>');
}

export function renderSubrulesToModal() {
    const container = $('#bl-edit-subrules-container');
    container.empty();

    if (runtimeState.currentEditingSubrules.length === 0) {
        container.html('<div style="text-align:center; color:var(--bl-text-secondary); font-size:12px; padding:10px;">当前合集没有映射规则，请点击下方按钮添加。</div>');
        return;
    }

    runtimeState.currentEditingSubrules.forEach((sub, i) => {
        const mode = sub.mode || 'text';
        const isEditing = sub.isEditing !== false;
        const moveUpDisabled = i === 0 ? 'disabled' : '';
        const moveDownDisabled = i === runtimeState.currentEditingSubrules.length - 1 ? 'disabled' : '';

        if (!isEditing) {
            let badgeHTML = '';
            if (mode === 'regex') badgeHTML = '<span class="bl-badge bl-badge-regex">正则</span>';
            else if (mode === 'simple') badgeHTML = '<span class="bl-badge bl-badge-simple">简易</span>';
            else badgeHTML = '<span class="bl-badge bl-badge-text">普通</span>';

            let tPreview = sub.targets.join(mode === 'text' ? ', ' : ' | ');
            let rPreview = sub.replacements.join(', ');
            if (!rPreview) rPreview = '【直接删除】';

            container.append(`
                <div class="bl-subrule-summary">
                    <div class="bl-subrule-summary-head">
                        <div class="bl-subrule-main">
                            ${badgeHTML}
                        </div>
                        <div class="bl-subrule-summary-actions">
                            <button class="bl-move-subrule-up-btn bl-icon-btn" data-index="${i}" title="上移" ${moveUpDisabled}><i class="fas fa-arrow-up"></i></button>
                            <button class="bl-move-subrule-down-btn bl-icon-btn" data-index="${i}" title="下移" ${moveDownDisabled}><i class="fas fa-arrow-down"></i></button>
                            <button class="bl-edit-subrule-btn bl-icon-btn" data-index="${i}" title="展开编辑"><i class="fas fa-pen"></i></button>
                            <button class="bl-del-subrule-btn bl-icon-btn bl-danger-btn" data-index="${i}" title="删除"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>
                    <div class="bl-subrule-summary-body">
                        <div class="bl-subrule-text">
                            <b>${tPreview}</b> <i class="fas fa-arrow-right bl-inline-arrow"></i> <span>${rPreview}</span>
                        </div>
                    </div>
                </div>
            `);
        } else {
            const tStr = sub.targets.join(mode === 'text' ? ', ' : '\n');
            const rStr = sub.replacements.join(mode === 'regex' ? '\n' : ', ');
            let tPlaceholder;
            let rPlaceholder;
            if (mode === 'regex') {
                tPlaceholder = "正则匹配规则 (每行一条)\n例如：/(宛若|如同)(神明|恶魔)/g";
                rPlaceholder = "替换后词汇 (每行一条，允许含逗号，可留空)\n支持 $1, $2 捕获组引用";
            } else if (mode === 'simple') {
                tPlaceholder = "简易语法 (每行一条)\n语法：用 {词1,词2} 组合，用 * 通配模糊，用 ? 标记可有可无\n例如：{宛若,如同}{神明,恶魔}{般,一样}?";
                rPlaceholder = "替换后词汇 (每行一条，支持随机，可留空删除)";
            } else {
                tPlaceholder = "被替换词汇 (逗号/空格分隔)\n例如：嘴角勾起, 并不存在";
                rPlaceholder = "替换后词汇 (逗号/空格分隔，留空则直接删除)";
            }

            container.append(`
                <div class="bl-subrule-row">
                    <div class="bl-subrule-row-head">
                        <select class="bl-sub-mode bl-input bl-subrule-mode-select">
                            <option value="simple" ${mode === 'simple' ? 'selected' : ''}>🧩 简易组合 (推荐! 支持{}与*号)</option>
                            <option value="text" ${mode === 'text' ? 'selected' : ''}>📝 普通文本 (长词优先替换)</option>
                            <option value="regex" ${mode === 'regex' ? 'selected' : ''}>⚙️ 正则表达式 (专业模式)</option>
                        </select>
                        <div class="bl-subrule-summary-actions">
                            <button class="bl-move-subrule-up-btn bl-icon-btn" data-index="${i}" title="上移" ${moveUpDisabled}><i class="fas fa-arrow-up"></i></button>
                            <button class="bl-move-subrule-down-btn bl-icon-btn" data-index="${i}" title="下移" ${moveDownDisabled}><i class="fas fa-arrow-down"></i></button>
                            <button class="bl-save-subrule-btn bl-icon-btn bl-accent-btn" data-index="${i}" title="完成并折叠"><i class="fas fa-check"></i></button>
                            <button class="bl-del-subrule-btn bl-icon-btn bl-danger-btn" data-index="${i}" title="删除此组"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>
                    <textarea class="bl-sub-target bl-textarea" rows="2" placeholder="${tPlaceholder}">${tStr}</textarea>
                    <div class="bl-subrule-flow-label"><i class="fas fa-arrow-down"></i> 随机替换为 <i class="fas fa-arrow-down"></i></div>
                    <textarea class="bl-sub-rep bl-textarea" rows="2" placeholder="${rPlaceholder}">${rStr}</textarea>
                </div>
            `);
        }
    });
}

export function syncSubrulesFromDOM() {
    $('.bl-subrule-row').each(function() {
        const index = $(this).find('.bl-save-subrule-btn').data('index');
        const mode = $(this).find('.bl-sub-mode').val();
        const tStr = $(this).find('.bl-sub-target').val();
        const rStr = $(this).find('.bl-sub-rep').val();

        runtimeState.currentEditingSubrules[index].mode = mode;
        runtimeState.currentEditingSubrules[index].targets = parseInputToWords(tStr, mode, { isTarget: true });
        runtimeState.currentEditingSubrules[index].replacements = parseInputToWords(rStr, mode === 'text' ? 'text' : 'regex', { isTarget: false });
    });
}

export function openTransferModal(ruleIndex) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const presets = settings?.presets || {};
    const currentPreset = settings?.activePreset || "";
    const targetNames = Object.keys(presets).filter(name => name !== currentPreset);
    if (targetNames.length === 0) {
        alert('没有可用的目标存档。请先创建至少一个其他存档。');
        return;
    }

    runtimeState.currentTransferRuleIndex = ruleIndex;
    const $select = $('#bl-transfer-target');
    $select.empty();
    targetNames.forEach(name => $select.append($('<option>', { value: name, text: name })));
    $('#bl-rule-transfer-modal').css('display', 'flex');
}

export function closeTransferModal() {
    runtimeState.currentTransferRuleIndex = -1;
    $('#bl-rule-transfer-modal').hide();
}

export function runRuleTransfer(isMove) {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const targetPreset = String($('#bl-transfer-target').val() || '');
    if (runtimeState.currentTransferRuleIndex < 0) return;
    if (!targetPreset) {
        alert('请选择目标存档。');
        return;
    }

    const sourceRules = settings.rules || [];
    const selectedRule = sourceRules[runtimeState.currentTransferRuleIndex];
    if (!selectedRule) {
        closeTransferModal();
        return;
    }

    if (!Array.isArray(settings.presets[targetPreset])) settings.presets[targetPreset] = [];
    settings.presets[targetPreset].push(JSON.parse(JSON.stringify(selectedRule)));
    if (isMove) sourceRules.splice(runtimeState.currentTransferRuleIndex, 1);

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
        runtimeState.currentEditingSubrules = [{ targets: [], replacements: [], mode: 'simple', isEditing: true }];
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
