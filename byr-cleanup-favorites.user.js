// ==UserScript==
// @name         北邮人论坛收藏夹失效帖清理
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  自动识别并删除收藏夹中标题为"[指定的文章不存在或链接错误]"的失效帖子
// @match        *://bbs.byr.cn/*
// @match        *://bbs.byr.cn/fav*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const TARGET_TEXT = '[指定的文章不存在或链接错误]';
    const DELAY_BETWEEN_ITEMS = 300;

    // 记录被删除帖子的信息
    const deletedRecords = [];

    // 从行中提取发帖时间和原帖标题
    function extractRowInfo(row) {
        const cells = row.querySelectorAll('td');
        let date = '';
        let title = '';

        if (cells.length >= 2) {
            // 通常论坛表格：日期在第一列或靠前的列，标题在中间列
            for (const cell of cells) {
                const text = cell.textContent.trim();
                // 匹配日期格式：如 2024-01-01、2024/01/01、Jan 01 等
                if (!date && /\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(text)) {
                    date = text.match(/\d{4}[-\/]\d{1,2}[-\/]\d{1,2}(\s+\d{1,2}:\d{2}(:\d{2})?)?/)?.[0] || text;
                }
                // 标题列：包含链接且不是"删除"按钮的列
                if (!title) {
                    const link = cell.querySelector('a');
                    if (link && link.textContent.trim() !== '删除') {
                        title = link.textContent.trim();
                    }
                }
            }
            // 如果没找到带链接的标题，取第二列文本作为标题
            if (!title && cells.length >= 2) {
                title = cells[1].textContent.trim();
            }
            // 如果没匹配到日期格式，取第一列文本
            if (!date) {
                date = cells[0].textContent.trim();
            }
        } else {
            // 行结构不明时，取整行文本
            title = row.textContent.trim().substring(0, 200);
        }

        // 去掉标题中的 "[指定的文章不存在或链接错误]" 部分，只保留后面的原始标题
        title = title.replace(/\[指定的文章不存在或链接错误\]\s*/g, '').trim();

        return { date, title };
    }

    // 将记录导出为 txt 文件并触发下载
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
        URL.revokeObjectURL(url);

        console.log(`[收藏清理] 已导出 ${deletedRecords.length} 条删除记录到 txt 文件`);
    }

    // 等待满足条件的元素出现（MutationObserver）
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

    // 短延时，用于等待 DOM 稳定
    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }


    // 在行中查找"删除"按钮
    function findDeleteButton(row) {
        // 优先找最后一列的删除按钮/链接
        const allClickable = row.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
        for (const el of allClickable) {
            const text = (el.textContent || el.value || '').trim();
            if (text === '删除') return el;
        }
        // 备用：找 onclick 含 delete/remove 的元素
        for (const el of allClickable) {
            const onclick = el.getAttribute('onclick') || '';
            if (/delete|remove|del/i.test(onclick)) return el;
        }
        return null;
    }

    // 查找弹窗中的"确定"按钮
    function findConfirmButton() {
        // 1. 原生 confirm() —— 无需处理，浏览器会自动弹出
        // 2. 自定义弹窗：查找可见的"确定"按钮
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

    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    // 处理一个弹窗：等待"确定"按钮出现并点击
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

    // 删除单个失效帖子的完整流程
    async function deleteOneItem(row, index) {
        try {
            const deleteBtn = findDeleteButton(row);
            if (!deleteBtn) {
                console.warn(`[收藏清理] 第${index + 1}条: 未找到删除按钮，跳过`);
                return false;
            }

            // 删除前记录帖子信息
            const info = extractRowInfo(row);
            console.log(`[收藏清理] 第${index + 1}条: 记录 -> 时间: ${info.date}, 标题: ${info.title}`);

            console.log(`[收藏清理] 第${index + 1}条: 点击删除按钮`);

            // 劫持 window.confirm，自动返回 true（处理原生 confirm 弹窗的情况）
            const origConfirm = window.confirm;
            window.confirm = () => true;

            deleteBtn.click();

            // 恢复 confirm
            await sleep(300);
            window.confirm = origConfirm;

            // 等待并处理第一个弹窗（确认删除）
            await handlePopup('确认弹窗');

            // 等待并处理第二个弹窗（操作成功）
            await handlePopup('成功提示弹窗');

            console.log(`[收藏清理] 第${index + 1}条: 删除完成`);
            deletedRecords.push(info);
            return true;
        } catch (e) {
            console.error(`[收藏清理] 第${index + 1}条: 处理出错:`, e);
            return false;
        }
    }

    // 查找"下一页"按钮 >>
    function findNextPageButton() {
        const links = document.querySelectorAll('a');
        for (const a of links) {
            if (a.textContent.trim() === '>>') return a;
        }
        // 备用：查找 class 含 next/page 的链接
        const pagers = document.querySelectorAll('.page-next, .next, [class*="next"]');
        for (const p of pagers) {
            if (isVisible(p)) return p;
        }
        return null;
    }

    // 查找当前页第一条失效帖子行（每次从 DOM 实时查询）
    function findFirstInvalidRow() {
        const allRows = document.querySelectorAll('table tr, .b-content tr, #result tr');
        for (const row of allRows) {
            if (row.textContent.includes(TARGET_TEXT)) return row;
        }
        // 备用：更宽泛的选择器
        const allEls = document.querySelectorAll('a, td, span');
        for (const el of allEls) {
            if (el.textContent.includes(TARGET_TEXT)) {
                return el.closest('tr') || el.closest('li') || el.parentElement;
            }
        }
        return null;
    }

    // 处理当前页：每次删除后重新查找，直到本页无失效帖
    async function processCurrentPage() {
        await sleep(1000); // 等待页面加载

        let deleted = 0;
        let failures = 0;
        const MAX_FAILURES = 3; // 连续失败上限，防止死循环

        while (true) {
            // 每次都从 DOM 重新查找第一条失效帖
            const row = findFirstInvalidRow();
            if (!row) {
                console.log(`[收藏清理] 当前页无更多失效帖`);
                break;
            }

            console.log(`[收藏清理] 当前页第 ${deleted + 1} 条失效帖，开始删除...`);
            const success = await deleteOneItem(row, deleted);

            if (success) {
                deleted++;
                failures = 0; // 重置连续失败计数
            } else {
                failures++;
                if (failures >= MAX_FAILURES) {
                    console.warn(`[收藏清理] 连续 ${MAX_FAILURES} 次删除失败，跳过当前页剩余项`);
                    break;
                }
            }

            // 等待页面 DOM 刷新稳定后再查找下一条
            await sleep(DELAY_BETWEEN_ITEMS + 500);
        }

        console.log(`[收藏清理] 当前页删除了 ${deleted} 条`);
        return deleted;
    }

    // 主流程
    async function main() {
        console.log('[收藏清理] 脚本启动，开始清理失效收藏...');

        let pageCount = 0;
        let totalDeleted = 0;

        while (true) {
            pageCount++;
            console.log(`[收藏清理] === 正在处理第 ${pageCount} 页 ===`);

            const deleted = await processCurrentPage();
            totalDeleted += deleted;

            // 查找下一页按钮
            const nextBtn = findNextPageButton();
            if (!nextBtn) {
                console.log('[收藏清理] 没有下一页，清理结束');
                break;
            }

            console.log('[收藏清理] 跳转到下一页...');
            nextBtn.click();

            // 等待页面加载
            await sleep(2000);
        }

        const msg = `[收藏清理] 全部完成！共处理 ${pageCount} 页，删除 ${totalDeleted} 条失效帖。`;
        console.log(msg);

        // 导出删除记录到 txt 文件
        downloadRecords();

        alert(msg);
    }

    // 添加手动触发按钮（悬浮在页面右下角）
    function addTriggerButton() {
        const btn = document.createElement('button');
        btn.textContent = '清理失效收藏';
        btn.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 99999;
            padding: 10px 20px;
            background: #e74c3c;
            color: #fff;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        `;
        btn.addEventListener('click', () => {
            btn.disabled = true;
            btn.textContent = '清理中...';
            main().finally(() => {
                btn.disabled = false;
                btn.textContent = '清理失效收藏';
            });
        });
        document.body.appendChild(btn);
    }

    // 页面加载完成后添加按钮
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addTriggerButton);
    } else {
        addTriggerButton();
    }
})();
