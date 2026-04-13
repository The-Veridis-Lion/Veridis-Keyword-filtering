import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, saveChat, chat_metadata, chat } from "../../../../script.js";

const extensionName = "ultimate_purifier";
const defaultSettings = {
    rules: [],
    presets: {},
    activePreset: "",
    defaultPreset: "",
    characterBindings: {},
    deepCleanTimeoutSec: 120
};

let activeProcessors = [];
let isRegexDirty = true; 
let currentEditingIndex = -1; 
let currentEditingSubrules = []; 
let currentTransferRuleIndex = -1;
let lastCharacterContextKey = "";

const SIMPLE_WILDCARD_STOP_CHARS = ",，。.!?！？；;\n";

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function getCurrentCharacterContext() {
    const normalizeText = (v) => String(v || '').trim();
    const byName = (name, source = 'name') => {
        const clean = normalizeText(name);
        if (!clean) return null;
        return { key: `${source}:${clean}`, name: clean };
    };
    const byId = (id, name = '') => {
        const cleanId = normalizeText(id);
        if (!cleanId) return null;
        return { key: `chid:${cleanId}`, name: normalizeText(name) || `角色#${cleanId}` };
    };

    try {
        const chidRaw = window.this_chid;
        const chid = Number(chidRaw);
        if (Number.isInteger(chid) && chid >= 0 && Array.isArray(window.characters) && window.characters[chid]) {
            const ch = window.characters[chid];
            const name = String(ch.name || ch.ch_name || '').trim();
            return byId(chid, name);
        }
    } catch (e) { }

    const selectedCard = document.querySelector('.character_select.selected, .group_select.selected, .character_select[chid].active');
    if (selectedCard) {
        const selectedChid = selectedCard.getAttribute('chid') || selectedCard.dataset?.chid || selectedCard.dataset?.id;
        const selectedName = selectedCard.getAttribute('title') || selectedCard.dataset?.name || selectedCard.querySelector('.ch_name, .name_text, .character_name')?.textContent;
        const bySelectedId = byId(selectedChid, selectedName);
        if (bySelectedId) return bySelectedId;
        const bySelectedName = byName(selectedName, 'card');
        if (bySelectedName) return bySelectedName;
    }

    const metadataName = normalizeText(chat_metadata?.character_name || chat_metadata?.name2 || chat_metadata?.ch_name || chat_metadata?.name);
    const fromMetaName = byName(metadataName);
    if (fromMetaName) return fromMetaName;

    const chatMetaId = normalizeText(chat_metadata?.character_id || chat_metadata?.avatar || chat_metadata?.main_chat || chat_metadata?.chat_id);
    const fromMetaId = byId(chatMetaId, metadataName);
    if (fromMetaId) return fromMetaId;

    const headerName = normalizeText(
        document.querySelector('#chat_header .name_text, #rm_info_name, #chat .name_text, #selected_chat_pole .name_text')?.textContent
    );
    const fromHeader = byName(headerName, 'header');
    if (fromHeader) return fromHeader;

    const hashKey = normalizeText(window.location?.hash || '');
    if (hashKey) {
        return { key: `hash:${hashKey}`, name: `当前聊天(${hashKey.slice(0, 24)})` };
    }

    return { key: "", name: "未检测到角色（可先发送一条消息后再试）" };
}

function getPresetForCharacter(characterKey) {
    const settings = extension_settings[extensionName];
    if (!settings) return "";
    const special = settings.characterBindings?.[characterKey];
    if (special && settings.presets?.[special]) return special;
    if (settings.defaultPreset && settings.presets?.[settings.defaultPreset]) return settings.defaultPreset;
    return "";
}

