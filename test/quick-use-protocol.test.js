'use strict';
/*
 * test/quick-use-protocol.test.js — 契约1（快捷使用）服务端协议回归锁
 * ---------------------------------------------------------------------------
 * 规格（reports/接口契约_v0.15.0.md · 契约1）：
 *   C→S  { type:'quickUse', index }   index = 局内背包扁平数组下标（与 useItem 同构）
 *   - 分支条件必须写 `msg.type === 'quickUse' && ws.playerId`（E047 身份铁律：禁止连接级闭包身份变量）
 *   - 服务端只入队（pendingCommands），写操作只在 tick 边界
 *   - tick 消费：按 index 查 p.inventory，取 Items.LOOT[itemId] 的 heal / ammo 调 sim.quickUse
 *   sim 侧语义（src==='rig' 放行 / 背包拒绝）已由 test/quick-use.test.js 锁死，本文件只管「协议打通」。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

// CRLF 源文件：行级正则前先剥离 \r（E048）
function stripComments(src) {
  return src
    .replace(/\r/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*/, ''))
    .join('\n');
}

test('契约1: quickUse C→S 分支存在且以 ws.playerId 判定身份（E047）', () => {
  const code = stripComments(read('server/server.js'));
  assert.ok(
    /msg\.type === 'quickUse'\s*&&\s*ws\.playerId/.test(code),
    "必须写 msg.type === 'quickUse' && ws.playerId（否则服务器不消费该指令 / 违反 E047）"
  );
});

test('契约1: quickUse 分支只入队（写操作只在 tick 边界）', () => {
  const code = stripComments(read('server/server.js'));
  assert.ok(
    /pendingCommands\.push\(\{\s*kind:\s*'quickUse',\s*id:\s*ws\.playerId,\s*index:\s*msg\.index\s*\}\)/.test(code),
    "quickUse 必须 pendingCommands.push({ kind:'quickUse', id: ws.playerId, index: msg.index })（E027 队列纪律）"
  );
});

test('契约1: quickUse 分支位于 useItem 之后（指令分派区）', () => {
  const code = stripComments(read('server/server.js'));
  const iUse = code.indexOf("msg.type === 'useItem' && ws.playerId");
  const iQuick = code.indexOf("msg.type === 'quickUse' && ws.playerId");
  assert.ok(iUse >= 0 && iQuick > iUse, 'quickUse 分支应在 useItem 分支之后');
});

test('契约1: tick 消费 quickUse 按 index 查表并调用 sim.quickUse', () => {
  const code = stripComments(read('server/server.js'));
  assert.ok(/c\.kind === 'quickUse'/.test(code), "tick 消费分支必须判断 c.kind === 'quickUse'");
  assert.ok(/const it = p && p\.inventory\[c\.index\]/.test(code), '必须按 c.index 从局内背包查条目');
  assert.ok(/const def = Items\.LOOT\[it\.itemId\]/.test(code), '必须查 Items.LOOT[itemId] 取效果参数');
  assert.ok(/sim\.quickUse\(c\.id,\s*c\.index,/.test(code), '必须调 sim.quickUse(c.id, c.index, ...)');
});

test('契约1: tick 消费把 heal / ammo 按契约形状透传给 sim.quickUse', () => {
  const code = stripComments(read('server/server.js'));
  assert.ok(/def \? def\.heal \|\| 0 : 0/.test(code), 'heal 形状：def ? def.heal || 0 : 0');
  assert.ok(
    /def && def\.ammo \? \{ ammoId: def\.ammo\.ammoId, count: def\.ammo\.count \} : null/.test(code),
    'ammo 形状：def && def.ammo ? { ammoId, count } : null'
  );
});

test('契约1: quickUse 不得引入连接级闭包身份变量（E047 血泪）', () => {
  const code = stripComments(read('server/server.js'));
  assert.ok(!/\bmyId\b/.test(code), 'server.js 代码路径不得出现 myId，身份唯一数据源 = ws.playerId');
});

test('契约1: quickUse 不得改写既有 useItem 分支语义', () => {
  const code = stripComments(read('server/server.js'));
  assert.ok(
    /pendingCommands\.push\(\{\s*kind:\s*'useItem',\s*id:\s*ws\.playerId,\s*index:\s*msg\.index\s*\}\)/.test(code),
    'useItem 分支必须原样保留（契约1.2：useItem 保持原语义）'
  );
  assert.ok(/sim\.useItem\(c\.id,\s*c\.index,/.test(code), 'useItem tick 消费保持原样');
});