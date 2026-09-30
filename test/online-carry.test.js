'use strict';
/*
 * test/online-carry.test.js — 契约5（G4）联机携带链 + 结算不吞弹药
 * ---------------------------------------------------------------------------
 * 规格（reports/接口契约_v0.15.0.md · 契约5）：
 *   ① 联机进图（server.js enterRaid）必须用 Items.takeCarryFromContainers(profile)，
 *      与单机路径一致；输出 { profile, raidAmmo, raidItems } 与旧 takeCarry 同构。
 *   ② takeCarryFromContainers 会从 profile.containers 扣除携带物 → 调用后必须落盘
 *      （saveProfileAsync），否则玩家重进/崩溃即可刷物资。
 *   ③ 结算侧 settleCarry 整体接收（Object.assign(result, settledCarry)），不得退回 .ammoLib 单字段写法。
 *
 * 本文件三层防线：
 *   A. 纯函数：takeCarryFromContainers 读 rig/backpack 实体条目并清空容器（不修改入参）。
 *   B. 源码字面：enterRaid 用 takeCarryFromContainers 且随后落盘；结算整体接收。
 *   C. 端到端：真起 server（随机端口）→ ws join → 读 init / dropItem 事件 / 磁盘档案，
 *      验证「联机路径读到容器携带物 + 档案已扣除并落盘」。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const Items = require('../shared/items');
const Loadout = require('../shared/loadout');
const Grid = require('../shared/grid');
const { saveProfile } = require('../server/data');
const { GameSim } = require('../shared/sim');

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
// 大括号平衡抽取函数体（源码字面断言，防重构后失效）
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, '未找到函数 ' + name);
  const s = src.indexOf('{', i);
  let d = 0;
  for (let j = s; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(s, j + 1); }
  }
  return '';
}

// 抽取「含签名的完整函数源码」（供 new Function 真跑；fnBody 只给函数体）
function fnSource(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, '未找到函数 ' + name);
  const s = src.indexOf('{', i);
  let d = 0;
  for (let j = s; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(i, j + 1); }
  }
  return '';
}

// ---------- 夹具：带胸挂 + 背包，容器内各放实体条目 ----------
function buildCarryProfile(id) {
  const p = Items.defaultProfile('carrytest');
  p.id = id;
  p.name = 'carrytest';
  p.stash.push({ itemId: 'rig_scav' });
  p.stash.push({ itemId: 'bp_scav' });
  let s = Loadout.syncProfile(p).profile;
  s = Loadout.equipUid(s, s.grid.items.find((e) => e.itemId === 'rig_scav').uid, 'rig').profile;
  s = Loadout.equipUid(s, s.grid.items.find((e) => e.itemId === 'bp_scav').uid, 'backpack').profile;
  assert.ok(s.containers && s.containers.rig && s.containers.backpack, '胸挂/背包容器必须建立');
  // 胸挂内 1 条实体绷带（联机进图后应是局内背包 index 0）
  s.containers.rig.items.push({ uid: Grid.makeUid(), itemId: 'bandage', x: 0, y: 0, rot: 0, count: 3 });
  // 背包内 30 发实体弹药（联机进图后应进入局内弹药，raidAmmo / 快照 ammoLib）
  s.containers.backpack.items.push({ uid: Grid.makeUid(), itemId: '545x39', x: 0, y: 0, rot: 0, count: 30 });
  return s;
}

// ---------- A. 纯函数 ----------
test('契约5: takeCarryFromContainers 读 rig/backpack 实体条目并清空容器（不修改入参）', () => {
  const p = buildCarryProfile('pure_carry');
  const r = Items.takeCarryFromContainers(p);
  assert.equal(r.raidAmmo['545x39'], 30, '背包弹药应进入 raidAmmo');
  const bandage = r.raidItems.find((i) => i.itemId === 'bandage');
  assert.ok(bandage, '胸挂绷带应进入 raidItems');
  assert.equal(bandage.src, 'rig', '来源必须标记为 rig（供胸挂快捷使用）');
  assert.equal(bandage.count, 3, '数量应完整带出');
  assert.equal(r.profile.containers.rig.items.length, 0, '扣除后胸挂必须清空');
  assert.equal(r.profile.containers.backpack.items.length, 0, '扣除后背包必须清空');
  assert.equal(r.profile.containers.rig.w, 4, '清空后容器空间规格应保留');
  assert.equal(p.containers.rig.items.length, 1, '入参档案不得被修改（纯函数）');
});

test('契约5: settleCarry 撤离时把局内剩余弹药实体归仓（不吞弹药）', () => {
  const base = { id: 'x', name: 'x', money: 0, stash: [], ammoLib: {} };
  const out = Items.settleCarry(base, { extracted: true, raidAmmo: { '545x39': 12, '9x18': 0 } });
  const stack = out.stash.find((s) => s.itemId === '545x39');
  assert.ok(stack, '撤离剩余弹药必须实体归仓（不得被 .ammoLib 单字段写法吞掉）');
  assert.equal(stack.count, 12, '归仓数量应等于局内剩余');
  assert.equal(out.ammoLib['545x39'], 12, '派生 ammoLib 必须反映归仓弹药');
  assert.ok(!out.stash.find((s) => s.itemId === '9x18'), '0 发不得凭空造条');
});

test('契约5: settleCarry 撤离弹药并回已有同口径堆叠（数量守恒）', () => {
  const base = { id: 'x', name: 'x', money: 0, stash: [{ itemId: '545x39', count: 5 }], ammoLib: {} };
  const out = Items.settleCarry(base, { extracted: true, raidAmmo: { '545x39': 7 } });
  assert.equal(out.stash.filter((s) => s.itemId === '545x39').length, 1, '应并回已有堆叠');
  assert.equal(out.stash.find((s) => s.itemId === '545x39').count, 12, '5 + 7 = 12');
});

test('契约5: settleCarry 阵亡不归还携带弹药（已进图扣除）', () => {
  const base = { id: 'x', name: 'x', money: 0, stash: [], ammoLib: {} };
  const out = Items.settleCarry(base, { extracted: false, raidAmmo: { '545x39': 12 } });
  assert.ok(!(out.stash || []).find((s) => s.itemId === '545x39'), '阵亡不得归还弹药');
});

// ---------- B. 源码字面断言 ----------
test('契约5: enterRaid 必须用 takeCarryFromContainers（联机与单机对齐）', () => {
  const body = fnBody(stripComments(read('server/server.js')), 'enterRaid');
  assert.ok(body.includes('Items.takeCarryFromContainers(profile)'), 'enterRaid 必须调用 Items.takeCarryFromContainers(profile)');
  assert.ok(!/Items\.takeCarry\(profile,\s*profile\.carry\)/.test(body), '不得再走旧的 takeCarry(profile, profile.carry)');
});

test('契约5: 携带物扣除后必须落盘（saveProfileAsync 在 takeCarryFromContainers 之后）', () => {
  const body = fnBody(stripComments(read('server/server.js')), 'enterRaid');
  const iTake = body.indexOf('Items.takeCarryFromContainers(profile)');
  const iSave = body.indexOf('saveProfileAsync(profile)');
  assert.ok(iTake >= 0, '未找到 takeCarryFromContainers');
  assert.ok(iSave > iTake, 'takeCarryFromContainers 之后必须 saveProfileAsync(profile)：否则可刷物资');
});

test('契约5: 结算整体接收 settleCarry 结果（不得退回 .ammoLib 单字段写法）', () => {
  const code = stripComments(read('server/server.js'));
  assert.ok(/Object\.assign\(\s*result,\s*settledCarry\s*\)/.test(code), '必须 Object.assign(result, settledCarry) 整体接收');
  assert.ok(/=\s*Items\.settleCarry\(result,\s*\{/.test(code), 'settleCarry 必须接收完整 result 档案');
  assert.ok(!/settleCarry\([^)]*\)\s*\.ammoLib/.test(code), '不得只取 settleCarry 结果的 .ammoLib（会丢掉归仓弹药）');
});

// ---------- A2. 契约7 · 护甲进局接线（svr-dev 侧） ----------
function buildArmorProfile(id) {
  const p = Items.defaultProfile('armortest');
  p.id = id;
  p.name = 'armortest';
  p.stash.push({ itemId: 'armor_paca' });
  p.stash.push({ itemId: 'helm_ssh68' });
  let s = Loadout.syncProfile(p).profile;
  s = Loadout.equipUid(s, s.grid.items.find((e) => e.itemId === 'armor_paca').uid, 'armor').profile;
  s = Loadout.equipUid(s, s.grid.items.find((e) => e.itemId === 'helm_ssh68').uid, 'head').profile;
  return s;
}

test('契约7: takeCarryFromContainers 带出档案护具 raidArmor（armor + helm）', () => {
  const s = buildArmorProfile('armor_pure');
  const r = Items.takeCarryFromContainers(s);
  assert.ok(r.raidArmor, '必须返回 raidArmor');
  assert.ok(r.raidArmor.armor, '护甲必须带出');
  assert.equal(r.raidArmor.armor.itemId, 'armor_paca');
  assert.equal(r.raidArmor.armor.armorClass, 2);
  assert.equal(r.raidArmor.armor.durNow, 30);
  assert.equal(r.raidArmor.armor.durMax, 30);
  assert.deepEqual(r.raidArmor.armor.cover, ['chest']);
  assert.equal(r.raidArmor.armor.name, 'PACA 软甲');
  assert.ok(r.raidArmor.helm, '头盔必须带出');
  assert.equal(r.raidArmor.helm.itemId, 'helm_ssh68');
  assert.deepEqual(r.raidArmor.helm.cover, ['head']);
  assert.equal(r.raidArmor.helm.durNow, 20);
});

test('契约7: 无护具档案 raidArmor = {armor:null, helm:null}（缺字段不抛异常）', () => {
  const r = Items.takeCarryFromContainers(Items.defaultProfile('naked'));
  assert.deepEqual(r.raidArmor, { armor: null, helm: null });
  assert.doesNotThrow(() => Items.takeCarryFromContainers({}));
});

test('契约7: enterRaid 把 raidArmor 透传给 sim.addPlayer（联机进局）', () => {
  const body = fnBody(stripComments(read('server/server.js')), 'enterRaid');
  assert.ok(/raidArmor\s*=\s*carried\.raidArmor/.test(body), 'enterRaid 必须从携带结果取 raidArmor');
  assert.ok(/sim\.addPlayer\([\s\S]*?raidArmor:\s*raidArmor/.test(body), 'sim.addPlayer 必须透传 raidArmor');
});

test('契约7: 撤离成功才回写护具耐久（阵亡不回写）', () => {
  const code = stripComments(read('server/server.js'));
  assert.ok(/if \(extracted\)\s*writebackArmorDurability\(result,\s*playerId\)/.test(code), '仅撤离成功调用回写');
});

test('契约7: writebackArmorDurability 把局内 durNow 写回档案（缺字段静默）', () => {
  const src = stripComments(read('server/server.js'));
  const fakeSim = { players: new Map([['p1', { armor: { armor: { durNow: 12, durMax: 30, armorClass: 2, cover: ['chest'] }, helm: null } }]]) };
  const fn = new Function('sim', fnSource(src, 'writebackArmorDurability') + '\nreturn writebackArmorDurability;')(fakeSim);
  const profile = { equipment: { armor: { uid: 'u1', itemId: 'armor_paca', durNow: 30, durMax: 30, armorClass: 2, cover: ['chest'] }, head: null } };
  fn(profile, 'p1');
  assert.equal(profile.equipment.armor.durNow, 12, 'durNow 必须回写局内磨损值');
  assert.doesNotThrow(() => fn(profile, 'nobody'), '读不到玩家必须静默');
  assert.doesNotThrow(() => fn({ equipment: null }, 'p1'), '档案缺 equipment 必须静默');
  assert.doesNotThrow(() => fn(null, 'p1'), '档案为 null 必须静默');
});

test('契约7: raidArmor（items 输出）可被 sim.addPlayer 接受并进入快照', () => {
  const s = buildArmorProfile('armor_sim');
  const r = Items.takeCarryFromContainers(s);
  const sim = new GameSim({ testMode: true });
  const p = sim.addPlayer('aaaaaa', 'A', { raidArmor: r.raidArmor });
  assert.ok(p.armor && p.armor.armor, '护甲必须进入局内实例');
  assert.equal(p.armor.armor.itemId, 'armor_paca');
  assert.equal(p.armor.armor.durNow, 30);
  assert.ok(p.armor.helm, '头盔必须进入局内实例');
  assert.equal(p.armor.helm.itemId, 'helm_ssh68');
  const snap = sim.snapshot().players[0];
  assert.deepEqual(snap.armor, { armor: 30, helm: 20 }, '快照 armor 供 HUD 读取（durNow）');
});

// ---------- C. 端到端（真起 server） ----------
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}
function getHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function waitHealth(port, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    if (await getHealth(port)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('server 启动超时（' + timeoutMs + 'ms）');
    await new Promise((r) => setTimeout(r, 150));
  }
}
function nextOfType(ws, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error('等待 ' + type + ' 超时')); }, timeoutMs);
    function h(buf) {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m && m.type === type) { clearTimeout(t); ws.off('message', h); resolve(m); }
    }
    ws.on('message', h);
  });
}
async function waitUntil(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try { if (fn()) return; } catch (e) { /* 文件可能尚未写入 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('超时：' + label);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('契约5（端到端）: 联机进图读到 rig/backpack 实体携带物 + 扣除落盘', { timeout: 30000 }, async () => {
  const WebSocket = require('ws');
  // server.js 的档案 key 会 slice(0, 24) → 测试 id 必须短于该截断线
  const id = '__itc_' + process.pid.toString(36) + Date.now().toString(36);
  assert.ok(id.length < 24, '测试档案 key 必须短于 server 的 24 字符截断线');
  const profilePath = path.join(ROOT, 'data', 'profiles', id + '.json');
  const port = await freePort();
  let child = null, ws = null, bootLog = '';
  try {
    saveProfile(buildCarryProfile(id)); // 落一份「容器内有携带物」的档案

    child = spawn(process.execPath, ['server/server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), EXFIL_TEST: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (d) => { bootLog += d.toString(); });
    child.stderr.on('data', (d) => { bootLog += d.toString(); });
    await waitHealth(port, 15000);

    ws = new WebSocket('ws://127.0.0.1:' + port);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    const initP = nextOfType(ws, 'init', 8000);
    ws.send(JSON.stringify({ type: 'join', id, name: 'carrytest', stashIndex: -1 }));
    const init = await initP;

    // ① 联机路径读到背包实体弹药 → 局内快照 ammoLib 反映
    const me = init.players.find((p) => p.id === init.id) || init.players[0];
    assert.ok(me, 'init 快照应含本玩家');
    assert.equal(me.ammoLib['545x39'], 30, '背包 30 发弹药必须进入局内弹药（联机路径读到容器携带物）');

    // ② quickUse 协议端到端：胸挂绷带应被快捷使用（E047 身份 + E027 tick 队列）
    const usedP = nextOfType(ws, 'usedItem', 6000);
    ws.send(JSON.stringify({ type: 'quickUse', index: 0 }));
    const used = await usedP;
    assert.equal(used.id, init.id, 'quickUse 事件应属于本玩家（ws.playerId 身份）');
    assert.equal(used.itemId, 'bandage', 'quickUse 必须命中胸挂内实体绷带');
    assert.equal(used.remaining, 2, 'quickUse 应消耗 1 件（3 → 2）');

    // ③ 联机路径读到胸挂实体绷带 → 局内背包 index 0 可丢弃出 bandage
    const dropP = nextOfType(ws, 'droppedItem', 6000);
    ws.send(JSON.stringify({ type: 'dropItem', index: 0 }));
    const dropped = await dropP;
    assert.equal(dropped.id, init.id, '事件应属于本玩家');
    assert.equal(dropped.itemId, 'bandage', '胸挂绷带应作为局内 index 0 实体携带物');

    // ④ 扣除：init.profile 容器已清空
    assert.equal(init.profile.containers.rig.items.length, 0, '下发档案的胸挂应已扣除');
    assert.equal(init.profile.containers.backpack.items.length, 0, '下发档案的背包应已扣除');

    // ⑤ 落盘：磁盘档案的容器也被清空（否则重进可刷物资）
    await waitUntil(() => {
      const disk = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
      return disk.containers && disk.containers.rig && disk.containers.rig.items.length === 0
        && disk.containers.backpack && disk.containers.backpack.items.length === 0;
    }, 6000, '携带物扣除必须落盘（saveProfileAsync）');
  } catch (e) {
    e.message = e.message + '\n--- server boot log ---\n' + bootLog;
    throw e;
  } finally {
    if (ws) { try { ws.close(); } catch (e) {} }
    if (child) {
      const exited = new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); });
      try { child.kill(); } catch (e) {}
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    }
    // 服务端 saveProfileAsync 可能晚于 kill 落盘 → 重试清理，避免测试残留档案（失败路径也要清干净）
    for (let k = 0; k < 20; k++) {
      try { fs.unlinkSync(profilePath); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
    }
  }
});