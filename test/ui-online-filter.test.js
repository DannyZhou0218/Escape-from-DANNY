/*
 * EXFIL ZONE · 客户端联机正确性静态回归锁（v0.15.0 · cli-dev）
 * ---------------------------------------------------------------
 * 背景：G7「串台」——联机 ws 消息分支只按消息类型处理、不判归属，
 *   他人 equipped / 撤离 / 弹药 / 换弹 事件会改到自己的本地 UI。
 * 本文件同时锁定：
 *   ① 契约 6 · G7：6 组事件必须先判 m.id === myId 再改本地状态；
 *      extractSuccess 过滤后「自己撤离」的结算路径不能丢。
 *   ② 契约 1.3 · G3：胸挂医疗品可快捷使用；背包内按钮禁用 + 提示。
 *   ③ 契约 2 · G5：阵亡态重生入口（按钮 / Enter；**仅单机**）。
 *      联机裁定：死亡=永久结算（MEMORY 第六节），不提供重生窗口（2026-09-30 Lead）。
 *   ④ 契约 4：index.html 三处版本号为 {{VERSION}} 占位符；帮助文本 R=换弹。
 *   ⑤ A7：game.js 不得出现 store.* 服务端变量引用。
 * 说明：CRLF 文件先剥离 \r 再匹配（E048 教训：不剥离会静默失配）。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const gameSrc = read('public/game.js').replace(/\r/g, '');
const htmlSrc = read('public/index.html').replace(/\r/g, '');

// 联机消息分发的 switch 区域（从 ws.onmessage 到 onlineStep 前的 E021 注释）
const REGION = (() => {
  const start = gameSrc.indexOf('ws.onmessage');
  assert.ok(start >= 0, '未找到 ws.onmessage');
  const endMarker = '// E021：输入发送与本地预测绑定在同一个 60Hz 步进里';
  const end = gameSrc.indexOf(endMarker, start);
  assert.ok(end > start, '未找到 ws.onmessage 的结束边界');
  return gameSrc.slice(start, end);
})();

// 取单个 case 的源码块（到下一个 case 为止）
function caseBlock(name) {
  const marker = "case '" + name + "':";
  const i = REGION.indexOf(marker);
  assert.ok(i >= 0, '联机 switch 未找到 case ' + name);
  const rest = REGION.slice(i + marker.length);
  const next = rest.indexOf("case '");
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('契约6·G7: 联机 6 组事件必须先判 m.id === myId 再改本地状态', () => {
  const groups = {
    equipped: ['equipped'],
    'extract*': ['extractStart', 'extractProgress', 'extractSuccess', 'extractCancel'],
    ammo: ['ammo'],
    ammoRefilled: ['ammoRefilled'],
    'reloadStart/reloadDone': ['reloadStart', 'reloadDone']
  };
  for (const [group, names] of Object.entries(groups)) {
    for (const name of names) {
      assert.ok(
        /m\.id\s*===\s*myId/.test(caseBlock(name)),
        "case '" + name + "' 缺少 m.id === myId 归属过滤（" + group + " 串台根因）"
      );
    }
  }
});

test('契约6·G7: invChanged 参照组仍带归属过滤（未被回退）', () => {
  assert.ok(/m\.id\s*===\s*myId/.test(caseBlock('invChanged')), 'invChanged 必须按 m.id 过滤后再缓存背包');
});

test('契约6·G7: extractSuccess 过滤后仍保留「自己撤离」的结算路径', () => {
  const b = caseBlock('extractSuccess');
  assert.ok(/m\.id\s*===\s*myId/.test(b), 'extractSuccess 必须判归属');
  assert.ok(b.includes('hideExtractHUD()'), 'extractSuccess 自己撤离必须收起撤离 HUD');
  assert.ok(/raidOutcome\s*=/.test(b), 'extractSuccess 自己撤离必须记录 raidOutcome（结算路径不能丢）');
  assert.ok(b.includes("showSummary('success')"), 'extractSuccess 必须保留既有 showSummary 结算展示');
});

test('契约6·G7 补充: 弹匣空 / 重生事件同样按 m.id 过滤（同源串台）', () => {
  assert.ok(/m\.id\s*===\s*myId/.test(caseBlock('empty')), "case 'empty' 应判归属，否则他人空弹也提示自己");
  assert.ok(/m\.id\s*===\s*myId/.test(caseBlock('respawn')), "case 'respawn' 应判归属");
});

test('契约1.3·G3: quickUse 客户端入口（联机指令 + 单机 sim.quickUse）', () => {
  assert.ok(gameSrc.includes("type: 'quickUse'"), '联机必须发 {type:quickUse,index}（契约 1.1）');
  assert.ok(gameSrc.includes("sim.quickUse('solo', idx, def.heal, null)"), '单机必须走 sim.quickUse("solo",...)（契约 1.3）');
  assert.ok(/window\._exfilQuickUse\s*=\s*function/.test(gameSrc), '必须暴露 window._exfilQuickUse 供按钮调用');
});

test('契约1.3·G3: 胸挂医疗品可点 / 背包内禁用 + 悬停提示', () => {
  assert.ok(gameSrc.includes("it.src === 'rig'"), '必须按条目 src === "rig" 判定胸挂来源');
  assert.ok(gameSrc.includes('快捷使用'), '必须渲染「快捷使用」按钮');
  assert.ok(gameSrc.includes('data-quick-use="1"'), '胸挂内按钮必须可点（data-quick-use=1）');
  assert.ok(/data-quick-use="0" disabled/.test(gameSrc), '非胸挂按钮必须禁用（disabled）');
  assert.ok(gameSrc.includes('需先移入胸挂'), '背包内必须有「需先移入胸挂」提示');
  assert.ok(gameSrc.includes('window._exfilUseItem'), '既有「使用」按钮必须保留（契约 1.3 明示不变）');
});

test('契约2·G5: 单机重生入口（按钮 / Enter + sim.respawn）', () => {
  assert.ok(/window\._exfilRespawn\s*=\s*function/.test(gameSrc), '必须暴露 window._exfilRespawn');
  assert.ok(gameSrc.includes("sim.respawn('solo')"), '单机重生必须调 sim.respawn("solo")');
  assert.ok(/case 'Enter'/.test(gameSrc), '阵亡态 Enter 必须绑定重生触发');
  assert.ok(htmlSrc.includes('id="summary-respawn"'), 'index.html 必须有重生按钮（单机用）');
  assert.ok(gameSrc.includes("document.getElementById('summary-respawn')"), '重生按钮必须注册进 DOM 注册表（E042）');
});

test('契约2 裁定: 联机不做重生（死亡=永久结算，属产品规则）', () => {
  assert.ok(!/type:\s*'respawn'/.test(gameSrc), '联机分支不得再发送 respawn 指令');
  assert.ok(!/m\.extracted \? 'none' : 'inline-block'/.test(gameSrc), '联机结算不得按 m.extracted 条件显示重生按钮');
  assert.ok(/dom\.summaryRespawn.*'none'/.test(gameSrc), '联机结算必须无条件隐藏重生按钮');
  assert.ok(/永久结算/.test(gameSrc), '联机阵亡文案必须明确告知永久结算规则');
});

test('契约2: index.html 帮助文本 R = 换弹（不再是错误的重生引导）', () => {
  assert.ok(htmlSrc.includes('<span class="keys">R</span> 换弹'), 'R 必须标注为换弹');
  assert.ok(!htmlSrc.includes('<span class="keys">R</span> 重生'), 'R 不得再标注为重生的旧引导');
});

test('契约4: index.html 三处版本号为 {{VERSION}} 占位符且无 v0.2.0 残留', () => {
  const tokens = (htmlSrc.match(/\{\{VERSION\}\}/g) || []).length;
  assert.equal(tokens, 3, 'title / 顶栏 chip / 帮助区标题三处必须为 {{VERSION}} 占位符（服务端注入）');
  assert.ok(!htmlSrc.includes('v0.2.0'), '页面不得残留 v0.2.0');
});

test('A7: game.js 不得出现 store.* 服务端变量引用', () => {
  const hits = gameSrc.match(/store\.[a-zA-Z_]+/g) || [];
  assert.deepEqual(hits, [], '发现服务端引用泄漏: ' + hits.join(', '));
});