// 智能分词：正则和简易模式只通过换行符切分，文本模式支持逗号和空格
function parseInputToWords(text, mode = 'text', options = {}) {
    if (!text) return [];
    const isTarget = options.isTarget !== false;
    if (mode === 'regex' || mode === 'simple') {
        const words = text.split('\n').map(w => w.trim());
        return isTarget ? words.filter(w => w) : words;
    }
    const noQuotes = text.replace(/['"‘’”“”]/g, ' ');
    const textWords = isTarget
        ? noQuotes.split(/[\s,，、\n]+/)
        : noQuotes.split(/[,\n，、]/);
    const words = textWords.map(w => w.trim());
    return isTarget ? words.filter(w => w) : words;
}

function buildSimpleWildcardPattern() {
    const escapedStops = SIMPLE_WILDCARD_STOP_CHARS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `[^${escapedStops}]{0,15}?`;
}

// 核心重构：三引擎构建 (普通/正则/简易)
function buildProcessors() {
    if (!isRegexDirty) return activeProcessors;
    const rules = extension_settings[extensionName]?.rules || [];
    
    let textTargets = [];
    let wordToReplacements = {};
    let processors = [];

    rules.forEach(rule => {
        if (rule.enabled === false) return; 
        
        const subRulesToProcess = rule.subRules || [];
        subRulesToProcess.forEach(sub => {
            const mode = sub.mode || 'text'; // 默认向下兼容文本模式

            if (mode === 'text') {
                sub.targets.forEach(t => {
                    if (t) {
                        textTargets.push(t);
                        wordToReplacements[t] = sub.replacements; 
                    }
                });
            } else if (mode === 'regex') {
                sub.targets.forEach(t => {
                    if (t) {
                        try {
                            let pattern = t;
                            let flags = 'gmu';
                            if (t.startsWith('/')) {
                                const lastSlash = t.lastIndexOf('/');
                                if (lastSlash > 0) {
                                    pattern = t.substring(1, lastSlash);
                                    flags = t.substring(lastSlash + 1);
                                    if (!flags.includes('g')) flags += 'g'; 
                                }
                            }
                            
                            // --- 防核弹补丁 (正则模式) ---
                            let testRegex = new RegExp(pattern, flags);
                            if (testRegex.test("")) {
                                console.warn("[Ultimate Purifier] 拦截到一个危险的空匹配正则，已忽略:", t);
                                return; 
                            }
                            
                            processors.push({
                                regex: testRegex,
                                replacements: sub.replacements,
                                isRegexMode: true
                            });
                        } catch(e) {
                            console.warn("[Ultimate Purifier] 忽略非法正则表达式:", t);
                        }
                    }
                });
            } else if (mode === 'simple') {
                // --- 简易积木组合引擎 ---
                sub.targets.forEach(t => {
                    if (t) {
                        try {
                            let escaped = t.replace(/[.+^$()[\]\\]/g, '\\$&');
                            
                            escaped = escaped.replace(/\{([^}]+)\}/g, (match, group) => {
                                return '(?:' + group.split(',').map(s => s.trim()).join('|') + ')';
                            });
                            
                            escaped = escaped.replace(/\*/g, buildSimpleWildcardPattern());
                            
                            // --- 防核弹补丁 (简易模式) ---
                            let testRegex = new RegExp(escaped, 'gmu');
                            if (testRegex.test("")) {
                                console.warn("[Ultimate Purifier] 拦截到一个危险的简易空匹配规则，已忽略:", t);
                                return;
                            }
                            
                            processors.push({
                                regex: testRegex,
                                replacements: sub.replacements,
                                isRegexMode: true 
                            });
                        } catch(e) {
                            console.warn("[Ultimate Purifier] 简易规则解析失败:", t);
                        }
                    }
                });
            }
        }); // 完美闭合 subRulesToProcess.forEach
    }); // 完美闭合 rules.forEach

    if (textTargets.length > 0) {
        const uniqueTargets = [...new Set(textTargets)];
        const sorted = uniqueTargets.sort((a, b) => b.length - a.length);
        const escaped = sorted.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const textRegex = new RegExp(`(${escaped.join('|')})`, 'gmu');
        
        processors.unshift({
            regex: textRegex,
            replacerMap: wordToReplacements,
            isRegexMode: false
        });
    }

    activeProcessors = processors;
    isRegexDirty = false;
    return activeProcessors;
}

function pickReplacement(replacements, deterministicKey = "") {
    if (!Array.isArray(replacements) || replacements.length === 0) return '';
    if (!deterministicKey) {
        const randIndex = Math.floor(Math.random() * replacements.length);
        return replacements[randIndex];
    }

    let hash = 0;
    for (let i = 0; i < deterministicKey.length; i++) {
        hash = ((hash << 5) - hash) + deterministicKey.charCodeAt(i);
        hash |= 0;
    }
    const idx = Math.abs(hash) % replacements.length;
    return replacements[idx];
}

function applyReplacements(originalText, options = {}) {
    if (typeof originalText !== 'string' || !originalText) return originalText;
    const deterministic = options.deterministic === true;
    let text = originalText;
    const processors = buildProcessors();

    processors.forEach((proc, procIndex) => {
        text = text.replace(proc.regex, (match, ...args) => {
            if (proc.isRegexMode) {
                const reps = proc.replacements;
                if (!reps || reps.length === 0) return ''; 
                const repKey = deterministic ? `${procIndex}|${match}` : '';
                let rep = pickReplacement(reps, repKey);
                
                rep = rep.replace(/\$(\d+)/g, (m, g) => {
                    const idx = parseInt(g);
                    return args[idx - 1] !== undefined ? args[idx - 1] : m;
                });
                return rep;
            } else {
                const reps = proc.replacerMap[match];
                if (!reps || reps.length === 0) return ''; 
                const repKey = deterministic ? `${procIndex}|${match}` : '';
                return pickReplacement(reps, repKey);
            }
        });
    });
    return text;
}

function isProtectedNode(node) {
    if (!node || !node.closest) return false;
    
    // 1. 保护插件自身的弹窗，防止自己误删自己的规则
    if (node.closest('#bl-purifier-popup, #bl-batch-popup, #bl-confirm-modal, #bl-rule-edit-modal, #bl-rule-transfer-modal')) return true;

    // 2. 保护“高级格式化”面板和“API设置”面板
    if (node.closest('#advanced_formatting, #api_settings')) return true;

    // 2.1 保护数据库插件 UI（避免误伤 shujuku_v120 界面）
    if ((node.id && node.id.includes('shujuku_v120-')) || node.closest('[id*="shujuku_v120-"]')) return true;

    // 3. 精确枚举
    const promptIds = [
        'system_prompt', 'post_history_prompt', 'floating_prompt', 
        'nsfw_prompt', 'author_note', 'jailbreak_prompt',
        'chat_completions_system_prompt', 'chat_completions_jailbreak_prompt',
        'completion_prompt_manager_popup_entry_form_prompt',
        'completion_prompt_manager_popup_entry_form_name',
        'description_textarea', 'personality_textarea', 'scenario_textarea', 
        'mes_example_textarea', 'first_mes_textarea', 'creator_notes_textarea'
    ];
    if (node.id && promptIds.includes(node.id)) return true;
    
    // 世界书
    if (node.id && node.id.startsWith('world_entry_content_')) return true;
    if (node.tagName === 'TEXTAREA' && node.name === 'comment') return true;

    // 除此之外一律不保护！
    return false;
}

function shouldSkipDbExtensionField(pathKeys = [], isGlobalSettings = false) {
    if (!isGlobalSettings || pathKeys.length < 2) return false;
    const rootNamespace = String(pathKeys[0] || '');
    if (!rootNamespace.includes('shujuku_v120')) return false;

    const currentKey = String(pathKeys[pathKeys.length - 1] || '');
    return /(Prompt|Settings|Template)/.test(currentKey);
}

function deepCleanObjectSync(rootObj) {
    if (!rootObj || typeof rootObj !== 'object') return 0;
    let changes = 0;
    const stack = [rootObj];
    const seen = new Set();

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current || seen.has(current)) continue;
        seen.add(current);

        for (let key in current) {
            if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
            const val = current[key];
            if (typeof val === 'string') {
                const cleaned = applyReplacements(val);
                if (cleaned !== val) {
                    current[key] = cleaned;
                    changes++;
                }
            } else if (val && typeof val === 'object') {
                stack.push(val);
            }
        }
    }
    return changes;
}

