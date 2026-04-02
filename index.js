import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, saveChat, chat_metadata } from "../../../../script.js";

const extensionName = "ultimate_purifier";
const defaultSettings = { bannedWords: [] };

/**
 * 构建屏蔽词正则，按长度倒序排列以优化匹配
 */
function getPurifyRegex() {
    const words = extension_settings[extensionName]?.bannedWords || [];
    if (!words.length) return null;
    const sorted = [...words].sort((a, b) => b.length - a.length);
    const escaped = sorted.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`(${escaped.join('|')})`, 'gmu');
}

/**
 * 递归洗刷对象中的字符串属性，支持循环引用保护
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
                    // 若为插件全局设置，跳过当前插件自身的配置项，防止屏蔽列表被清空
                    if (isGlobalSettings && key === extensionName) continue;

                    const val = current[key];
                    if (typeof val === 'string') {
                        const cleaned = val.replace(regex, '');
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
 * 扫描并清理指定 DOM 树下的文本节点、注释节点及输入控件
 */
function purifyDOM(rootNode, regex) {
    if (!rootNode) return;

    const walker = document.createTreeWalker(
        rootNode, 
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT, 
        null, 
        false
    );
    
    let node;
    while (node = walker.nextNode()) {
        const parent = node.parentNode;
        if (parent) {
            if (parent.id === 'send_textarea' || (parent.classList && parent.classList.contains('edit_textarea'))) continue;
            if (document.activeElement && (document.activeElement === parent || parent.contains(document.activeElement))) continue;
        }

        const original = node.nodeValue || '';
        const cleaned = original.replace(regex, '');
        if (original !== cleaned) node.nodeValue = cleaned;
    }

    if (rootNode.nodeType === 1) {
        let inputs = [];
        if (rootNode.matches && rootNode.matches('input, textarea')) inputs.push(rootNode);
        if (rootNode.querySelectorAll) inputs.push(...Array.from(rootNode.querySelectorAll('input, textarea')));

        inputs.forEach(input => {
            if (input.id === 'send_textarea' || input.classList.contains('edit_textarea')) return;
            if (document.activeElement === input) return; 
            const originalVal = input.value || '';
            const cleanedVal = originalVal.replace(regex, '');
            if (originalVal !== cleanedVal) input.value = cleanedVal;
        });
    }
}

/**
 * 执行全屏及内存对话数据的即时清理
 */
function performGlobalCleanse() {
    const regex = getPurifyRegex();
    if (!regex) return;

    let chatChanged = false;
    if (window.chat && Array.isArray(window.chat)) {
        window.chat.forEach(msg => {
            if (msg.mes) {
                const cleaned = msg.mes.replace(regex, '');
                if (msg.mes !== cleaned) {
                    msg.mes = cleaned;
                    chatChanged = true;
                }
            }
        });
    }
    if (chatChanged) saveChat(); 
    purifyDOM(document.getElementById('chat'), regex);
}

/**
 * 深度清理函数：遍历所有数据库、元数据及扩展缓存，完成后刷新页面
 */
async function performDeepCleanse() {
    const regex = getPurifyRegex();
    if (!regex) {
        alert("请先添加屏蔽词。");
        return;
    }

    $('body').append(`
        <div id="bl-loading-overlay" style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.85);z-index:9999999;display:flex;flex-direction:column;justify-content:center;align-items:center;color:white;font-family:sans-serif;backdrop-filter:blur(5px);">
            <h2 style="margin-bottom:20px;font-size:20px;">正在执行深度扫描与清理...</h2>
            <p>正在同步数据到磁盘，请稍候。</p>
        </div>
    `);

    await new Promise(r => setTimeout(r, 100));

    try {
        let scrubbedItems = 0;
        if (window.chat && Array.isArray(window.chat)) scrubbedItems += safeDeepScrub(window.chat, regex, false);
        if (typeof chat_metadata === 'object' && chat_metadata !== null) scrubbedItems += safeDeepScrub(chat_metadata, regex, false);
        if (typeof extension_settings === 'object' && extension_settings !== null) scrubbedItems += safeDeepScrub(extension_settings, regex, true);

        if (scrubbedItems > 0) {
            const saveChatPromise = saveChat();
            if (saveChatPromise instanceof Promise) await saveChatPromise;
            saveSettingsDebounced(); 
            await new Promise(r => setTimeout(r, 2000)); 
            $('#bl-loading-overlay').remove();
            alert(`清理完成，共移除 ${scrubbedItems} 处匹配项。页面即将刷新。`);
            location.reload(); 
        } else {
            $('#bl-loading-overlay').remove();
            alert("未发现匹配残留。");
        }
    } catch (e) {
        console.error("Deep cleanse failed:", e);
        $('#bl-loading-overlay').remove();
        alert("清理过程中发生错误，请查看控制台。");
    }
}

