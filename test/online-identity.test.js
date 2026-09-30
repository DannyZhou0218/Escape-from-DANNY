// E047 回归防线：联机局内身份判定必须用 ws.playerId（每连接唯一、两条进图路径都写）
//
// 背景（2026-09-26 用户实测报告）：
//   「在线模式会强制移动回原位，而且我还能用移动来抵抗，就像一根绳子一样」
// 根因：server.js 的消息分发用连接闭包变量 myId 判定局内身份，而 myId **只在 join 直进路径**
//   被赋值；房间开局（= 实际游玩路径）只写 ws.playerId → myId 恒为 null
//   → `msg.type === 'input' && myId` 永远为假 → 服务器从不消费玩家输入
//   → 玩家在服务器侧纹丝不动，客户端每次和解都被拉回出生点 = 「橡皮筋」。
// 与 E038（断线清理错位）同源：当时只修了 close 路径，消息分发路径漏修。
//
// 本防线锁死：① 消息分发不得出现闭包 myId；② 所有局内指令分支必须用 ws.playerId；
//            ③ 连接处理内不得再声明 myId；④ enterRaid 必须写 ws.playerId（两条路径的共同落点）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

// 去掉注释与字符串字面量，避免注释里提到 myId 造成假阳性
// 注意：server.js 是 CRLF，必须先剥离行尾 \r，否则 `//.*$` 的 $ 锚点会因 \r 而不匹配
function stripComments(src) {
  return src
    .replace(/\r/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*/, ''))
    .join('\n');
}

test('E047: 消息分发不得再用连接闭包变量 myId（代码路径）', () => {
  const raw = read('server/server.js');
  const code = stripComments(raw);
  assert.ok(
    !/\blet\s+myId\b/.test(code),
    'server.js 不得再声明连接级 myId：它只在 join 路径被赋值，房间开局路径永远为 null（E047 根因）'
  );
  assert.ok(
    !/\bmyId\b/.test(code),
    'server.js 的代码路径不得再引用 myId，局内身份一律用 ws.playerId'
  );
});

test('E047: 连接处理内不得声明局内身份闭包变量', () => {
  const raw = read('server/server.js');
  const i = raw.indexOf("wss.on('connection'");
  assert.ok(i >= 0, '未找到 wss.on(connection)');
  // 取连接处理函数体（大括号平衡）
  const s = raw.indexOf('{', i);
  let d = 0, end = raw.length;
  for (let j = s; j < raw.length; j++) {
    if (raw[j] === '{') d++;
    else if (raw[j] === '}') { d--; if (d === 0) { end = j; break; } }
  }
  const body = stripComments(raw.slice(s, end));
  assert.ok(
    !/\blet\s+myId\b/.test(body) && !/\bconst\s+myId\b/.test(body) && !/\bvar\s+myId\b/.test(body),
    'wss.on(connection) 内不得声明 myId 之类的连接级身份变量（两条进图路径写法不一致 → 必有一路失效）'
  );
});

test('E047: 所有局内指令分支必须以 ws.playerId 判定身份', () => {
  const raw = read('server/server.js');
  const code = stripComments(raw);
  const branches = ['input', 'search', 'openContainer', 'takeFromContainer', 'useItem', 'dropItem', 'respawn'];
  for (const b of branches) {
    const re = new RegExp(`msg\\.type === '${b}'\\s*&&\\s*ws\\.playerId`);
    assert.ok(re.test(code), `「${b}」分支必须写 msg.type === '${b}' && ws.playerId（否则服务器不消费该指令）`);
  }
});

test('E047: join 与 startRaid 两条进图路径都必须经 enterRaid 落 ws.playerId', () => {
  const raw = read('server/server.js');
  const code = stripComments(raw);
  // enterRaid 内部必须写 ws.playerId（两条路径的共同落点）
  const i = code.indexOf('function enterRaid(');
  assert.ok(i >= 0, '未找到 enterRaid');
  const s = code.indexOf('{', i);
  let d = 0, end = code.length;
  for (let j = s; j < code.length; j++) {
    if (code[j] === '{') d++;
    else if (code[j] === '}') { d--; if (d === 0) { end = j; break; } }
  }
  const body = code.slice(s, end);
  assert.ok(body.includes('ws.playerId = id'), 'enterRaid 必须写 ws.playerId = id（join 与 startRaid 共用此落点）');

  // startRaid 必须为每个房员调用 enterRaid（从而写入 ws.playerId）
  const si = code.indexOf('function startRaid(');
  assert.ok(si >= 0, '未找到 startRaid');
  const ss = code.indexOf('{', si);
  let sd = 0, send = code.length;
  for (let j = ss; j < code.length; j++) {
    if (code[j] === '{') sd++;
    else if (code[j] === '}') { sd--; if (sd === 0) { send = j; break; } }
  }
  const sbody = code.slice(ss, send);
  assert.ok(sbody.includes('enterRaid('), 'startRaid 必须对每个房员调用 enterRaid（房间开局路径的身份来源）');
});

test('E047: input 分支必须把消息交给 sim.applyInput', () => {
  const code = stripComments(read('server/server.js'));
  assert.ok(
    /sim\.applyInput\(ws\.playerId,\s*msg\)/.test(code),
    'input 分支必须 sim.applyInput(ws.playerId, msg)：服务器消费输入才能让预测-和解收敛（否则表现为橡皮筋）'
  );
});