// 改为 async 异步，加入防卡死机制
async function safeDeepScrub(rootObj, isGlobalSettings = false, options = {}) {
    let changes = 0;
    if (!rootObj || typeof rootObj !== 'object') return changes;
    const stack = [{ node: rootObj, path: [] }];
    const seen = new Set();
    buildProcessors();

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const deadline = Number.isFinite(options.deadline) ? options.deadline : Infinity;
    let iterations = 0;

    while (stack.length > 0) {
        if (Date.now() > deadline) throw new Error('DEEP_CLEAN_TIMEOUT');

        if (++iterations % 500 === 0) {
            if (onProgress) onProgress({ visited: seen.size, pending: stack.length, changes });
            await new Promise(r => setTimeout(r, 0));
        }

        const currentItem = stack.pop();
        const current = currentItem?.node;
        const path = currentItem?.path || [];
        if (!current || seen.has(current)) continue;
        seen.add(current);

        try {
            for (let key in current) {
                if (Object.prototype.hasOwnProperty.call(current, key)) {
                    if (isGlobalSettings && key === extensionName) continue;
                    const keyPath = [...path, key];
                    if (shouldSkipDbExtensionField(keyPath, isGlobalSettings)) continue;
                    const val = current[key];
                    if (typeof val === 'string') {
                        const cleaned = applyReplacements(val);
                        if (val !== cleaned) {
                            current[key] = cleaned;
                            changes++;
                        }
                    } else if (val !== null && typeof val === 'object') {
                        stack.push({ node: val, path: keyPath });
                    }
                }
            }
        } catch (e) { }
    }

    if (onProgress) onProgress({ visited: seen.size, pending: stack.length, changes });
    return changes;
}

function getDeepCleanTimeoutMs() {
    const raw = Number(extension_settings[extensionName]?.deepCleanTimeoutSec);
    const safeSeconds = Number.isFinite(raw) ? Math.min(Math.max(raw, 10), 1800) : defaultSettings.deepCleanTimeoutSec;
    return safeSeconds * 1000;
}

function showDeepCleanOverlay() {
    $('body').append(`
        <div id="bl-loading-overlay" class="bl-loading-overlay">
            <h2 class="bl-loading-title"><i class="fas fa-spinner fa-spin"></i> 正在执行全方位深度清理 (包含角色卡与世界书)...</h2>
            <p id="bl-loading-status">正在初始化清理任务，请稍候。</p>
            <div class="bl-progress-track">
                <div id="bl-progress-fill" class="bl-progress-fill"></div>
            </div>
            <p id="bl-progress-percent" class="bl-progress-percent">0%</p>
        </div>
    `);
}

function updateDeepCleanOverlay(progressRatio, statusText) {
    const ratio = Math.max(0, Math.min(1, Number(progressRatio) || 0));
    $('#bl-progress-fill').css('width', `${Math.round(ratio * 100)}%`);
    $('#bl-progress-percent').text(`${Math.round(ratio * 100)}%`);
    if (statusText) $('#bl-loading-status').text(statusText);
}

// 所有的 safeDeepScrub 调用加上 await
async function performDeepCleanse() {
    buildProcessors();
    if (activeProcessors.length === 0) {
        alert('没有开启的屏蔽规则，无需清理。');
        return;
    }

    showDeepCleanOverlay();
    await new Promise(r => setTimeout(r, 100));

    try {
        let scrubbedItems = 0;
        const timeoutMs = getDeepCleanTimeoutMs();
        const startAt = Date.now();
        const deadline = startAt + timeoutMs;

        const phases = [];
        if (chat && Array.isArray(chat)) phases.push({ label: '聊天记录', root: chat, isGlobalSettings: false });
        if (typeof chat_metadata === 'object' && chat_metadata !== null) phases.push({ label: '聊天元数据', root: chat_metadata, isGlobalSettings: false });
        if (typeof extension_settings === 'object' && extension_settings !== null) phases.push({ label: '插件设置', root: extension_settings, isGlobalSettings: true });
        if (typeof window.characters !== 'undefined' && Array.isArray(window.characters)) phases.push({ label: '角色卡', root: window.characters, isGlobalSettings: false });
        if (typeof window.world_info !== 'undefined' && window.world_info !== null) phases.push({ label: '世界书', root: window.world_info, isGlobalSettings: false });
        if (typeof window.power_user !== 'undefined' && window.power_user !== null && window.power_user.personas) phases.push({ label: '人设', root: window.power_user.personas, isGlobalSettings: false });

        for (let i = 0; i < phases.length; i++) {
            const phase = phases[i];
            const phaseBase = i / phases.length;
            const phaseSpan = 1 / phases.length;

            scrubbedItems += await safeDeepScrub(phase.root, phase.isGlobalSettings, {
                deadline,
                onProgress: ({ visited, pending, changes }) => {
                    const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
                    const dynamic = (visited + pending > 0) ? (visited / (visited + pending)) : 0;
                    updateDeepCleanOverlay(
                        phaseBase + dynamic * phaseSpan,
                        `正在清理 ${phase.label}（已扫描 ${visited}，剩余队列 ${pending}，命中 ${changes}）｜耗时 ${elapsed}s / 超时 ${Math.round(timeoutMs / 1000)}s`
                    );
                }
            });

            updateDeepCleanOverlay((i + 1) / phases.length, `已完成 ${phase.label}，准备进入下一阶段...`);
        }

        updateDeepCleanOverlay(0.97, '正在同步数据到磁盘，请稍候。');

        if (scrubbedItems > 0) {
            const saveChatPromise = saveChat();
            if (saveChatPromise instanceof Promise) await saveChatPromise;

            saveSettingsDebounced();
            const remainingMs = Math.max(300, Math.min(2000, deadline - Date.now()));
            await new Promise(r => setTimeout(r, remainingMs));

            updateDeepCleanOverlay(1, '清理完成，正在准备刷新页面...');
            await new Promise(r => setTimeout(r, 180));
            $('#bl-loading-overlay').remove();

            alert(`清理完成，共处理 ${scrubbedItems} 处匹配项。

页面即将刷新，请在刷新后将系统预设切换回常用预设！`);
            location.reload();
        } else {
            updateDeepCleanOverlay(1, '未发现残留，任务结束。');
            await new Promise(r => setTimeout(r, 260));
            $('#bl-loading-overlay').remove();
            alert('未发现需要替换的数据残留。');
        }
    } catch (e) {
        console.error('[Ultimate Purifier] 深度清理出错:', e);
        $('#bl-loading-overlay').remove();
        if (e && e.message === 'DEEP_CLEAN_TIMEOUT') {
            const timeoutSec = Math.round(getDeepCleanTimeoutMs() / 1000);
            alert(`清理超时（${timeoutSec}s）已自动中止。
建议减少规则范围或调大 deepCleanTimeoutSec 后重试。`);
        } else {
            alert('清理失败，请查看控制台。');
        }
    }
}

