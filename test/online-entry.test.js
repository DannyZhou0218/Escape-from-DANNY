// E036 回归防线：联机入口必须启动渲染循环 + 指针锁定必须受保护
// 背景：联机流程不经过 startGame()，渲染循环从未启动 → 房主开局后 canvas 全黑（2026-09-19 用户实测报告）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

// 按大括号平衡抽取函数体（源码字面断言，防重构后断言失效）
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, `未找到函数 ${name}`);
  const s = src.indexOf('{', i);
  let d = 0;
  for (let j = s; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(s, j + 1); }
  }
  return '';
}

test('E036: 渲染循环以幂等方式启动（gameLoopStarted 守卫）', () => {
  const g = read('public/game.js');
  const body = fnBody(g, 'ensureGameLoop');
  assert.ok(g.includes('let gameLoopStarted'), '必须有 gameLoopStarted 标志');
  assert.ok(body.includes('if (gameLoopStarted) return'), 'ensureGameLoop 必须幂等（防重复 rAF 循环）');
  assert.ok(body.includes('animate()'), 'ensureGameLoop 必须启动渲染循环');
});

test('E036: 联机入口（大厅/创建房间）必须调用 enterOnlineMode', () => {
  const g = read('public/game.js');
  assert.ok(fnBody(g, 'showLanHall').includes('enterOnlineMode()'), '进入局域网大厅必须启动联机模式与渲染循环');
  assert.ok(fnBody(g, 'createRoom').includes('enterOnlineMode()'), '创建房间必须启动联机模式与渲染循环');
});

test('E036: enterOnlineMode 必须设定 mode=online 并启动循环', () => {
  const body = fnBody(read('public/game.js'), 'enterOnlineMode');
  assert.ok(body.includes("mode = 'online'"), '必须设置 mode 为 online（否则渲染循环会走 soloStep 且 sim 为空）');
  assert.ok(body.includes('ensureGameLoop()'), '必须启动渲染循环');
});

test('E036: startGame 不得直接调用 animate（统一走幂等启动器）', () => {
  const g = read('public/game.js');
  const body = fnBody(g, 'startGame');
  assert.ok(body.includes('ensureGameLoop()'), 'startGame 必须用 ensureGameLoop');
  assert.ok(!/[^e]animate\(\);/.test(body), 'startGame 不得直接调 animate()（会绕过幂等守卫）');
});

test('E036: requestPointerLock 必须吞掉异常（非用户手势会被拒）', () => {
  const body = fnBody(read('public/game.js'), 'requestPointerLock');
  assert.ok(body.includes('try'), '指针锁定必须 try 包裹：服务器 init 消息触发属非用户手势，浏览器会拒绝或抛错');
  assert.ok(body.includes('typeof r.catch'), 'Chrome 113+ 返回 Promise，必须 catch 掉 rejection');
  assert.ok(body.includes('catch'), '必须有 catch 分支');
});

test('E036: 进图提示包含鼠标锁定引导', () => {
  const g = read('public/game.js');
  assert.ok(g.includes('点击画面锁定鼠标'), '指针锁定可能被拒，必须提示用户点击画面');
});

test('E036: 提供渲染帧计数诊断入口', () => {
  assert.ok(read('public/game.js').includes('window.__frames'), '必须有 __frames 计数（联机黑屏自查：F12 输入 __frames）');
});

test('E036: 页面菜单的联机按钮存在且绑定联机入口', () => {
  const h = read('public/index.html');
  assert.ok(h.includes('id="enter-online"'), '菜单必须有局域网联机按钮');
  assert.ok(h.includes('_exfilShowLan'), '按钮必须绑定联机大厅入口');
});
