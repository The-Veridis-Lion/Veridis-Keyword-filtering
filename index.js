import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, saveChat, chat_metadata, chat } from "../../../../script.js";

const extensionName = "ultimate_purifier";
const defaultSettings = { rules: [] };

// 性能优化：缓存正则与映射字典，避免高频 DOM 变动时重复计算
let cachedRegex = null;
let wordToRuleMap = {};
let isRegexDirty = true; 

/**
 * 智能分词处理器：剥离引号并按中英符号分割
 */
function parseInputToWords(text) {
    if (!text) return [];
    const noQuotes = text.replace(/['"‘’”“”]/g, ' ');
    return noQuotes.split(/[\s,，、\n]+/).map(w => w.trim()).filter(w => w);
}

/**
 * 构建多对多超级正则及映射字典
 */
function getPurifyRegex() {
    if (!isRegexDirty) return cachedRegex;

    const rules = extension_settings[extensionName]?.rules || [];
    wordToRuleMap = {};
    let allTargets = [];

    rules.forEach(rule => {
        rule.targets.forEach(t => {
            if (t) {
                allTargets.push(t);
                wordToRuleMap[t] = rule.replacements; // 将目标词映射到它的替换词数组
            }
        });
    });

    if (!allTargets.length) {
        cachedRegex = null;
    } else {
        // 按长度倒序排列，防止短词截断长词（如优先匹配“极其”，后匹配“极”）
        const sorted = [...allTargets].sort((a, b) => b.length - a.length);
        const escaped = sorted.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        cachedRegex = new RegExp(`(${escaped.join('|')})`, 'gmu');
    }
    
    isRegexDirty = false;
    return cachedRegex;
}

/**
 * 核心替换回调：随机抽取替换词
 */
function dynamicReplacer(match) {
    const reps = wordToRuleMap[match];
    if (!reps || reps.length === 0) return ''; // 没有替换词，直接删除
    const randIndex = Math.floor(Math.random() * reps.length); // 随机抽取
    return reps[randIndex];
}

/**
 * UI 保护区检测：判断当前元素是否处于系统预设、设置面板或输入框中
 */
function isProtectedNode(node) {
    if (!node || !node.closest) return false;
    
    // 1. 保护主发送框和气泡编辑框
    if (node.id === 'send_textarea' || node.classList.contains('edit_textarea')) return true;
    
    // 2. 保护本插件自身的设置界面
    if (node.closest('#bl-purifier-popup, #bl-batch-popup, #bl-confirm-modal')) return true;
    
    // 3. ★ 核心：保护所有酒馆的 UI 界面（右侧预设菜单、所有弹窗、顶部状态栏、左侧抽屉等）
    if (node.closest('#right-nav-panel, .right_menu, .drawer-content, .popup, .shadow_popup, .character-modal, #top-bar')) {
        return true;
    }
    
    return false;
}

/**
 * 递归洗刷对象
 */
function safeDeepScrub(rootObj, regex, isGlobalSettings = false) {
    let changes = 0;
    if (!rootObj || typeof rootObj !== 'object') return changes;
    const stack = [rootObj];
    const seen = new Set(); 

    while (stack.length > 0) {
        const current = stack.pop();
        if (seen.has(current)) continue;
        seen.add(current);

        try {
            for (let key in current) {
                if (Object.prototype.hasOwnProperty.call(current, key)) {
                    // 【唯一保留的白名单】保护本插件自身的规则配置不被误删
                    if (isGlobalSettings && key === extensionName) continue; 
                    const val = current[key];
                    if (typeof val === 'string') {
                        const cleaned = val.replace(regex, dynamicReplacer);
                        if (val !== cleaned) {
                            current[key] = cleaned;
                            changes++;
                        }
                    } else if (val !== null && typeof val === 'object') {
                        stack.push(val); 
                    }
                }
            }
        } catch(e) { }
    }
    return changes;
}

/**
 * 扫描并清理指定 DOM (加入保护区检测)
 */
function purifyDOM(rootNode, regex) {
    if (!rootNode) return;
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT, null, false);
    
    let node;
    while (node = walker.nextNode()) {
        const parent = node.parentNode;
        // 如果文本节点所在的父级属于受保护区域，或者用户正在聚焦编辑，则跳过
        if (parent && (isProtectedNode(parent) || (document.activeElement && (document.activeElement === parent || parent.contains(document.activeElement))))) {
            continue;
        }
        
        const original = node.nodeValue || '';
        const cleaned = original.replace(regex, dynamicReplacer);
        if (original !== cleaned) node.nodeValue = cleaned;
    }

    if (rootNode.nodeType === 1) {
        let inputs = [];
        if (rootNode.matches && rootNode.matches('input, textarea')) inputs.push(rootNode);
        if (rootNode.querySelectorAll) inputs.push(...Array.from(rootNode.querySelectorAll('input, textarea')));

        inputs.forEach(input => {
            // 过滤受保护的输入框和当前正在打字的输入框
            if (isProtectedNode(input) || document.activeElement === input) return;
            const originalVal = input.value || '';
            const cleanedVal = originalVal.replace(regex, dynamicReplacer);
            if (originalVal !== cleanedVal) input.value = cleanedVal;
        });
    }
}

function performGlobalCleanse() {
    const regex = getPurifyRegex();
    if (!regex) return;
    let chatChanged = false;
    
    if (chat && Array.isArray(chat)) {
        chat.forEach((msg, index) => {
            let msgChanged = false; 
            
            // 1. 清理当前显示的主消息 (msg.mes)
            if (typeof msg.mes === 'string') {
                const cleaned = msg.mes.replace(regex, dynamicReplacer);
                if (msg.mes !== cleaned) { 
                    msg.mes = cleaned; 
                    msgChanged = true; 
                }
            }
            
            // 2. 清理所有滑动分支 (Swipes)，同时兼容新老版本酒馆的数据结构
            if (msg.swipes && Array.isArray(msg.swipes)) {
                for (let i = 0; i < msg.swipes.length; i++) {
                    if (typeof msg.swipes[i] === 'string') {
                        const cleanedSwipe = msg.swipes[i].replace(regex, dynamicReplacer);
                        if (msg.swipes[i] !== cleanedSwipe) {
                            msg.swipes[i] = cleanedSwipe;
                            msgChanged = true;
                        }
                    } else if (typeof msg.swipes[i] === 'object' && msg.swipes[i] !== null && typeof msg.swipes[i].mes === 'string') {
                        const cleanedSwipe = msg.swipes[i].mes.replace(regex, dynamicReplacer);
                        if (msg.swipes[i].mes !== cleanedSwipe) {
                            msg.swipes[i].mes = cleanedSwipe;
                            msgChanged = true;
                        }
                    }
                }
            }

            // 3. 如果修改了底层，立刻命令酒馆官方渲染器刷新气泡！
            if (msgChanged) {
                chatChanged = true;
                try {
                    if (typeof updateMessageBlock === 'function') {
                        setTimeout(() => updateMessageBlock(index, chat[index]), 50);
                    }
                } catch(e) {}
            }
        });
    }
    
    // 4. 将洗刷干净的数据真正写入 .jsonl 文档
    if (chatChanged) {
        try {
            if (typeof saveChat === 'function') saveChat();
        } catch(e) {
            console.error("[Ultimate Purifier] 存盘失败", e);
        }
    }
    
    // 5. 兜底屏幕视觉清理
    purifyDOM(document.getElementById('chat'), regex);
}

async function performDeepCleanse() {
    const regex = getPurifyRegex();
    if (!regex) { alert("请先添加屏蔽规则。"); return; }

    $('body').append(`
        <div id="bl-loading-overlay" style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.85);z-index:9999999;display:flex;flex-direction:column;justify-content:center;align-items:center;color:white;backdrop-filter:blur(5px);">
            <h2 style="margin-bottom:20px;font-size:20px;">正在执行深度扫描与映射替换...</h2>
            <p>正在同步数据到磁盘，请稍候。</p>
        </div>
    `);
    await new Promise(r => setTimeout(r, 100));

    try {
        let scrubbedItems = 0;
        if (chat && Array.isArray(chat)) scrubbedItems += safeDeepScrub(chat, regex, false);
        if (typeof chat_metadata === 'object' && chat_metadata !== null) scrubbedItems += safeDeepScrub(chat_metadata, regex, false);
        if (typeof extension_settings === 'object' && extension_settings !== null) scrubbedItems += safeDeepScrub(extension_settings, regex, true);

        if (scrubbedItems > 0) {
            const saveChatPromise = saveChat();
            if (saveChatPromise instanceof Promise) await saveChatPromise;
            saveSettingsDebounced(); 
            await new Promise(r => setTimeout(r, 2000)); 
            $('#bl-loading-overlay').remove();
            
            // ================= 新增成功后的切回预设提醒 =================
            alert(`清理完成，共处理 ${scrubbedItems} 处匹配项。\n\n页面即将刷新，【请记得在刷新后将系统预设切换回常用预设】以恢复工作状态！`);
            location.reload(); 
        } else {
            $('#bl-loading-overlay').remove();
            alert("未发现需要替换的数据残留。\n\n可以安全地将系统预设切换回您的常用预设了。");
        }
    } catch (e) {
        $('#bl-loading-overlay').remove();
        alert("清理失败，请查看控制台。");
    }
}

function initRealtimeInterceptor() {
    const chatObserver = new MutationObserver((mutations) => {
        const regex = getPurifyRegex();
        if (!regex) return;
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.nodeType === 3 || node.nodeType === 8) { 
                    // 额外防线：检查文本节点的父级
                    if (node.parentNode && isProtectedNode(node.parentNode)) return;
                    const cleaned = node.nodeValue.replace(regex, dynamicReplacer);
                    if (node.nodeValue !== cleaned) node.nodeValue = cleaned;
                } else if (node.nodeType === 1) { 
                    purifyDOM(node, regex);
                }
            });
            if (m.type === 'characterData') {
                if (m.target.parentNode && isProtectedNode(m.target.parentNode)) return;
                const cleaned = m.target.nodeValue.replace(regex, dynamicReplacer);
                if (m.target.nodeValue !== cleaned) m.target.nodeValue = cleaned;
            }
        });
    });
    
    // 只监听实际的聊天气泡区域
    const chatEl = document.getElementById('chat');
    if (chatEl) chatObserver.observe(chatEl, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value'] });

    // 全局打字监听器
    document.addEventListener('input', (e) => {
        const regex = getPurifyRegex();
        // ★ 在这里拦截：如果打字的目标输入框属于保护区（预设面板等），直接 return 放行，不执行过滤
        if (isProtectedNode(e.target)) return;
        
        if (regex && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) {
            let val = e.target.value || e.target.innerText;
            if (val && val.match(regex)) {
                const cleaned = val.replace(regex, dynamicReplacer);
                if (e.target.value !== undefined) {
                    const pos = e.target.selectionStart;
                    e.target.value = cleaned;
                    try { e.target.selectionStart = e.target.selectionEnd = pos; } catch(err){}
                } else { e.target.innerText = cleaned; }
            }
        }
    }, true);
}

