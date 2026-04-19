import { extensionName, getAppContext, runtimeState } from './state.js';
import { deepClone, getCurrentCharacterContext, getPresetForCharacter, parseInputToWords } from './utils.js';
import { performGlobalCleanse } from './core.js';
import { performDeepCleanse } from './cleanse.js';

export function setupUI() {
    $('#bl-purifier-popup, #bl-rule-edit-modal, #bl-confirm-modal, #bl-rule-transfer-modal, #bl-diff-modal').remove();

    if (!$('#bl-wand-btn').length) {
        $('#data_bank_wand_container').append(`
            <div id="bl-wand-btn" title="词汇映射管理">
                <i class="fa-solid fa-language fa-fw"></i><span>词汇映射</span>
            </div>`);
    }

    $('body').append(`
        <div id="bl-purifier-popup" style="display:none;">
            <div class="bl-header">
                <h3 class="bl-title">全局屏蔽与映射规则</h3>
                <button id="bl-close-btn" class="bl-close">&times;</button>
            </div>
            <div class="bl-tools-bar" style="display:flex; flex-direction:column; gap:8px; margin:10px 0 15px 0; border-bottom:1px solid var(--bl-border-color); padding-bottom:12px;">
                <div class="bl-preset-row" style="display:flex; gap:8px; align-items:center;">
                    <button id="bl-default-toggle" title="设为默认预设（未单独绑定角色时自动使用）" class="bl-icon-btn bl-bind-toggle"><i class="fas fa-star"></i></button>
                    <button id="bl-character-bind-toggle" title="将当前角色绑定到当前预设" class="bl-icon-btn bl-bind-toggle"><i class="fas fa-link-slash"></i></button>
                    <select id="bl-preset-select" style="flex:1; padding:9px 12px; min-height:38px; border-radius:6px; border:1px solid var(--bl-border-color); background:var(--bl-input-bg); color:var(--bl-text-primary); outline:none; font-family:inherit;"></select>
                    <button id="bl-preset-rename" title="重命名存档" class="bl-icon-btn"><i class="fas fa-pen"></i></button>
                    <button id="bl-preset-delete" title="删除存档" class="bl-icon-btn" style="color:var(--bl-danger-color);"><i class="fas fa-trash"></i></button>
                </div>
                <div class="bl-tool-grid" style="display:flex; gap:8px;">
                    <button class="bl-tool-btn" id="bl-preset-new" title="新建"><i class="fas fa-plus"></i><span class="bl-tool-text"> 新建</span></button>
                    <button class="bl-tool-btn" id="bl-preset-save" title="保存"><i class="fas fa-save"></i><span class="bl-tool-text"> 保存</span></button>
                    <button class="bl-tool-btn" id="bl-preset-import" title="导入"><i class="fas fa-file-import"></i><span class="bl-tool-text"> 导入</span></button>
                    <button class="bl-tool-btn" id="bl-preset-export" title="导出"><i class="fas fa-file-export"></i><span class="bl-tool-text"> 导出</span></button>
                </div>
            </div>
            <button id="bl-open-new-rule-btn" class="bl-add-rule-btn" style="width:100%; margin-bottom:10px;"><i class="fas fa-folder-plus"></i> 新增规则组 (合集)</button>
            <div id="bl-tags-container" style="max-height:220px; overflow-y:auto; padding-right:5px;"></div>
            <div class="bl-footer" style="display:flex; justify-content:space-between; align-items:center; gap:15px;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <label class="bl-toggle-switch" title="开启后，被修改过的消息旁会显示溯源按钮">
                        <input type="checkbox" id="bl-diff-global-toggle">
                        <span class="bl-toggle-slider"></span>
                    </label>
                    <span style="font-size:13px; color:var(--bl-text-secondary); font-weight:bold;">透视模式</span>
                </div>
                <button id="bl-deep-clean-btn" class="bl-deep-clean-btn" style="flex:1; width:auto;"><i class="fas fa-broom"></i> 深度清理</button>
            </div>
        </div>`);

    $('body').append(`
        <div id="bl-rule-edit-modal" style="display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.65); z-index:9999999; flex-direction:column; justify-content:center; align-items:center; font-family:inherit; backdrop-filter:blur(4px);">
            <div style="background:var(--bl-background-popup); padding:20px 25px; border-radius:12px; width:90%; max-width:460px; max-height:85vh; display:flex; flex-direction:column; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid var(--bl-border-color); box-sizing:border-box;">
                <h3 id="bl-edit-modal-title" style="margin:0 0 12px 0; font-size:18px; color:var(--bl-text-primary); flex-shrink:0;">编辑规则合集</h3>
                <div style="display:flex; flex-direction:column; gap:4px; margin-bottom:12px; flex-shrink:0;">
                    <label style="font-size:13px; color:var(--bl-text-secondary);">规则组合集名称</label>
                    <input type="text" id="bl-edit-name" class="bl-input" placeholder="例如：程度副词与认知失能净化">
                </div>
                <label style="font-size:13px; color:var(--bl-text-secondary); margin-bottom:6px; flex-shrink:0;">映射规则列表</label>
                <div id="bl-edit-subrules-container" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding-right:5px; margin-bottom:10px;"></div>
                <button id="bl-add-subrule-btn" style="flex-shrink:0; padding:10px; border-radius:8px; background:var(--bl-background-secondary); border:1px dashed var(--bl-border-color); color:var(--bl-text-primary); cursor:pointer; font-size:13px; font-weight:bold; transition: opacity 0.2s; margin-bottom:12px;"><i class="fas fa-plus"></i> 添加一组新映射</button>
                <div style="display:flex; justify-content:space-between; gap:10px; flex-shrink:0;">
                    <button id="bl-edit-cancel" style="flex:1; padding:10px; border-radius:8px; background:var(--bl-background-secondary); border:1px solid var(--bl-border-color); color:var(--bl-text-primary); cursor:pointer; font-weight:bold;">取消</button>
                    <button id="bl-edit-save" style="flex:1; padding:10px; border-radius:8px; background:var(--bl-accent-color); border:none; color:white; font-weight:bold; cursor:pointer;"><i class="fas fa-check"></i> 保存合集</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-confirm-modal" style="display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.65); z-index:9999999; flex-direction:column; justify-content:center; align-items:center; font-family:inherit; backdrop-filter:blur(4px);">
            <div style="background:var(--bl-background-popup); padding:30px; border-radius:12px; max-width:450px; text-align:center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid var(--bl-border-color);">
                <h3 style="color:var(--bl-danger-color); margin-top:0; font-size: 22px;">⚠️ 深度清理警告</h3>
                <p style="font-size:15px; color:var(--bl-text-primary); line-height:1.6; margin:0 0 25px 0; text-align:left;">
                    深度清理会永久洗刷角色卡、世界书、人设、全部历史记录及<strong>当前选中的预设</strong>。
                    为了防止深度清理修改或误伤您的以上内容，请在此刻：
                    <br><br>
                    👉 <strong style="color:var(--bl-danger-color); background:var(--bl-background-secondary); padding:6px 10px; border-radius:6px; display:inline-block; margin-bottom:10px; border: 1px solid var(--bl-border-color);">将SillyTavern当前的预设切换至「Default」或废弃预设！<br>将插件预设切换至不含名词句式规则(已在贴内提供)。</strong>
                    <br>
                    <span style="font-size:13px; color:var(--bl-text-secondary);">清理完成后页面会刷新，届时可切回原预设即可保证预设安全。</span>
                </p>
                <div style="display:flex; justify-content:space-between; gap:15px;">
                    <button id="bl-modal-cancel" style="flex:1; padding:12px; border:1px solid var(--bl-border-color); border-radius:8px; background:var(--bl-background-secondary); color:var(--bl-text-primary); cursor:pointer; font-weight:bold; transition: opacity 0.2s;">取消返回</button>
                    <button id="bl-modal-confirm" disabled style="flex:1; padding:12px; border:none; border-radius:8px; background:var(--bl-background-secondary); color:var(--bl-text-secondary); cursor:not-allowed; font-weight:bold; transition: opacity 0.2s; opacity: 0.6;">我已阅读警告，已完成切换 (3s)</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-rule-transfer-modal" style="display:none;">
            <div class="bl-transfer-content">
                <h3 style="margin:0 0 10px 0; font-size:16px; color:var(--bl-text-primary);"><i class="fas fa-copy"></i> 复制 / 转移规则合集</h3>
                <select id="bl-transfer-target" class="bl-input" style="font-size:14px; padding:8px 10px; margin-bottom:12px;"></select>
                <div style="display:flex; gap:8px;">
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
                    <div style="display:flex; align-items:center; gap:12px;">
                        <button id="bl-diff-pos-toggle" class="bl-icon-btn" style="padding: 6px 12px; min-height: 30px; font-size: 13px;" title="将顶部按钮收纳进三点菜单">
                            <i id="bl-diff-pos-icon" class="fa-solid fa-ellipsis"></i> <span id="bl-diff-pos-text">收纳按钮</span>
                        </button>
                        <button id="bl-diff-mode-toggle" class="bl-icon-btn" style="padding: 6px 12px; min-height: 30px; font-size: 13px;" title="切换视图模式">
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
    $confirmBtn.prop('disabled', true).css({ background: '#660000', color: '#aaa', cursor: 'not-allowed' });

    let timeLeft = 3;
    $confirmBtn.text(`确认清理 (${timeLeft}s)`);

    const timer = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            $confirmBtn.text(`确认清理 (${timeLeft}s)`);
        } else {
            clearInterval(timer);
            $confirmBtn.prop('disabled', false)
                .css({ background: '#d32f2f', color: 'white', cursor: 'pointer' })
                .text('我已切换，确认清理！');
            $confirmBtn.hover(function() { $(this).css('background', '#f44336'); }, function() { $(this).css('background', '#d32f2f'); });
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

export function applyCharacterPresetBinding(force = false) {
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
        applyPresetByName(presetName, { skipRender: true });
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
            if (mode === 'regex') badgeHTML = '<span class="bl-badge bl-badge-regex" style="font-size:9px; padding:2px 4px;">正则</span>';
            else if (mode === 'simple') badgeHTML = '<span class="bl-badge bl-badge-simple" style="background:#0984e3; color:white; font-size:9px; padding:2px 4px;">简易</span>';
            else badgeHTML = '<span class="bl-badge bl-badge-text" style="font-size:9px; padding:2px 4px;">普通</span>';

            let tPreview = sub.targets.join(mode === 'text' ? ', ' : ' | ');
            let rPreview = sub.replacements.join(', ');
            if (!rPreview) rPreview = '【直接删除】';

            subRulesHtml += `
            <div style="display:flex; align-items:center; margin-bottom:5px; overflow:hidden; white-space:nowrap;">
                ${badgeHTML}
                <b style="color:var(--bl-text-primary); margin-right:4px; overflow:hidden; text-overflow:ellipsis; max-width:55%;">${tPreview}</b>
                <i class="fas fa-arrow-right" style="font-size:10px; margin:0 6px; opacity:0.6; flex-shrink:0;"></i>
                <span style="overflow:hidden; text-overflow:ellipsis; flex:1;">${rPreview}</span>
            </div>`;
        });

        if ((r.subRules || []).length > maxPreview) {
            subRulesHtml += `<div style="font-size:11px; margin-top:6px; color:var(--bl-text-secondary); opacity:0.8; text-align:center;">... 以及其他 ${(r.subRules || []).length - maxPreview} 组映射</div>`;
        }
        if (!subRulesHtml) subRulesHtml = '<div style="font-size:12px; color:var(--bl-text-secondary);">无有效映射规则</div>';

        const isEnabled = r.enabled !== false;
        const checkedAttr = isEnabled ? 'checked' : '';
        const cardClass = isEnabled ? 'bl-rule-card' : 'bl-rule-card bl-rule-disabled';

        return `
        <div class="${cardClass}">
            <div class="bl-rule-card-header">
                <div style="display:flex; align-items:center; gap:8px; flex:1; overflow:hidden;">
                    <label class="bl-toggle-switch" title="启用/禁用此合集" style="flex-shrink:0;">
                        <input type="checkbox" class="bl-rule-toggle" data-index="${i}" ${checkedAttr}>
                        <span class="bl-toggle-slider"></span>
                    </label>
                    <div class="bl-rule-name" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                        ${name} <span style="font-size:11px; font-weight:normal; opacity:0.7;">(${(r.subRules || []).length}组)</span>
                    </div>
                </div>
                <div class="bl-rule-actions" style="flex-shrink:0;">
                    <button class="bl-rule-transfer" data-index="${i}" title="复制/转移到其他存档"><i class="fas fa-copy"></i></button>
                    <button class="bl-rule-edit" data-index="${i}" title="编辑合集"><i class="fas fa-pen"></i></button>
                    <button class="bl-rule-del" data-index="${i}" title="删除合集"><i class="fas fa-trash"></i></button>
                </div>
            </div>
            <div class="bl-rule-preview">${subRulesHtml}</div>
        </div>`;
    }).join('');

    $('#bl-tags-container').html(html || '<div style="opacity:0.5; width:100%; text-align:center; font-size:13px; padding: 20px 0;">当前无规则，请点击上方按钮新增</div>');
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

        if (!isEditing) {
            let badgeHTML = '';
            if (mode === 'regex') badgeHTML = '<span class="bl-badge bl-badge-regex">正则</span>';
            else if (mode === 'simple') badgeHTML = '<span class="bl-badge bl-badge-simple" style="background:#0984e3; color:white;">简易</span>';
            else badgeHTML = '<span class="bl-badge bl-badge-text">普通</span>';

            let tPreview = sub.targets.join(mode === 'text' ? ', ' : ' | ');
            let rPreview = sub.replacements.join(', ');
            if (!rPreview) rPreview = '【直接删除】';

            container.append(`
                <div class="bl-subrule-summary" style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:10px; background:var(--bl-background-secondary); border:1px solid var(--bl-border-color); border-radius:8px;">
                    <div class="bl-subrule-main">
                        ${badgeHTML}
                        <div class="bl-subrule-text">
                            <b>${tPreview}</b> <i class="fas fa-arrow-right" style="color:var(--bl-text-secondary); font-size:11px; margin:0 4px;"></i> <span>${rPreview}</span>
                        </div>
                    </div>
                    <div style="display:flex; gap:6px; flex-shrink:0;">
                        <button class="bl-edit-subrule-btn bl-icon-btn" data-index="${i}" title="展开编辑"><i class="fas fa-pen" style="font-size:12px;"></i></button>
                        <button class="bl-del-subrule-btn bl-icon-btn" data-index="${i}" title="删除" style="color:var(--bl-danger-color);"><i class="fas fa-trash" style="font-size:12px;"></i></button>
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
                <div class="bl-subrule-row" style="display:flex; flex-direction:column; gap:8px; padding:12px; background:var(--bl-background-popup); border:1px dashed var(--bl-accent-color); border-radius:8px; position:relative;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <select class="bl-sub-mode bl-input" style="width:auto; padding:6px; font-size:12px;">
                            <option value="simple" ${mode === 'simple' ? 'selected' : ''}>🧩 简易组合 (推荐! 支持{}与*号)</option>
                            <option value="text" ${mode === 'text' ? 'selected' : ''}>📝 普通文本 (长词优先替换)</option>
                            <option value="regex" ${mode === 'regex' ? 'selected' : ''}>⚙️ 正则表达式 (专业模式)</option>
                        </select>
                        <div style="display:flex; gap:6px;">
                            <button class="bl-save-subrule-btn bl-icon-btn" data-index="${i}" title="完成并折叠" style="color:var(--bl-accent-color);"><i class="fas fa-check"></i></button>
                            <button class="bl-del-subrule-btn bl-icon-btn" data-index="${i}" title="删除此组" style="color:var(--bl-danger-color);"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>
                    <textarea class="bl-sub-target bl-textarea" rows="2" placeholder="${tPlaceholder}">${tStr}</textarea>
                    <div style="text-align:center; font-size:12px; color:var(--bl-text-secondary); line-height:1;"><i class="fas fa-arrow-down"></i> 随机替换为 <i class="fas fa-arrow-down"></i></div>
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