function purifyDOM(rootNode) {
    if (!rootNode) return;
    // 强行合并手机端流式输出时碎裂的文本节点
    try { if (rootNode.normalize) rootNode.normalize(); } catch (e) { }
    buildProcessors();
    if (activeProcessors.length === 0) return;

    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT, null, false);

    let node;
    while (node = walker.nextNode()) {
        const parent = node.parentNode;
        if (parent && (isProtectedNode(parent) || (document.activeElement && (document.activeElement === parent || parent.contains(document.activeElement))))) {
            continue;
        }

        const original = node.nodeValue || '';
        const cleaned = applyReplacements(original, { deterministic: true });
        if (original !== cleaned) node.nodeValue = cleaned;
    }

    if (rootNode.nodeType === 1) {
        let inputs = [];
        if (rootNode.matches && rootNode.matches('input, textarea')) inputs.push(rootNode);
        if (rootNode.querySelectorAll) inputs.push(...Array.from(rootNode.querySelectorAll('input, textarea')));

        inputs.forEach(input => {
            if (isProtectedNode(input) || document.activeElement === input) return;
            const originalVal = input.value || '';
            const cleanedVal = applyReplacements(originalVal, { deterministic: true });
            if (originalVal !== cleanedVal) input.value = cleanedVal;
        });
    }
}

function performGlobalCleanse() {
    buildProcessors();
    if (activeProcessors.length === 0) return;
    let chatChanged = false;

    if (chat && Array.isArray(chat)) {
        chat.forEach((msg, index) => {
            let msgChanged = false;

            if (typeof msg.mes === 'string') {
                const cleaned = applyReplacements(msg.mes);
                if (msg.mes !== cleaned) {
                    msg.mes = cleaned;
                    msgChanged = true;
                }
            }

            if (msg.swipes && Array.isArray(msg.swipes)) {
                for (let i = 0; i < msg.swipes.length; i++) {
                    if (typeof msg.swipes[i] === 'string') {
                        const cleanedSwipe = applyReplacements(msg.swipes[i]);
                        if (msg.swipes[i] !== cleanedSwipe) {
                            msg.swipes[i] = cleanedSwipe;
                            msgChanged = true;
                        }
                    } else if (typeof msg.swipes[i] === 'object' && msg.swipes[i] !== null && typeof msg.swipes[i].mes === 'string') {
                        const cleanedSwipe = applyReplacements(msg.swipes[i].mes);
                        if (msg.swipes[i].mes !== cleanedSwipe) {
                            msg.swipes[i].mes = cleanedSwipe;
                            msgChanged = true;
                        }
                    }
                }
            }

            if (msgChanged) {
                chatChanged = true;
                try {
                    if (typeof updateMessageBlock === 'function') {
                        setTimeout(() => updateMessageBlock(index, chat[index]), 50);
                    }
                } catch (e) { }
            }
        });

        const latestMsg = chat.length > 0 ? chat[chat.length - 1] : null;
        if (latestMsg && typeof latestMsg === 'object') {
            ['TavernDB_ACU_Data', 'TavernDB_ACU_SummaryData'].forEach((dbKey) => {
                const dbVal = latestMsg[dbKey];
                if (dbVal && typeof dbVal === 'object') {
                    const dbChanges = deepCleanObjectSync(dbVal);
                    if (dbChanges > 0) chatChanged = true;
                }
            });
        }
    }

    if (chatChanged) {
        try {
            if (typeof saveChat === 'function') saveChat();
        } catch (e) {
            console.error("[Ultimate Purifier] 存盘失败", e);
        }
    }
    purifyDOM(document.getElementById('chat'));
}

