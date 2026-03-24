// ==UserScript==
// @name         北邮人论坛收藏夹失效帖清理
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  自动识别并删除收藏夹中标题为"[指定的文章不存在或链接错误]"的失效帖子，支持预扫描、进度条、暂停/继续、实时保存
// @match        *://bbs.byr.cn/*
// @match        *://bbs.byr.cn/fav*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const TARGET_TEXT = '[指定的文章不存在或链接错误]';
    const DELAY_BETWEEN_ITEMS = 300;
    const STORAGE_KEY = 'byr_cleanup_records';

    // ==================== 状态管理 ====================
    let deletedRecords = [];
    let paused = false;
    let running = false;
    let totalInvalid = 0;
    let totalPages = 0;
    let deletedCount = 0;
    let deleteStartTime = 0;
    let panelMinimized = false;

    // ==================== localStorage 持久化 ====================
    function saveToLocalStorage() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(deletedRecords));
        } catch (e) {
            console.warn('[收藏清理] localStorage 保存失败:', e);
        }
    }

    function loadFromLocalStorage() {
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            return [];
        }
    }

    // ==================== 下载记录 ====================
    function downloadRecords() {
        if (deletedRecords.length === 0) return;

        const now = new Date();
        const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;

        let content = `北邮人论坛收藏夹 - 已删除失效帖记录\n`;
        content += `导出时间: ${now.toLocaleString()}\n`;
        content += `共计: ${deletedRecords.length} 条\n`;
        content += `${'='.repeat(60)}\n\n`;

        deletedRecords.forEach((record, i) => {
            content += `[${i + 1}]\n`;
            content += `  发帖时间: ${record.date || '未知'}\n`;
            content += `  原帖标题: ${record.title || '未知'}\n`;
            content += `\n`;
        });

        const blob = new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `已删除失效收藏_${timestamp}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 3000);

        console.log(`[收藏清理] 已导出 ${deletedRecords.length} 条删除记录到 txt 文件`);
    }

    // ==================== DOM 工具函数 ====================
    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function waitForElement(predicate, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const found = predicate();
            if (found) return resolve(found);

            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error('等待元素超时'));
            }, timeout);

            const observer = new MutationObserver(() => {
                const el = predicate();
                if (el) {
                    clearTimeout(timer);
                    observer.disconnect();
                    resolve(el);
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function extractRowInfo(row) {
        const cells = row.querySelectorAll('td');
        let date = '';
        let title = '';

        if (cells.length >= 2) {
            for (const cell of cells) {
                const text = cell.textContent.trim();
                if (!date && /\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(text)) {
                    date = text.match(/\d{4}[-\/]\d{1,2}[-\/]\d{1,2}(\s+\d{1,2}:\d{2}(:\d{2})?)?/)?.[0] || text;
                }
                if (!title) {
                    const link = cell.querySelector('a');
                    if (link && link.textContent.trim() !== '删除') {
                        title = link.textContent.trim();
                    }
                }
            }
            if (!title && cells.length >= 2) {
                title = cells[1].textContent.trim();
            }
            if (!date) {
                date = cells[0].textContent.trim();
            }
        } else {
            title = row.textContent.trim().substring(0, 200);
        }

        title = title.replace(/\[指定的文章不存在或链接错误\]\s*/g, '').trim();
        return { date, title };
    }

    function findDeleteButton(row) {
        const allClickable = row.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
        for (const el of allClickable) {
            const text = (el.textContent || el.value || '').trim();
            if (text === '删除') return el;
        }
        for (const el of allClickable) {
            const onclick = el.getAttribute('onclick') || '';
            if (/delete|remove|del/i.test(onclick)) return el;
        }
        return null;
    }

    function findConfirmButton() {
        const candidates = document.querySelectorAll(
            '.modal button, .dialog button, .popup button, ' +
            '.modal a, .dialog a, .popup a, ' +
            '.modal input[type="button"], .dialog input[type="button"], ' +
            '[class*="modal"] button, [class*="dialog"] button, ' +
            '[class*="overlay"] button, [class*="confirm"] button, ' +
            'button, input[type="button"]'
        );
        for (const el of candidates) {
            const text = (el.textContent || el.value || '').trim();
            if (text === '确定' && isVisible(el)) return el;
        }
        return null;
    }

    function findNextPageButton() {
        const links = document.querySelectorAll('a');
        for (const a of links) {
            if (a.textContent.trim() === '>>') return a;
        }
        const pagers = document.querySelectorAll('.page-next, .next, [class*="next"]');
        for (const p of pagers) {
            if (isVisible(p)) return p;
        }
        return null;
    }

    function findFirstInvalidRow() {
        const allRows = document.querySelectorAll('table tr, .b-content tr, #result tr');
        for (const row of allRows) {
            if (row.textContent.includes(TARGET_TEXT)) return row;
        }
        const allEls = document.querySelectorAll('a, td, span');
        for (const el of allEls) {
            if (el.textContent.includes(TARGET_TEXT)) {
                return el.closest('tr') || el.closest('li') || el.parentElement;
            }
        }
        return null;
    }

    function countInvalidOnPage() {
        let count = 0;
        const allRows = document.querySelectorAll('table tr, .b-content tr, #result tr');
        for (const row of allRows) {
            if (row.textContent.includes(TARGET_TEXT)) count++;
        }
        return count;
    }

    // ==================== 弹窗处理 ====================
    async function handlePopup(description) {
        try {
            const btn = await waitForElement(findConfirmButton, 6000);
            await sleep(200);
            btn.click();
            console.log(`[收藏清理] ${description} - 已点击确定`);
            await sleep(500);
        } catch (e) {
            console.warn(`[收藏清理] ${description} - 未找到确定按钮:`, e.message);
        }
    }

    // ==================== 暂停检查 ====================
    async function waitWhilePaused() {
        while (paused) {
            await sleep(200);
        }
    }

    // ==================== UI 面板 ====================
    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'byr-cleanup-panel';
        panel.innerHTML = `
            <style>
                #byr-cleanup-panel {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    z-index: 999999;
                    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                    font-size: 13px;
                    color: #cdd6f4;
                    transition: all 0.3s ease;
                }
                #byr-cleanup-panel * {
                    box-sizing: border-box;
                }
                .byr-panel-main {
                    width: 320px;
                    background: #1e1e2e;
                    border-radius: 12px;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                    overflow: hidden;
                    border: 1px solid #313244;
                }
                .byr-panel-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 10px 14px;
                    background: #181825;
                    border-bottom: 1px solid #313244;
                    cursor: default;
                    user-select: none;
                }
                .byr-panel-title {
                    font-weight: bold;
                    font-size: 14px;
                    color: #89b4fa;
                }
                .byr-panel-header-btns {
                    display: flex;
                    gap: 6px;
                }
                .byr-panel-header-btns span {
                    width: 16px;
                    height: 16px;
                    border-radius: 50%;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 11px;
                    cursor: pointer;
                    line-height: 1;
                    transition: opacity 0.2s;
                }
                .byr-panel-header-btns span:hover {
                    opacity: 0.7;
                }
                .byr-btn-minimize {
                    background: #f9e2af;
                    color: #1e1e2e;
                }
                .byr-btn-close {
                    background: #f38ba8;
                    color: #1e1e2e;
                }
                .byr-panel-body {
                    padding: 14px;
                }
                .byr-status {
                    margin-bottom: 10px;
                    color: #a6adc8;
                    min-height: 20px;
                    line-height: 1.5;
                }
                .byr-progress-wrap {
                    background: #313244;
                    border-radius: 6px;
                    height: 20px;
                    overflow: hidden;
                    margin-bottom: 6px;
                    position: relative;
                }
                .byr-progress-bar {
                    height: 100%;
                    background: linear-gradient(90deg, #a6e3a1, #94e2d5);
                    border-radius: 6px;
                    width: 0%;
                    transition: width 0.4s ease;
                }
                .byr-progress-text {
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 11px;
                    color: #cdd6f4;
                    font-weight: bold;
                    text-shadow: 0 1px 2px rgba(0,0,0,0.5);
                }
                .byr-progress-info {
                    font-size: 12px;
                    color: #a6adc8;
                    margin-bottom: 12px;
                }
                .byr-panel-footer {
                    display: flex;
                    gap: 8px;
                    flex-wrap: wrap;
                    padding: 0 14px 14px;
                }
                .byr-panel-footer button {
                    flex: 1;
                    min-width: 80px;
                    padding: 8px 10px;
                    border: none;
                    border-radius: 8px;
                    font-size: 12px;
                    font-weight: bold;
                    cursor: pointer;
                    transition: all 0.2s;
                    font-family: inherit;
                    color: #1e1e2e;
                }
                .byr-panel-footer button:hover:not(:disabled) {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                }
                .byr-panel-footer button:disabled {
                    opacity: 0.4;
                    cursor: not-allowed;
                }
                .byr-btn-start {
                    background: #89b4fa;
                }
                .byr-btn-pause {
                    background: #fab387;
                }
                .byr-btn-export {
                    background: #a6e3a1;
                }
                .byr-mini-icon {
                    width: 48px;
                    height: 48px;
                    background: #1e1e2e;
                    border: 2px solid #89b4fa;
                    border-radius: 50%;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    font-size: 20px;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
                    transition: transform 0.2s;
                }
                .byr-mini-icon:hover {
                    transform: scale(1.1);
                }
            </style>
            <div class="byr-panel-main" id="byr-panel-main">
                <div class="byr-panel-header">
                    <span class="byr-panel-title">BYR 收藏清理</span>
                    <div class="byr-panel-header-btns">
                        <span class="byr-btn-minimize" id="byr-btn-minimize" title="最小化">&minus;</span>
                        <span class="byr-btn-close" id="byr-btn-close" title="关闭">&times;</span>
                    </div>
                </div>
                <div class="byr-panel-body">
                    <div class="byr-status" id="byr-status">就绪，点击"开始清理"启动</div>
                    <div class="byr-progress-wrap">
                        <div class="byr-progress-bar" id="byr-progress-bar"></div>
                        <div class="byr-progress-text" id="byr-progress-text"></div>
                    </div>
                    <div class="byr-progress-info" id="byr-progress-info">&nbsp;</div>
                </div>
                <div class="byr-panel-footer">
                    <button class="byr-btn-start" id="byr-btn-start">开始清理</button>
                    <button class="byr-btn-pause" id="byr-btn-pause" disabled>暂停</button>
                    <button class="byr-btn-export" id="byr-btn-export">导出记录</button>
                </div>
            </div>
            <div class="byr-mini-icon" id="byr-mini-icon" title="展开面板">🧹</div>
        `;
        document.body.appendChild(panel);

        // 事件绑定
        document.getElementById('byr-btn-minimize').addEventListener('click', () => toggleMinimize(true));
        document.getElementById('byr-mini-icon').addEventListener('click', () => toggleMinimize(false));
        document.getElementById('byr-btn-close').addEventListener('click', () => {
            panel.style.display = 'none';
        });
        document.getElementById('byr-btn-start').addEventListener('click', onStartClick);
        document.getElementById('byr-btn-pause').addEventListener('click', onPauseClick);
        document.getElementById('byr-btn-export').addEventListener('click', () => {
            if (deletedRecords.length === 0) {
                const prev = loadFromLocalStorage();
                if (prev.length > 0) {
                    deletedRecords = prev;
                }
            }
            downloadRecords();
        });
    }

    function toggleMinimize(minimize) {
        panelMinimized = minimize;
        document.getElementById('byr-panel-main').style.display = minimize ? 'none' : '';
        document.getElementById('byr-mini-icon').style.display = minimize ? 'flex' : 'none';
    }

    function updateStatus(text) {
        const el = document.getElementById('byr-status');
        if (el) el.textContent = text;
    }

    function updateProgress(current, total) {
        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        const bar = document.getElementById('byr-progress-bar');
        const text = document.getElementById('byr-progress-text');
        if (bar) bar.style.width = pct + '%';
        if (text) text.textContent = total > 0 ? `${current} / ${total}  (${pct}%)` : '';
    }

    function updateProgressInfo(text) {
        const el = document.getElementById('byr-progress-info');
        if (el) el.textContent = text;
    }

    function formatTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = Math.round(seconds % 60);
        if (m > 0) return `${m}分${s}秒`;
        return `${s}秒`;
    }

    function updateETA() {
        if (deletedCount === 0 || totalInvalid === 0) return;
        const elapsed = (Date.now() - deleteStartTime) / 1000;
        const avgTime = elapsed / deletedCount;
        const remaining = (totalInvalid - deletedCount) * avgTime;
        updateProgressInfo(`已完成 ${deletedCount}/${totalInvalid} | 预计剩余 ${formatTime(remaining)}`);
    }

    // ==================== 按钮事件 ====================
    function onStartClick() {
        const btn = document.getElementById('byr-btn-start');
        btn.disabled = true;
        btn.textContent = '运行中...';
        document.getElementById('byr-btn-pause').disabled = false;
        running = true;
        paused = false;
        deletedRecords = [];
        deletedCount = 0;
        totalInvalid = 0;
        totalPages = 0;
        main();
    }

    function onPauseClick() {
        const btn = document.getElementById('byr-btn-pause');
        if (!paused) {
            paused = true;
            btn.textContent = '继续';
            btn.classList.remove('byr-btn-pause');
            btn.style.background = '#a6e3a1';
            updateStatus('已暂停');
            saveToLocalStorage();
            downloadRecords();
        } else {
            paused = false;
            btn.textContent = '暂停';
            btn.style.background = '#fab387';
            updateStatus('继续运行中...');
        }
    }

    // ==================== 预扫描 ====================
    async function scanAllPages() {
        updateStatus('正在扫描，请稍候...');
        let page = 0;
        let total = 0;

        while (true) {
            page++;
            updateStatus(`正在扫描第 ${page} 页...`);
            await sleep(1000);

            const count = countInvalidOnPage();
            total += count;
            console.log(`[收藏清理] 扫描第 ${page} 页: 发现 ${count} 条失效帖`);

            const nextBtn = findNextPageButton();
            if (!nextBtn) break;

            nextBtn.click();
            await sleep(2000);
        }

        totalPages = page;
        totalInvalid = total;
        console.log(`[收藏清理] 扫描完成: 共 ${totalPages} 页, ${totalInvalid} 条失效帖`);
        return { totalPages: page, totalInvalid: total };
    }

    async function goBackToFirstPage() {
        const links = document.querySelectorAll('a');
        for (const a of links) {
            if (a.textContent.trim() === '<<') {
                a.click();
                await sleep(2000);
                return;
            }
        }
        // 如果只有一页，不需要跳转
    }

    // ==================== 删除流程 ====================
    async function deleteOneItem(row, index) {
        try {
            const deleteBtn = findDeleteButton(row);
            if (!deleteBtn) {
                console.warn(`[收藏清理] 第${index + 1}条: 未找到删除按钮，跳过`);
                return false;
            }

            const info = extractRowInfo(row);
            console.log(`[收藏清理] 第${index + 1}条: 时间: ${info.date}, 标题: ${info.title}`);

            const origConfirm = window.confirm;
            window.confirm = () => true;

            deleteBtn.click();

            await sleep(300);
            window.confirm = origConfirm;

            await handlePopup('确认弹窗');
            await handlePopup('成功提示弹窗');

            console.log(`[收藏清理] 第${index + 1}条: 删除完成`);
            deletedRecords.push(info);
            deletedCount++;
            saveToLocalStorage();
            updateProgress(deletedCount, totalInvalid);
            updateETA();
            return true;
        } catch (e) {
            console.error(`[收藏清理] 第${index + 1}条: 处理出错:`, e);
            return false;
        }
    }

    async function processCurrentPage() {
        await sleep(1000);

        let deleted = 0;
        let failures = 0;
        const MAX_FAILURES = 3;

        while (true) {
            await waitWhilePaused();

            const row = findFirstInvalidRow();
            if (!row) {
                console.log('[收藏清理] 当前页无更多失效帖');
                break;
            }

            const success = await deleteOneItem(row, deletedCount);

            if (success) {
                deleted++;
                failures = 0;
            } else {
                failures++;
                if (failures >= MAX_FAILURES) {
                    console.warn(`[收藏清理] 连续 ${MAX_FAILURES} 次删除失败，跳过当前页`);
                    break;
                }
            }

            await sleep(DELAY_BETWEEN_ITEMS + 500);
        }

        return deleted;
    }

    // ==================== 主流程 ====================
    async function main() {
        console.log('[收藏清理] 脚本启动');

        // 阶段1：预扫描
        const scanResult = await scanAllPages();

        if (scanResult.totalInvalid === 0) {
            updateStatus('扫描完成，未发现失效帖');
            updateProgress(0, 0);
            updateProgressInfo('无需清理');
            resetButtons();
            return;
        }

        updateStatus(`扫描完成: ${scanResult.totalPages} 页, ${scanResult.totalInvalid} 条失效帖`);
        updateProgress(0, scanResult.totalInvalid);
        await sleep(1500);

        // 跳回第一页
        await goBackToFirstPage();

        // 阶段2：删除
        deleteStartTime = Date.now();
        updateStatus('正在删除...');

        let pageCount = 0;

        while (true) {
            await waitWhilePaused();

            pageCount++;
            updateStatus(`正在删除 — 第 ${pageCount} 页`);

            await processCurrentPage();

            const nextBtn = findNextPageButton();
            if (!nextBtn) {
                console.log('[收藏清理] 没有下一页，清理结束');
                break;
            }

            console.log('[收藏清理] 跳转到下一页...');
            nextBtn.click();
            await sleep(2000);
        }

        // 完成
        running = false;
        updateStatus(`清理完成！共 ${pageCount} 页，删除 ${deletedCount} 条失效帖`);
        updateProgress(deletedCount, totalInvalid);
        updateProgressInfo('已完成');
        saveToLocalStorage();
        downloadRecords();
        resetButtons();
        console.log(`[收藏清理] 全部完成！删除 ${deletedCount} 条`);
    }

    function resetButtons() {
        const startBtn = document.getElementById('byr-btn-start');
        const pauseBtn = document.getElementById('byr-btn-pause');
        startBtn.disabled = false;
        startBtn.textContent = '开始清理';
        pauseBtn.disabled = true;
        pauseBtn.textContent = '暂停';
        pauseBtn.style.background = '#fab387';
        running = false;
    }

    // ==================== 初始化 ====================
    function init() {
        createPanel();
        console.log('[收藏清理] 面板已加载');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
