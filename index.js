import { eventSource, event_types } from '../../../../../../script.js';
import { renderTree } from './tree.js';

const MVU_BTN_ID = 'mvu-btn';
const MVU_OVERLAY_ID = 'mvu-overlay';

function openMvuDialog() {
    $(`#${MVU_OVERLAY_ID}`).remove();

    // 创建弹窗外层遮罩
    const $overlay = $(`
        <div id="${MVU_OVERLAY_ID}" style="position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 9999; display: flex; align-items: center; justify-content: center;">
            <div style="width: 80%; max-width: 800px; max-height: 85vh; background: var(--SmartThemeBodyColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 10px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
                <div style="padding: 15px; border-bottom: 1px solid var(--SmartThemeBorderColor); display: flex; justify-content: space-between; align-items: center; font-weight: bold;">
                    <div><i class="fa-solid fa-wand-magic-sparkles"></i> MVU 变量修改器</div>
                    <div id="mvu-close-btn" class="mvu-action-btn"><i class="fa-solid fa-xmark fa-lg"></i></div>
                </div>
                <div id="mvu-tree-container" style="padding: 15px; overflow-y: auto; flex-grow: 1;">
                    </div>
            </div>
        </div>
    `);

    // 关闭事件
    $overlay.find('#mvu-close-btn').on('click', () => $overlay.remove());
    $('body').append($overlay);

    // 调用 tree.js 渲染内容
    renderTree(document.getElementById('mvu-tree-container'));
}

function injectMvuButton() {
    const $menu = $('#extensionsMenu, #chat_input_extras_menu').first();
    if ($menu.length === 0 || $(`#${MVU_BTN_ID}`).length > 0) return;

    // 完美契合酒馆扩展菜单的原生按钮
    const $button = $(`
        <div id="${MVU_BTN_ID}" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem">
            <i class="fa-solid fa-wand-magic-sparkles fa-fw extensionsMenuExtensionButton"></i>
            <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">MVU 变量管理</span>
        </div>
    `);

    $button.on('click', () => {
        $('#extensionsMenu').hide(); // 点开后自动收起扩展菜单
        openMvuDialog();
    });

    $menu.append($button);
    console.log('[MVU Modifier] 扩展菜单按钮注入成功！');
}

export async function init() {
    console.log('[MVU Modifier] 正在初始化...');
    // 双重保险：如果 DOM 已经准备好，直接注入；否则等 APP_READY
    if ($('#extensionsMenu').length > 0 || $('#chat_input_extras_menu').length > 0) {
        injectMvuButton();
    } else {
        eventSource.on(event_types.APP_READY, injectMvuButton);
    }
}

export async function exit() {
    $(`#${MVU_BTN_ID}`).remove();
    $(`#${MVU_OVERLAY_ID}`).remove();
    console.log('[MVU Modifier] 卸载成功');
}