// 引入 isPurifying 锁机制
function initRealtimeInterceptor() {
    let isPurifying = false; // 全局防死循环锁

    const chatObserver = new MutationObserver((mutations) => {
        if (isPurifying) return; // 如果是插件自己发起的修改，直接忽略，避免死循环

        buildProcessors();
        if (activeProcessors.length === 0) return;

        isPurifying = true; // 上锁
        try {
            mutations.forEach(m => {
                m.addedNodes.forEach(node => {
                    if (node.nodeType === 3 || node.nodeType === 8) { 
                        if (node.parentNode && isProtectedNode(node.parentNode)) return;
                        const cleaned = applyReplacements(node.nodeValue, { deterministic: true });
                        if (node.nodeValue !== cleaned) node.nodeValue = cleaned;
                    } else if (node.nodeType === 1) { 
                        purifyDOM(node);
                    }
                });
                if (m.type === 'characterData') {
                    if (m.target.parentNode && isProtectedNode(m.target.parentNode)) return;
                    const cleaned = applyReplacements(m.target.nodeValue, { deterministic: true });
                    if (m.target.nodeValue !== cleaned) m.target.nodeValue = cleaned;
                }
            });
        } finally {
            isPurifying = false; // 执行完解锁
        }
    });
    
    // 监听酒馆主聊天框 
    const chatEl = document.getElementById('chat');
    if (chatEl) chatObserver.observe(chatEl, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value'] });

    // 回声小剧场的 Shadow DOM
    let currentTheaterShadow = null;
    setInterval(() => {
        const theaterHost = document.querySelector('#t-output-content .t-shadow-host');
        if (theaterHost && theaterHost.shadowRoot) {
            if (currentTheaterShadow !== theaterHost) {
                chatObserver.observe(theaterHost.shadowRoot, { childList: true, subtree: true, characterData: true });
                currentTheaterShadow = theaterHost;
                
                isPurifying = true; // 对刚打开的结界清洗时也要上锁
                try {
                    purifyDOM(theaterHost.shadowRoot);
                } finally {
                    isPurifying = false;
                }
            }
        } else {
            currentTheaterShadow = null;
        }
    }, 800); 

    document.addEventListener('input', (e) => {
        const el = e.target;
        if (!['TEXTAREA', 'INPUT'].includes(el.tagName)) return;
        if (isProtectedNode(el)) return;

        buildProcessors();
        if (activeProcessors.length === 0) return;

        const originalVal = el.value || '';
        const cleanedVal = applyReplacements(originalVal, { deterministic: true });
        
        if (originalVal !== cleanedVal) {
            const start = el.selectionStart;
            
            isPurifying = true; // 上锁
            try {
                el.value = cleanedVal;
                try { el.setSelectionRange(start, start); } catch(err){}
            } finally {
                isPurifying = false;
            }
        }
    }, true);
}

function setupUI() {
    $('#bl-purifier-popup, #bl-rule-edit-modal, #bl-confirm-modal, #bl-rule-transfer-modal').remove();

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
                <div style="display:flex; gap:8px; align-items:center;">
                    <button id="bl-default-toggle" title="设为默认预设（未单独绑定角色时自动使用）" class="bl-icon-btn bl-bind-toggle"><i class="fas fa-star"></i></button>
                    <button id="bl-character-bind-toggle" title="将当前角色绑定到当前预设" class="bl-icon-btn bl-bind-toggle"><i class="fas fa-link-slash"></i></button>
                    <select id="bl-preset-select" style="flex:1; padding:9px 12px; min-height:38px; border-radius:6px; border:1px solid var(--bl-border-color); background:var(--bl-input-bg); color:var(--bl-text-primary); outline:none; font-family:inherit;"></select>
                    <button id="bl-preset-rename" title="重命名存档" class="bl-icon-btn"><i class="fas fa-pen"></i></button>
                    <button id="bl-preset-delete" title="删除存档" class="bl-icon-btn" style="color:var(--bl-danger-color);"><i class="fas fa-trash"></i></button>
                </div>
                <div style="display:flex; gap:8px;">
                    <button class="bl-tool-btn" id="bl-preset-new"><i class="fas fa-plus"></i> 新建</button>
                    <button class="bl-tool-btn" id="bl-preset-save"><i class="fas fa-save"></i> 保存</button>
                    <button class="bl-tool-btn" id="bl-preset-import"><i class="fas fa-file-import"></i> 导入</button>
                    <button class="bl-tool-btn" id="bl-preset-export"><i class="fas fa-file-export"></i> 导出</button>
                </div>
            </div>

            <button id="bl-open-new-rule-btn" class="bl-add-rule-btn" style="width:100%; margin-bottom:10px;"><i class="fas fa-folder-plus"></i> 新增规则组 (合集)</button>

            <div id="bl-tags-container" style="max-height:220px; overflow-y:auto; padding-right:5px;"></div>
            
            <div class="bl-footer">
                <button id="bl-deep-clean-btn" class="bl-deep-clean-btn"><i class="fas fa-broom"></i> 深度屏蔽与替换</button>
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
                
                <div id="bl-edit-subrules-container" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding-right:5px; margin-bottom:10px;">
                </div>
                
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
}

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

function applyPresetByName(name, options = {}) {
    const settings = extension_settings[extensionName];
    const presetName = String(name || '');
    const presetExists = !!(presetName && settings.presets?.[presetName]);
    settings.activePreset = presetExists ? presetName : "";
    settings.rules = presetExists ? deepClone(settings.presets[presetName]) : [];
    isRegexDirty = true;
    saveSettingsDebounced();
    if (!options.skipRender) {
        updateToolbarUI();
        renderTags();
    }
    if (!options.skipCleanse) performGlobalCleanse();
}

function cleanupInvalidPresetBindings() {
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

function refreshCharacterBindingUI() {
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
        $defaultBtn.attr('title', activePreset
            ? (isDefaultActive ? `已设为默认预设：${activePreset}（点击取消）` : `将当前预设设为默认：${activePreset}`)
            : '请先选择一个预设'
        );

        const isCharacterBound = !!(context.key && activePreset && currentBound === activePreset);
        $bindBtn.toggleClass('bl-bind-active', isCharacterBound);
        $bindBtn.prop('disabled', !activePreset || !context.key);
        $bindBtn.find('i')
            .removeClass('fa-link fa-link-slash')
            .addClass(isCharacterBound ? 'fa-link' : 'fa-link-slash');
        $bindBtn.attr('title',
            !activePreset ? '请先选择一个预设'
            : !context.key ? '未检测到当前角色，无法绑定'
            : (isCharacterBound
                ? `已绑定：${context.name} → ${activePreset}（点击解除）`
                : `绑定当前角色：${context.name} → ${activePreset}`)
        );
    }

}

function applyCharacterPresetBinding(force = false) {
    const context = getCurrentCharacterContext();
    if (!context.key) {
        lastCharacterContextKey = "";
        refreshCharacterBindingUI();
        return;
    }

    const characterChanged = context.key !== lastCharacterContextKey;
    if (!force && !characterChanged) return;
    lastCharacterContextKey = context.key;

    const presetName = getPresetForCharacter(context.key);
    if (presetName && presetName !== extension_settings[extensionName].activePreset) {
        applyPresetByName(presetName, { skipRender: true });
    }
    refreshCharacterBindingUI();
}

function updateToolbarUI() {
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

function renderTags() {
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
            if(!rPreview) rPreview = '【直接删除】';
            
            subRulesHtml += `
            <div style="display:flex; align-items:center; margin-bottom:5px; overflow:hidden; white-space:nowrap;">
                ${badgeHTML} 
                <b style="color:var(--bl-text-primary); margin-right:4px; overflow:hidden; text-overflow:ellipsis; max-width:55%;">${tPreview}</b> 
                <i class="fas fa-arrow-right" style="font-size:10px; margin:0 6px; opacity:0.6; flex-shrink:0;"></i> 
                <span style="overflow:hidden; text-overflow:ellipsis; flex:1;">${rPreview}</span>
            </div>`;
        });
        
        if ((r.subRules || []).length > maxPreview) {
             subRulesHtml += `<div style="font-size:11px; margin-top:6px; color:var(--bl-text-secondary); opacity:0.8; text-align:center;">... 以及其他 ${(r.subRules||[]).length - maxPreview} 组映射</div>`;
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
                        ${name} <span style="font-size:11px; font-weight:normal; opacity:0.7;">(${(r.subRules||[]).length}组)</span>
                    </div>
                </div>
                <div class="bl-rule-actions" style="flex-shrink:0;">
                    <button class="bl-rule-transfer" data-index="${i}" title="复制/转移到其他存档"><i class="fas fa-copy"></i></button>
                    <button class="bl-rule-edit" data-index="${i}" title="编辑合集"><i class="fas fa-pen"></i></button>
                    <button class="bl-rule-del" data-index="${i}" title="删除合集"><i class="fas fa-trash"></i></button>
                </div>
            </div>
            <div class="bl-rule-preview">
                ${subRulesHtml}
            </div>
        </div>`;
    }).join('');
    
    $('#bl-tags-container').html(html || '<div style="opacity:0.5; width:100%; text-align:center; font-size:13px; padding: 20px 0;">当前无规则，请点击上方按钮新增</div>');
}

function renderSubrulesToModal() {
    const container = $('#bl-edit-subrules-container');
    container.empty();
    
    if (currentEditingSubrules.length === 0) {
        container.html('<div style="text-align:center; color:var(--bl-text-secondary); font-size:12px; padding:10px;">当前合集没有映射规则，请点击下方按钮添加。</div>');
        return;
    }
    
    currentEditingSubrules.forEach((sub, i) => {
        const mode = sub.mode || 'text';
        const isEditing = sub.isEditing !== false; 

        if (!isEditing) {
            let badgeHTML = '';
            if (mode === 'regex') badgeHTML = '<span class="bl-badge bl-badge-regex">正则</span>';
            else if (mode === 'simple') badgeHTML = '<span class="bl-badge bl-badge-simple" style="background:#0984e3; color:white;">简易</span>';
            else badgeHTML = '<span class="bl-badge bl-badge-text">普通</span>';
            
            let tPreview = sub.targets.join(mode === 'text' ? ', ' : ' | ');
            
            let rPreview = sub.replacements.join(', ');
            if(!rPreview) rPreview = '【直接删除】';

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

            let tPlaceholder, rPlaceholder;
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

function syncSubrulesFromDOM() {
    $('.bl-subrule-row').each(function() {
        const index = $(this).find('.bl-save-subrule-btn').data('index');
        const mode = $(this).find('.bl-sub-mode').val();
        const tStr = $(this).find('.bl-sub-target').val();
        const rStr = $(this).find('.bl-sub-rep').val();
        
        currentEditingSubrules[index].mode = mode;
        currentEditingSubrules[index].targets = parseInputToWords(tStr, mode, { isTarget: true });
        currentEditingSubrules[index].replacements = parseInputToWords(rStr, mode === 'text' ? 'text' : 'regex', { isTarget: false });
    });
}

function openTransferModal(ruleIndex) {
    const settings = extension_settings[extensionName];
    const presets = settings?.presets || {};
    const currentPreset = settings?.activePreset || "";
    const targetNames = Object.keys(presets).filter(name => name !== currentPreset);
    if (targetNames.length === 0) {
        alert('没有可用的目标存档。请先创建至少一个其他存档。');
        return;
    }

    currentTransferRuleIndex = ruleIndex;
    const $select = $('#bl-transfer-target');
    $select.empty();
    targetNames.forEach(name => {
        $select.append($('<option>', { value: name, text: name }));
    });

    $('#bl-rule-transfer-modal').css('display', 'flex');
}

function closeTransferModal() {
    currentTransferRuleIndex = -1;
    $('#bl-rule-transfer-modal').hide();
}

function runRuleTransfer(isMove) {
    const settings = extension_settings[extensionName];
    const targetPreset = String($('#bl-transfer-target').val() || '');
    if (currentTransferRuleIndex < 0) return;
    if (!targetPreset) {
        alert('请选择目标存档。');
        return;
    }

    const sourceRules = settings.rules || [];
    const selectedRule = sourceRules[currentTransferRuleIndex];
    if (!selectedRule) {
        closeTransferModal();
        return;
    }

    if (!Array.isArray(settings.presets[targetPreset])) {
        settings.presets[targetPreset] = [];
    }
    settings.presets[targetPreset].push(JSON.parse(JSON.stringify(selectedRule)));

    if (isMove) {
        sourceRules.splice(currentTransferRuleIndex, 1);
    }

    isRegexDirty = true;
    closeTransferModal();
    saveSettingsDebounced();
    renderTags();
}

function openEditModal(index = -1) {
    const settings = extension_settings[extensionName];
    currentEditingIndex = index;
    const modal = $('#bl-rule-edit-modal');
    
    if (index === -1) {
        $('#bl-edit-modal-title').html('<i class="fas fa-folder-plus"></i> 新增规则合集');
        $('#bl-edit-name').val('');
        currentEditingSubrules = [{ targets: [], replacements: [], mode: 'simple', isEditing: true }];
    } else {
        const rule = settings.rules[index];
        $('#bl-edit-modal-title').html('<i class="fas fa-pen"></i> 编辑规则合集');
        $('#bl-edit-name').val(rule.name || '');
        currentEditingSubrules = JSON.parse(JSON.stringify(rule.subRules || []));
        currentEditingSubrules.forEach(sub => sub.isEditing = false); 
    }
    
    renderSubrulesToModal();
    modal.css('display', 'flex');
}

function bindEvents() {
    $(document).off('click', '#bl-wand-btn').on('click', '#bl-wand-btn', () => { 
        updateToolbarUI(); 
        renderTags(); 
        $('#bl-purifier-popup').css('display', 'flex').hide().fadeIn(200); 
    });
    
    $(document).off('click', '#bl-close-btn').on('click', '#bl-close-btn', () => {
        $('#bl-purifier-popup').fadeOut(200);
    });
    
    $(document).off('click', '#bl-open-new-rule-btn').on('click', '#bl-open-new-rule-btn', () => openEditModal(-1));
    
    $(document).off('click', '.bl-rule-edit').on('click', '.bl-rule-edit', function() {
        openEditModal($(this).data('index'));
    });

    $(document).off('click', '.bl-rule-transfer').on('click', '.bl-rule-transfer', function() {
        openTransferModal($(this).data('index'));
    });
    
    $(document).off('change', '.bl-rule-toggle').on('change', '.bl-rule-toggle', function() {
        const index = $(this).data('index');
        extension_settings[extensionName].rules[index].enabled = $(this).prop('checked');
        isRegexDirty = true;
        saveSettingsDebounced();
        renderTags();
        performGlobalCleanse();
    });
    
    $(document).off('click', '.bl-rule-del').on('click', '.bl-rule-del', function() {
        extension_settings[extensionName].rules.splice($(this).data('index'), 1);
        isRegexDirty = true;
        saveSettingsDebounced();
        renderTags();
    });

    $(document).off('click', '#bl-add-subrule-btn').on('click', '#bl-add-subrule-btn', () => {
        syncSubrulesFromDOM();
        currentEditingSubrules.push({ targets: [], replacements: [], mode: 'simple', isEditing: true });
        renderSubrulesToModal();
        const container = $('#bl-edit-subrules-container');
        container.scrollTop(container[0].scrollHeight);
    });
    
    $(document).off('click', '.bl-edit-subrule-btn').on('click', '.bl-edit-subrule-btn', function() {
        syncSubrulesFromDOM();
        currentEditingSubrules[$(this).data('index')].isEditing = true;
        renderSubrulesToModal();
    });

    $(document).off('click', '.bl-save-subrule-btn').on('click', '.bl-save-subrule-btn', function() {
        syncSubrulesFromDOM();
        currentEditingSubrules[$(this).data('index')].isEditing = false;
        renderSubrulesToModal();
    });

    $(document).off('change', '.bl-sub-mode').on('change', '.bl-sub-mode', function() {
        const idx = $(this).closest('.bl-subrule-row').find('.bl-save-subrule-btn').data('index');
        syncSubrulesFromDOM();
        currentEditingSubrules[idx].mode = $(this).val();
        renderSubrulesToModal();
    });

    $(document).off('click', '.bl-del-subrule-btn').on('click', '.bl-del-subrule-btn', function() {
        syncSubrulesFromDOM();
        currentEditingSubrules.splice($(this).data('index'), 1);
        renderSubrulesToModal();
    });

    $(document).off('click', '#bl-edit-cancel').on('click', '#bl-edit-cancel', () => {
        $('#bl-rule-edit-modal').hide();
    });

    $(document).off('click', '#bl-transfer-cancel').on('click', '#bl-transfer-cancel', () => closeTransferModal());
    $(document).off('click', '#bl-transfer-copy').on('click', '#bl-transfer-copy', () => runRuleTransfer(false));
    $(document).off('click', '#bl-transfer-move').on('click', '#bl-transfer-move', () => runRuleTransfer(true));
    $(document).off('click', '#bl-rule-transfer-modal').on('click', '#bl-rule-transfer-modal', function(e) {
        if (e.target && e.target.id === 'bl-rule-transfer-modal') closeTransferModal();
    });

    $(document).off('click', '#bl-edit-save').on('click', '#bl-edit-save', () => {
        syncSubrulesFromDOM();
        const nameVal = $('#bl-edit-name').val().trim();
        
        const validSubrules = currentEditingSubrules.filter(sub => sub.targets.length > 0);
        if (validSubrules.length === 0) {
            alert("至少需要提供一组有效的目标词！(被替换词不能全空)");
            return;
        }

        validSubrules.forEach(sub => delete sub.isEditing);

        let isEnabled = true;
        if (currentEditingIndex !== -1) {
            isEnabled = extension_settings[extensionName].rules[currentEditingIndex].enabled !== false;
        }

        const newRule = {
            name: nameVal || `合集 ${extension_settings[extensionName].rules.length + 1}`,
            subRules: validSubrules,
            enabled: isEnabled 
        };

        if (currentEditingIndex === -1) {
            extension_settings[extensionName].rules.push(newRule);
        } else {
            extension_settings[extensionName].rules[currentEditingIndex] = newRule;
        }

        isRegexDirty = true; 
        saveSettingsDebounced();
        renderTags();
        performGlobalCleanse();
        $('#bl-rule-edit-modal').hide();
    });

    $(document).off('click', '#bl-deep-clean-btn').on('click', '#bl-deep-clean-btn', () => {
        showConfirmModal();
    });

    $(document).off('change', '#bl-preset-select').on('change', '#bl-preset-select', function() {
        const name = $(this).val();
        applyPresetByName(name, { skipRender: true });
        renderTags();
        refreshCharacterBindingUI();
    });

    $(document).off('click', '#bl-default-toggle').on('click', '#bl-default-toggle', function() {
        const settings = extension_settings[extensionName];
        const activePreset = String(settings.activePreset || '');
        if (!activePreset) {
            alert('请先在下拉框中选择一个预设。');
            return;
        }
        settings.defaultPreset = settings.defaultPreset === activePreset ? "" : activePreset;
        saveSettingsDebounced();
        refreshCharacterBindingUI();
    });

    $(document).off('click', '#bl-character-bind-toggle').on('click', '#bl-character-bind-toggle', function() {
        const settings = extension_settings[extensionName];
        const activePreset = String(settings.activePreset || '');
        if (!activePreset) {
            alert('请先在下拉框中选择一个预设。');
            return;
        }
        const context = getCurrentCharacterContext();
        if (!context.key) {
            alert('当前页面未识别到可绑定角色。请进入单角色聊天后再绑定。');
            refreshCharacterBindingUI();
            return;
        }
        if (!settings.characterBindings) settings.characterBindings = {};
        const isCurrentlyBound = settings.characterBindings[context.key] === activePreset;
        if (isCurrentlyBound) delete settings.characterBindings[context.key];
        else settings.characterBindings[context.key] = activePreset;

        lastCharacterContextKey = context.key;
        if (!isCurrentlyBound) applyPresetByName(activePreset, { skipRender: true });
        else applyCharacterPresetBinding(true);

        saveSettingsDebounced();
        refreshCharacterBindingUI();
    });

    $(document).off('click', '#bl-preset-rename').on('click', '#bl-preset-rename', function() {
        const settings = extension_settings[extensionName];
        const oldName = settings.activePreset;
        if (!oldName) { alert("当前为临时规则，请先新建存档。"); return; }
        const newName = prompt("输入新存档名称：", oldName);
        if (!newName || newName === oldName) return;
        if (settings.presets[newName]) { alert("存档名称已存在。"); return; }
        settings.presets[newName] = settings.presets[oldName];
        delete settings.presets[oldName];
        if (settings.defaultPreset === oldName) settings.defaultPreset = newName;
        Object.keys(settings.characterBindings || {}).forEach((key) => {
            if (settings.characterBindings[key] === oldName) settings.characterBindings[key] = newName;
        });
        settings.activePreset = newName;
        saveSettingsDebounced();
        updateToolbarUI();
    });

    $(document).off('click', '#bl-preset-delete').on('click', '#bl-preset-delete', function() {
        const settings = extension_settings[extensionName];
        const name = settings.activePreset;
        if (!name) return;
        if (confirm(`确定删除存档 "${name}" 吗？`)) {
            delete settings.presets[name];
            if (settings.defaultPreset === name) settings.defaultPreset = "";
            Object.keys(settings.characterBindings || {}).forEach((key) => {
                if (settings.characterBindings[key] === name) delete settings.characterBindings[key];
            });
            settings.activePreset = "";
            settings.rules = [];
            isRegexDirty = true;
            saveSettingsDebounced();
            renderTags();
            updateToolbarUI();
            performGlobalCleanse();
        }
    });

    $(document).off('click', '#bl-preset-new').on('click', '#bl-preset-new', function() {
        const settings = extension_settings[extensionName];
        const name = prompt("输入新存档名称：");
        if (!name) return;
        if (settings.presets[name]) { alert("存档名称已存在。"); return; }
        settings.presets[name] = JSON.parse(JSON.stringify(settings.rules));
        settings.activePreset = name;
        saveSettingsDebounced();
        updateToolbarUI();
    });

    $(document).off('click', '#bl-preset-save').on('click', '#bl-preset-save', function() {
        const settings = extension_settings[extensionName];
        if (!settings.activePreset) { alert("当前为临时规则，请点击“新建”保存为新存档。"); return; }
        settings.presets[settings.activePreset] = JSON.parse(JSON.stringify(settings.rules));
        saveSettingsDebounced();
        alert("已保存到存档：" + settings.activePreset);
    });

    $(document).off('click', '#bl-preset-export').on('click', '#bl-preset-export', function() {
        const settings = extension_settings[extensionName];
        const data = JSON.stringify(settings.rules, null, 2);
        const blob = new Blob([data], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (settings.activePreset || "临时规则") + ".json";
        a.click();
        URL.revokeObjectURL(url);
    });

// 兼容老版本的对象结构
    $(document).off('click', '#bl-preset-import').on('click', '#bl-preset-import', function() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = event => {
                try {
                    let importedRules = JSON.parse(event.target.result);
                    
                    // 新增兼容性修复：如果导入的是包含 rules 数组的旧版本对象，尝试提取它
                    if (typeof importedRules === 'object' && !Array.isArray(importedRules) && importedRules.rules) {
                        importedRules = importedRules.rules;
                    }

                    if (!Array.isArray(importedRules)) throw new Error("格式非数组");
                    
                    const defaultName = file.name.replace(/\.json$/i, '');
                    const newName = prompt("导入成功！\n输入存档名称直接保存，或点击取消仅作为临时规则预览：", defaultName);
                    
                    const settings = extension_settings[extensionName];
                    
                    importedRules.forEach((r, idx) => {
                        if (!r.name) r.name = r.targets?.[0] || `未命名合集 ${idx+1}`;
                        if (r.enabled === undefined) r.enabled = true;
                        if (r.targets) {
                            r.subRules = [{ targets: r.targets, replacements: r.replacements || [], mode: 'text' }];
                            delete r.targets; delete r.replacements;
                        }
                        if (!r.subRules) r.subRules = [];
                        r.subRules.forEach(sub => { if(!sub.mode) sub.mode = 'text'; });
                    });
                    
                    settings.rules = importedRules;
                    
                    if (newName) {
                        settings.presets[newName] = JSON.parse(JSON.stringify(importedRules));
                        settings.activePreset = newName;
                    } else {
                        settings.activePreset = "";
                    }
                    
                    isRegexDirty = true;
                    saveSettingsDebounced();
                    renderTags();
                    updateToolbarUI();
                    performGlobalCleanse();
                } catch (err) {
                    alert("导入失败：检查文件是否为合法规则数组。");
                }
            };
            reader.readAsText(file);
        };
        input.click();
    });

    const visualCleanseOnly = () => { purifyDOM(document.getElementById('chat')); };
    const delayedFullCleanse = () => setTimeout(performGlobalCleanse, 1000); 
    
    if (event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, visualCleanseOnly);      
    if (event_types.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, delayedFullCleanse); 
    if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, delayedFullCleanse); 
    if (event_types.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, delayedFullCleanse); 
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, delayedFullCleanse);      
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            applyCharacterPresetBinding(true);
            delayedFullCleanse();
        });
    }

    setInterval(() => {
        applyCharacterPresetBinding(false);
    }, 1200);
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
        isRegexDirty = true;
    }

    if (settings) {
        ensureSettingsShape();

        if (settings.rules && settings.rules.length > 0) {
            settings.rules.forEach((r, i) => {
                if (!r.name) r.name = `合集 ${i+1}`; 
                if (r.enabled === undefined) r.enabled = true; 
                
                if (r.targets) {
                    r.subRules = [{
                        targets: r.targets,
                        replacements: r.replacements || [],
                        mode: 'text'
                    }];
                    delete r.targets;
                    delete r.replacements;
                }
                if (!r.subRules) r.subRules = [];
                r.subRules.forEach(sub => { if(!sub.mode) sub.mode = 'text'; });
            });
            
            if (Object.keys(settings.presets).length === 0) {
                settings.presets["默认存档"] = JSON.parse(JSON.stringify(settings.rules));
                settings.activePreset = "默认存档";
            }
        }
        saveSettingsDebounced();
    }
}

function ensureSettingsShape() {
    const settings = extension_settings[extensionName];
    if (!settings) return;
    if (!settings.rules) settings.rules = [];
    if (!settings.presets) settings.presets = {};
    if (settings.activePreset === undefined) settings.activePreset = "";
    if (settings.defaultPreset === undefined) settings.defaultPreset = "";
    if (!settings.characterBindings || typeof settings.characterBindings !== 'object') settings.characterBindings = {};
    cleanupInvalidPresetBindings();

    const timeoutSec = Number(settings.deepCleanTimeoutSec);
    settings.deepCleanTimeoutSec = Number.isFinite(timeoutSec)
        ? Math.min(Math.max(timeoutSec, 10), 1800)
        : defaultSettings.deepCleanTimeoutSec;
}

let isBooted = false;
jQuery(() => {
    if (isBooted) return;
    extension_settings[extensionName] = extension_settings[extensionName] || { ...defaultSettings };
    
    migrateOldData();
    ensureSettingsShape();

    const boot = () => {
        if (isBooted) return;
        isBooted = true;
        setupUI();
        bindEvents();
        initRealtimeInterceptor(); 
        updateToolbarUI();
        applyCharacterPresetBinding(true);
        performGlobalCleanse(); 
    };
    if (typeof eventSource !== 'undefined' && event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, boot);
        if (document.getElementById('send_textarea')) boot();
    }
});