function setupUI() {
    if (!$('#bl-wand-btn').length) {
        $('#data_bank_wand_container').append(`
            <div id="bl-wand-btn" title="词汇映射管理">
                <i class="fa-solid fa-language fa-fw"></i><span>词汇映射</span>
            </div>`);
    }
    if (!$('#bl-purifier-popup').length) {
        $('body').append(`
            <div id="bl-purifier-popup">
                <div class="bl-header">
                    <h3 class="bl-title">全局屏蔽与映射规则</h3>
                    <button id="bl-close-btn" class="bl-close">&times;</button>
                </div>
                <div class="bl-rule-builder">
                    <textarea id="bl-target-input" class="bl-textarea" placeholder="输入目标词 (必填，支持批量，逗号/空格分隔)" rows="2"></textarea>
                    <div class="bl-rule-arrow">⬇️ 随机替换为 ⬇️</div>
                    <textarea id="bl-rep-input" class="bl-textarea" placeholder="输入替换词 (可选，支持批量)。不填则直接删除目标词" rows="2"></textarea>
                    <button id="bl-add-rule-btn" class="bl-add-rule-btn">添加规则组</button>
                </div>
                <div id="bl-tags-container" style="margin-top:15px;"></div>
                <div class="bl-footer">
                    <button id="bl-deep-clean-btn" class="bl-deep-clean-btn">深度屏蔽与替换</button>
                </div>
            </div>`);
    }

    // ================= 深度清理二次确认弹窗 =================
    if (!$('#bl-confirm-modal').length) {
        $('body').append(`
            <div id="bl-confirm-modal" style="display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.65); z-index:9999999; flex-direction:column; justify-content:center; align-items:center; font-family:inherit; backdrop-filter:blur(4px);">
                <div style="background:var(--bl-background-popup); padding:30px; border-radius:12px; max-width:450px; text-align:center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid var(--bl-border-color);">
                    <h3 style="color:var(--bl-danger-color); margin-top:0; font-size: 22px;">⚠️ 深度清理警告</h3>
                    
                    <p style="font-size:15px; color:var(--bl-text-primary); line-height:1.6; margin:0 0 25px 0; text-align:left;">
                        为了防止深度清理修改您的常用预设(Preset)，请在此刻：
                        <br><br>
                        👉 <strong style="color:var(--bl-danger-color); background:var(--bl-background-secondary); padding:6px 10px; border-radius:6px; display:inline-block; margin-bottom:10px; border: 1px solid var(--bl-border-color);">将SillyTavern当前的预设切换至「Default」或任意废弃预设！</strong>
                        <br>
                        <span style="font-size:13px; color:var(--bl-text-secondary);">清理完成后页面会刷新，届时可切回原预设即可保证预设安全。</span>
                    </p>

                    <div style="display:flex; justify-content:space-between; gap:15px;">
                        <button id="bl-modal-cancel" style="flex:1; padding:12px; border:1px solid var(--bl-border-color); border-radius:8px; background:var(--bl-background-secondary); color:var(--bl-text-primary); cursor:pointer; font-weight:bold; transition: opacity 0.2s;">取消返回</button>
                        <button id="bl-modal-confirm" disabled style="flex:1; padding:12px; border:none; border-radius:8px; background:var(--bl-background-secondary); color:var(--bl-text-secondary); cursor:not-allowed; font-weight:bold; transition: opacity 0.2s; opacity: 0.6;">我已阅读警告，已完成切换预设 (3s)</button>
                    </div>
                </div>
            </div>
        `);
        
        // 使用透明度变化代替写死颜色，更自然地适配所有主题
        $('#bl-modal-cancel').hover(function(){ $(this).css('opacity', '0.7') }, function(){ $(this).css('opacity', '1') });
    }
}
/**
 * 触发带倒计时的确认弹窗
 */