/**
 * 初始化实时监听器：监控 DOM 变化及流式输出
 */
function initRealtimeInterceptor() {
    const chatObserver = new MutationObserver((mutations) => {
        const regex = getPurifyRegex();
        if (!regex) return;
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.nodeType === 3 || node.nodeType === 8) { 
                    const cleaned = node.nodeValue.replace(regex, '');
                    if (node.nodeValue !== cleaned) node.nodeValue = cleaned;
                } else if (node.nodeType === 1) { 
                    purifyDOM(node, regex);
                }
            });
            if (m.type === 'characterData') {
                const cleaned = m.target.nodeValue.replace(regex, '');
                if (m.target.nodeValue !== cleaned) m.target.nodeValue = cleaned;
            }
        });
    });
    const chatEl = document.getElementById('chat');
    if (chatEl) chatObserver.observe(chatEl, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value'] });

    document.addEventListener('input', (e) => {
        const regex = getPurifyRegex();
        if (regex && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) {
            let val = e.target.value || e.target.innerText;
            if (val && val.match(regex)) {
                const cleaned = val.replace(regex, '');
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
            <div id="bl-wand-btn" title="屏蔽词管理">
                <i class="fa-solid fa-eraser fa-fw"></i><span>屏蔽词管理</span>
            </div>`);
    }
    if (!$('#bl-purifier-popup').length) {
        // 修改了此处的 HTML，在原“添加”按钮旁边加入“批量”按钮
        $('body').append(`
            <div id="bl-purifier-popup">
                <div class="bl-header">
                    <h3 class="bl-title">屏蔽词设置</h3>
                    <button id="bl-close-btn" class="bl-close">&times;</button>
                </div>
                <div class="bl-input-group">
                    <input type="text" id="bl-input-field" class="bl-input" placeholder="输入屏蔽词...">
                    <button id="bl-add-btn" class="bl-add-btn">添加</button>
                    <button id="bl-batch-open-btn" class="bl-add-btn" style="background-color: var(--bl-text-secondary); padding: 10px 12px;" title="批量导入">批量</button>
                </div>
                <div id="bl-tags-container"></div>
                <div class="bl-footer">
                    <button id="bl-deep-clean-btn" class="bl-deep-clean-btn">深度屏蔽</button>
                </div>
            </div>`);
    }
    
    // 新增：批量添加专属弹窗的 DOM 注入
    if (!$('#bl-batch-popup').length) {
        $('body').append(`
            <div id="bl-batch-popup">
                <div class="bl-header">
                    <h3 class="bl-title">批量添加屏蔽词</h3>
                    <button id="bl-batch-close-btn" class="bl-close">&times;</button>
                </div>
                <div style="margin-top: 15px;">
                    <textarea id="bl-batch-textarea" placeholder="支持空格、逗号、顿号或换行分隔。\\n允许带有引号，如：'你好'，'病态'，'极其'" rows="5"></textarea>
                </div>
                <div class="bl-footer" style="display: flex; gap: 10px; border-top: none; padding-top: 15px;">
                    <button id="bl-batch-submit-btn" class="bl-add-btn" style="flex: 1;">确认导入</button>
                    <button id="bl-batch-cancel-btn" class="bl-deep-clean-btn" style="flex: 1; background: var(--bl-text-secondary); margin: 0;">取消</button>
                </div>
            </div>`);
    }
}

function bindEvents() {
    // --- 原有功能的事件绑定（保持不变） ---
    $(document).off('click', '#bl-wand-btn').on('click', '#bl-wand-btn', () => { renderTags(); $('#bl-purifier-popup').fadeIn(200); });
    $(document).off('click', '#bl-close-btn').on('click', '#bl-close-btn', () => $('#bl-purifier-popup').fadeOut(200));
    $(document).off('click', '#bl-add-btn').on('click', '#bl-add-btn', () => {
        const val = $('#bl-input-field').val().trim();
        if (val && !extension_settings[extensionName].bannedWords.includes(val)) {
            extension_settings[extensionName].bannedWords.push(val);
            $('#bl-input-field').val('');
            saveSettingsDebounced();
            renderTags();
            performGlobalCleanse(); 
        }
    });
    $(document).off('click', '.bl-tag span').on('click', '.bl-tag span', function() {
        extension_settings[extensionName].bannedWords.splice($(this).data('index'), 1);
        saveSettingsDebounced();
        renderTags();
    });
    $(document).off('click', '#bl-deep-clean-btn').on('click', '#bl-deep-clean-btn', () => {
        if(confirm("将执行深度扫描清理数据库及缓存。屏蔽列表已锁定保护。是否继续？")) performDeepCleanse();
    });

    // --- 新增：批量添加功能的事件绑定 ---
    $(document).off('click', '#bl-batch-open-btn').on('click', '#bl-batch-open-btn', () => {
        $('#bl-batch-textarea').val(''); // 打开时清空上次输入
        $('#bl-batch-popup').fadeIn(200);
    });
    
    const closeBatchPopup = () => $('#bl-batch-popup').fadeOut(200);
    $(document).off('click', '#bl-batch-close-btn').on('click', '#bl-batch-close-btn', closeBatchPopup);
    $(document).off('click', '#bl-batch-cancel-btn').on('click', '#bl-batch-cancel-btn', closeBatchPopup);
    
    $(document).off('click', '#bl-batch-submit-btn').on('click', '#bl-batch-submit-btn', () => {
        const rawText = $('#bl-batch-textarea').val();
        if (!rawText.trim()) return closeBatchPopup(); // 空内容直接关闭
        
        // 核心解析逻辑：
        // 1. 将所有中英文单/双引号替换为空格（防止词汇粘连）
        const noQuotes = rawText.replace(/['"‘’”“”]/g, ' ');
        // 2. 按照空格、英/中文逗号、顿号、换行符进行分割
        const words = noQuotes.split(/[\s,，、\n]+/);
        
        let hasNewWord = false;
        words.forEach(w => {
            const cleanWord = w.trim();
            // 过滤空字符串并进行查重处理
            if (cleanWord && !extension_settings[extensionName].bannedWords.includes(cleanWord)) {
                extension_settings[extensionName].bannedWords.push(cleanWord);
                hasNewWord = true;
            }
        });
        
        // 如果有新词加入，执行与单独添加相同的保存、渲染和清理逻辑
        if (hasNewWord) {
            saveSettingsDebounced();
            renderTags();
            performGlobalCleanse();
        }
        closeBatchPopup();
    });

    // 监听事件
    eventSource.removeListener(event_types.MESSAGE_EDITED, performGlobalCleanse);
    eventSource.on(event_types.MESSAGE_EDITED, () => setTimeout(performGlobalCleanse, 100));
    eventSource.on(event_types.GENERATION_ENDED, performGlobalCleanse);
}

function renderTags() {
    const words = extension_settings[extensionName].bannedWords || [];
    $('#bl-tags-container').html(words.map((w, i) => `<div class="bl-tag">${w}<span data-index="${i}">&times;</span></div>`).join('') || '<div style="opacity:0.5; width:100%; text-align:center; font-size:12px;">无数据</div>');
}

let isBooted = false;
jQuery(() => {
    if (isBooted) return;
    extension_settings[extensionName] = extension_settings[extensionName] || { ...defaultSettings };
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
