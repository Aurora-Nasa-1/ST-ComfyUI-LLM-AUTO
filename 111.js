//name: ComfyUI Context Generator Pro
//description: ComfyUI集成增强版：支持自动生成、图片替换、极简UI
//author: AI Assistant & User
//version: 2.0

(function () {
    'use strict';

    // ================= 配置与常量 =================
    const MODULE_ID = 'comfy_gen_pro_v2';
    const STORAGE_KEY = 'comfy_gen_pro_v2_settings';

    // 默认设置
    const DEFAULT_SETTINGS = {
        comfyUrl: 'http://127.0.0.1:8188',
        contextDepth: 5,         // 上下文深度
        uploadCharImg: true,     // 上传角色图
        width: 1024,
        height: 1024,
        autoGen: false,          // 自动生成开关
        replaceMode: true,       // 替换模式：是否替换上一张图
        workflow: null,          // 存储 JSON Workflow
    };

    // 读取或初始化设置
    let settings = JSON.parse(localStorage.getItem(STORAGE_KEY)) || DEFAULT_SETTINGS;

    // ================= 核心逻辑类 =================
    class ComfyManager {
        constructor() {
            this.isGenerating = false;
            this.lastImageId = null; // 追踪最后生成的图片ID
            this.initEventListeners();
        }

        saveSettings() {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        }

        // 监听酒馆事件
        initEventListeners() {
            // 确保 eventSource 存在 (酒馆核心API)
            if (window.eventSource) {
                // 监听：聊天生成结束 (角色回复完毕)
                window.eventSource.on(window.event_types.CHAT_COMPLETION_FINISHED, async () => {
                    if (settings.autoGen) {
                        console.log('[ComfyPro] Auto-generation triggered.');
                        await this.generate();
                    }
                });
            }
        }

        // 1. 获取上下文
        getContext() {
            if (!SillyTavern.chat || SillyTavern.chat.length === 0) return "";
            const history = SillyTavern.chat.slice(-settings.contextDepth);
            return history.map(msg => {
                const name = msg.is_user ? 'User' : (msg.name || 'Char');
                const cleanMes = msg.mes.replace(/<[^>]*>/g, '').replace(/\n/g, ' ');
                return `${name}: ${cleanMes}`;
            }).join('\n');
        }

        // 2. 上传角色图
        async uploadCharacterImage() {
            if (!SillyTavern.this_chid && SillyTavern.this_chid !== 0) return null;
            const charUrl = SillyTavern.characters[SillyTavern.this_chid].avatar;
            const fullUrl = charUrl.startsWith('http') ? charUrl : `/${charUrl}`;

            try {
                const res = await fetch(fullUrl);
                const blob = await res.blob();
                const formData = new FormData();
                const filename = `st_char_${SillyTavern.this_chid}.png`; // 固定文件名以减少垃圾文件
                formData.append('image', blob, filename);
                formData.append('overwrite', 'true');
                formData.append('type', 'input');

                const uploadRes = await fetch(`${settings.comfyUrl}/upload/image`, { method: 'POST', body: formData });
                if (!uploadRes.ok) throw new Error('Upload Failed');
                const json = await uploadRes.json();
                return json.name;
            } catch (e) {
                console.error('Char Image Upload Error:', e);
                return null;
            }
        }

        // 3. 处理工作流 (变量注入)
        processWorkflow(workflowStr, context, charImageName) {
            let processed = workflowStr;
            const seed = Math.floor(Math.random() * 10000000000);
            const safeContext = context.replace(/[\r\n]+/g, '\\n').replace(/"/g, '\\"');

            // 字符串替换
            processed = processed.replace(/\$Seed\$/g, seed)
                                 .replace(/\$Width\$/g, settings.width)
                                 .replace(/\$Height\$/g, settings.height)
                                 .replace(/\$LLMCONTEXT\$/g, safeContext);

            let workflow = JSON.parse(processed);

            // 遍历节点注入图片
            if (charImageName && settings.uploadCharImg) {
                for (const key in workflow) {
                    const node = workflow[key];
                    // 查找 LoadImage 节点或标记了 $CharImage$ 的节点
                    if (JSON.stringify(node).includes('$CharImage$')) {
                        if(node.inputs && node.inputs.image === '$CharImage$') {
                            node.inputs.image = charImageName;
                        }
                    }
                }
            }
            return workflow;
        }

        // 4. 主生成函数
        async generate() {
            if (this.isGenerating) return;
            if (!settings.workflow) {
                toastr.warning('ComfyUI: 请先在设置中导入工作流 JSON');
                this.openSettings();
                return;
            }

            this.isGenerating = true;
            this.updateBtnState(true); // 按钮转圈

            try {
                const context = this.getContext();
                let charImgName = null;
                if (settings.uploadCharImg) charImgName = await this.uploadCharacterImage();

                const workflowObj = this.processWorkflow(JSON.stringify(settings.workflow), context, charImgName);

                const queueRes = await fetch(`${settings.comfyUrl}/prompt`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: workflowObj })
                });

                if (!queueRes.ok) throw new Error('Queue Failed');
                const queueData = await queueRes.json();
                await this.pollResult(queueData.prompt_id);

            } catch (e) {
                toastr.error(`ComfyUI Error: ${e.message}`);
            } finally {
                this.isGenerating = false;
                this.updateBtnState(false);
            }
        }

        // 5. 轮询结果
        async pollResult(promptId) {
            const startTime = Date.now();
            const check = async () => {
                if (Date.now() - startTime > 120000) return; // 2分钟超时

                try {
                    const res = await fetch(`${settings.comfyUrl}/history/${promptId}`);
                    const history = await res.json();
                    if (history[promptId] && history[promptId].outputs) {
                        const outputs = history[promptId].outputs;
                        for (const nodeId in outputs) {
                            const nodeOut = outputs[nodeId];
                            if (nodeOut.images && nodeOut.images.length > 0) {
                                const imgData = nodeOut.images[0];
                                await this.displayImage(imgData.filename, imgData.subfolder, imgData.type);
                                return;
                            }
                        }
                    }
                    setTimeout(check, 1000);
                } catch (e) { setTimeout(check, 1000); }
            };
            check();
        }

        // 6. 显示/替换图片 (核心优化)
        async displayImage(filename, subfolder, type) {
            const query = new URLSearchParams({ filename, subfolder, type });
            // 添加时间戳防止缓存
            const imageUrl = `${settings.comfyUrl}/view?${query.toString()}&t=${Date.now()}`;

            // 检查是否存在上一张由本插件生成的图片
            const lastImgElement = $('.comfy-pro-result').last();

            if (settings.replaceMode && lastImgElement.length > 0) {
                // === 替换模式 ===
                // 仅更新 src，实现“动态变化”效果
                lastImgElement.attr('src', imageUrl);
                toastr.success('ComfyUI: 图片已更新');
            } else {
                // === 新增模式 ===
                // 创建唯一的 HTML 结构
                const uniqueId = `comfy-img-${Date.now()}`;
                const html = `
                    <div class="mes_text" style="text-align: center; margin-top: 10px;">
                        <img id="${uniqueId}" class="comfy-pro-result" src="${imageUrl}" 
                             style="max-width: 80%; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.3); cursor: pointer;" 
                             onclick="window.open(this.src, '_blank')" />
                    </div>
                `;
                
                // 插入到当前聊天流底部
                $('#chat').append(html);
                // 滚动到底部
                $('#chat').scrollTop($('#chat')[0].scrollHeight);
            }
        }

        // ================= UI 构建 =================
        
        // 更新按钮状态
        updateBtnState(loading) {
            const icon = $('#comfy-quick-btn i');
            if (loading) {
                icon.removeClass('fa-magic').addClass('fa-circle-notch fa-spin');
                $('#comfy-quick-btn').css('opacity', '0.5');
            } else {
                icon.removeClass('fa-circle-notch fa-spin').addClass('fa-magic');
                $('#comfy-quick-btn').css('opacity', '1');
            }
        }

        openSettings() {
            const html = `
                <div class="comfy-settings">
                    <h3 style="border-bottom:1px solid #ccc; padding-bottom:5px;">ComfyUI Pro 设置</h3>
                    
                    <div class="comfy-row">
                        <label>ComfyUI URL</label>
                        <input type="text" id="cfg_comfy_url" class="text_pole" value="${settings.comfyUrl}">
                    </div>

                    <div class="comfy-row flex-container">
                        <div style="flex:1; margin-right:5px;">
                            <label>上下文行数</label>
                            <input type="number" id="cfg_ctx_depth" class="text_pole" value="${settings.contextDepth}">
                        </div>
                        <div style="flex:1;">
                            <label>宽 x 高</label>
                            <div class="flex-container">
                                <input type="number" id="cfg_width" class="text_pole" value="${settings.width}" style="width:50%">
                                <span style="padding:5px">x</span>
                                <input type="number" id="cfg_height" class="text_pole" value="${settings.height}" style="width:50%">
                            </div>
                        </div>
                    </div>

                    <div class="comfy-row">
                        <label class="checkbox_label">
                            <input type="checkbox" id="cfg_auto_gen" ${settings.autoGen ? 'checked' : ''}>
                            启用自动生成 (角色回复后自动绘图)
                        </label>
                    </div>

                    <div class="comfy-row">
                        <label class="checkbox_label">
                            <input type="checkbox" id="cfg_replace_mode" ${settings.replaceMode ? 'checked' : ''}>
                            替换模式 (只保留最后一张图，不刷屏)
                        </label>
                    </div>

                    <div class="comfy-row">
                        <label class="checkbox_label">
                            <input type="checkbox" id="cfg_up_char" ${settings.uploadCharImg ? 'checked' : ''}>
                            上传角色头像 (变量: <code>$CharImage$</code>)
                        </label>
                    </div>
                    
                    <hr>
                    <label>API Workflow (JSON)</label>
                    <textarea id="cfg_workflow_json" class="text_pole" rows="8" style="font-size:12px; font-family:monospace;">${settings.workflow ? JSON.stringify(settings.workflow, null, 2) : ''}</textarea>
                    
                    <div style="margin-top: 15px; text-align: right;">
                        <button id="cfg_save_btn" class="menu_button">保存并关闭</button>
                    </div>
                </div>
                <style>
                    .comfy-settings { padding: 5px; }
                    .comfy-row { margin-bottom: 10px; }
                    .comfy-row label { display: block; font-weight: bold; font-size: 0.9em; margin-bottom: 3px; }
                    .checkbox_label { display: flex !important; align-items: center; font-weight: normal !important; cursor: pointer; }
                    .checkbox_label input { margin-right: 8px; }
                </style>
            `;

            // 调用酒馆通用弹窗
            SillyTavern.callGenericPopup(html, 2, '', { wide: true });

            // 绑定保存逻辑
            $('#cfg_save_btn').off('click').on('click', () => {
                settings.comfyUrl = $('#cfg_comfy_url').val();
                settings.contextDepth = parseInt($('#cfg_ctx_depth').val());
                settings.width = parseInt($('#cfg_width').val());
                settings.height = parseInt($('#cfg_height').val());
                settings.autoGen = $('#cfg_auto_gen').is(':checked');
                settings.replaceMode = $('#cfg_replace_mode').is(':checked');
                settings.uploadCharImg = $('#cfg_up_char').is(':checked');

                try {
                    const wfText = $('#cfg_workflow_json').val();
                    if(wfText.trim()) settings.workflow = JSON.parse(wfText);
                    this.saveSettings();
                    toastr.success('设置已保存');
                    // 关闭弹窗 (模拟点击背景关闭)
                    $('#dialogue_popup_overlay').click();
                } catch (e) {
                    toastr.error('JSON 格式错误');
                }
            });
        }
    }

    const manager = new ComfyManager();

    // ================= 初始化 UI =================

    const initUI = () => {
        // 1. 设置菜单入口 (Extensions 列表)
        if ($('#comfy-pro-menu').length === 0) {
            const menuBtn = $(`
                <div class="list-group-item flex-container flexGap5 interactable" id="comfy-pro-menu">
                    <div class="fa-fw fa-solid fa-palette"></div>
                    <span>ComfyUI Pro 设置</span>
                </div>
            `);
            $('#extensionsMenu').append(menuBtn);
            menuBtn.on('click', () => manager.openSettings());
        }

        // 2. 快捷触发按钮 (极简版)
        // 放置在输入框上方的工具栏 (通常是 #form_textarea 附近的容器)
        // 这里的 ID 选择器取决于酒馆版本，通常 #send_but_container 或 #textarea_buttons
        
        const targetContainer = $('#send_but_container').length ? $('#send_but_container') : $('#textarea_buttons');
        
        if ($('#comfy-quick-btn').length === 0) {
            const quickBtn = $(`
                <div id="comfy-quick-btn" title="立即生成图片 (ComfyUI)" class="mes_text" 
                     style="width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; 
                            cursor: pointer; margin: 0 5px; border-radius: 5px; border: 1px solid var(--smart-theme-border);">
                    <i class="fa-solid fa-magic"></i>
                </div>
            `);
            
            // 插入到发送按钮左侧
            if(targetContainer.length) {
                targetContainer.prepend(quickBtn);
            } else {
                // 备用方案：插在输入框之前
                $('#send_textarea').before(quickBtn);
            }

            quickBtn.on('click', (e) => {
                e.stopPropagation();
                manager.generate();
            });

            // 右键点击按钮快速切换自动模式
            quickBtn.on('contextmenu', (e) => {
                e.preventDefault();
                settings.autoGen = !settings.autoGen;
                manager.saveSettings();
                toastr.info(`自动生成已${settings.autoGen ? '开启' : '关闭'}`);
                // 可以在这里添加视觉反馈，比如改变按钮颜色
                quickBtn.css('color', settings.autoGen ? 'var(--smart-theme-color-green)' : '');
            });
        }

        console.log('[ComfyPro v2] Loaded.');
    };

    // 等待 DOM 加载
    let retry = 0;
    const loader = setInterval(() => {
        if (typeof SillyTavern !== 'undefined' && $('#extensionsMenu').length && typeof $ !== 'undefined') {
            clearInterval(loader);
            initUI();
        } else if (retry++ > 20) clearInterval(loader);
    }, 500);

    // 暴露全局变量以便调试
    window.ComfyPro = manager;

})();