function showConfirmModal() {
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
            $confirmBtn.hover(function(){ $(this).css('background', '#f44336') }, function(){ $(this).css('background', '#d32f2f') });
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
            performDeepCleanse();
        }
    });
}

function bindEvents() {
    $(document).off('click', '#bl-wand-btn').on('click', '#bl-wand-btn', () => { renderTags(); $('#bl-purifier-popup').fadeIn(200); });
    $(document).off('click', '#bl-close-btn').on('click', '#bl-close-btn', () => $('#bl-purifier-popup').fadeOut(200));
    
    $(document).off('click', '#bl-add-rule-btn').on('click', '#bl-add-rule-btn', () => {
        const targets = parseInputToWords($('#bl-target-input').val());
        const replacements = parseInputToWords($('#bl-rep-input').val());

        if (targets.length > 0) {
            extension_settings[extensionName].rules.push({ targets, replacements });
            $('#bl-target-input').val('');
            $('#bl-rep-input').val('');
            isRegexDirty = true; 
            saveSettingsDebounced();
            renderTags();
            performGlobalCleanse(); 
        }
    });

    $(document).off('click', '.bl-tag-del').on('click', '.bl-tag-del', function() {
        extension_settings[extensionName].rules.splice($(this).data('index'), 1);
        isRegexDirty = true;
        saveSettingsDebounced();
        renderTags();
    });

    $(document).off('click', '#bl-deep-clean-btn').on('click', '#bl-deep-clean-btn', () => {
        showConfirmModal();
    });

    // 1. 纯视觉清洗（流式专用）：只改屏幕显示的字，不碰底层数据
    const visualCleanseOnly = () => {
        const regex = getPurifyRegex();
        if (regex) purifyDOM(document.getElementById('chat'), regex);
    };

    // 2. 深度数据层清洗（延迟 1000ms 确保酒馆写入完成）
    const delayedFullCleanse = () => setTimeout(performGlobalCleanse, 1000); 
    
    // 流式打字中：只执行 DOM 视觉替换，不影响 AI 的 Context
    if (event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, visualCleanseOnly);      
    
    // 打字彻底结束后（或被手动停止时）：执行底层物理删除 + 存入文档 + 刷新小铅笔
    if (event_types.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, delayedFullCleanse); 
    if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, delayedFullCleanse); 
    
    // 其他常规操作时清理
    if (event_types.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, delayedFullCleanse); 
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, delayedFullCleanse);      
    if (event_types.CHAT_CHANGED) eventSource.on(event_types.CHAT_CHANGED, delayedFullCleanse);          
}

function renderTags() {
    const rules = extension_settings[extensionName].rules || [];
    const html = rules.map((r, i) => {
        const fullTargets = r.targets.join(', ');
        const fullReps = r.replacements.length > 0 ? r.replacements.join(', ') : '无 (直接删除)';
        
        return `<div class="bl-tag" title="目标:\n${fullTargets}\n\n替换为:\n${fullReps}">
            <div class="bl-tag-layout">
                <div class="bl-tag-scroll-box bl-tag-left">
                    <b style="color:var(--bl-danger-color)">${fullTargets}</b>
                </div>
                <div class="bl-tag-arrow">➔</div>
                <div class="bl-tag-scroll-box bl-tag-right">
                    <b style="color:var(--bl-accent-color)">${fullReps}</b>
                </div>
            </div>
            <div class="bl-tag-del" data-index="${i}" title="删除规则">&times;</div>
        </div>`;
    }).join('');
    
    $('#bl-tags-container').html(html || '<div style="opacity:0.5; width:100%; text-align:center; font-size:12px; padding: 10px 0;">当前无规则</div>');
}

/**
 * 自动数据迁移：将旧版的 bannedWords 无损升级为 3.0 的 rules 架构
 */
function migrateOldData() {
    const settings = extension_settings[extensionName];
    if (settings && settings.bannedWords) {
        if (settings.bannedWords.length > 0) {
            settings.rules = settings.rules || [];
            settings.rules.push({
                targets: [...settings.bannedWords],
                replacements: []
            });
        }
        delete settings.bannedWords;
        isRegexDirty = true;
        saveSettingsDebounced();
        console.log("[Ultimate Purifier] 已成功将旧版数据迁移至 v3.0");
    }
}

let isBooted = false;
jQuery(() => {
    if (isBooted) return;
    extension_settings[extensionName] = extension_settings[extensionName] || { ...defaultSettings };
    
    // 执行数据迁移
    migrateOldData();
    if (!extension_settings[extensionName].rules) extension_settings[extensionName].rules = [];

    const boot = () => {
        if (isBooted) return;
        isBooted = true;
        setupUI();
        bindEvents();
        initRealtimeInterceptor(); 
        performGlobalCleanse(); 
    };
    if (typeof eventSource !== 'undefined' && event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, boot);
        if (document.getElementById('send_textarea')) boot();
    }
});
