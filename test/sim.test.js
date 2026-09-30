/*
 * EXFIL ZONE · GameSim 单元测试（单机/联机共用的模拟层）
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GameSim } = require('../shared/sim');

function makeSim() {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { weapon: akWeapon(30) });
  sim.addPlayer('bbbbbb', 'B');
  return sim;
}

test('GameSim: 加入玩家与快照', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  sim.addPlayer('bbbbbb', 'B');
  assert.equal(sim.players.size, 2);
  const snap = sim.snapshot();
  assert.equal(snap.players.length, 2);
  // 测试模式出生点确定性：A、B 间距恰 10m
  const a = snap.players.find(p => p.id === 'aaaaaa');
  const b = snap.players.find(p => p.id === 'bbbbbb');
  assert.equal(Math.abs(a.x - b.x), 10);
});

test('GameSim: 输入前进产生位移（60Hz 物理）', () => {
  const sim = makeSim();
  const a0 = sim.players.get('aaaaaa');
  const x0 = a0.x, z0 = a0.z;
  sim.applyInput('aaaaaa', { keys: { f: 1, b: 0, l: 0, r: 0 }, yaw: 0, pitch: 0 });
  for (let i = 0; i < 60; i++) sim.tick(1 / 60); // 1 秒
  const moved = Math.hypot(a0.x - x0, a0.z - z0);
  assert.ok(moved > 5 && moved < 7, `1 秒位移应约 6m，实际 ${moved.toFixed(2)}m`);
});

test('GameSim: A/D 方向正确（l 向左 = 相机左）', () => {
  const sim = makeSim();
  const p = sim.players.get('aaaaaa');
  p.yaw = 0; // 面向 -Z
  const x0 = p.x, z0 = p.z;
  sim.applyInput('aaaaaa', { keys: { f: 0, b: 0, l: 1, r: 0 }, yaw: 0, pitch: 0 });
  for (let i = 0; i < 30; i++) sim.tick(1 / 60); // 0.5 秒
  // 相机左 = 世界 +X（面向 -Z 时右为 +X，左为 -X）→ l 应朝 -X
  assert.ok(p.x < x0 - 1, `按 A 应向左（-X），实际 x 变化 ${(p.x - x0).toFixed(2)}`);
  assert.ok(Math.abs(p.z - z0) < 1, '按 A 不应前后移动');
});

test('GameSim: 跳跃与落地', () => {
  const sim = makeSim();
  const p = sim.players.get('aaaaaa');
  const y0 = p.y;
  sim.applyInput('aaaaaa', { keys: {}, jump: true, yaw: 0, pitch: 0 });
  sim.tick(1 / 60);
  assert.ok(p.vy > 0, '起跳应有向上速度');
  let maxY = p.y;
  for (let i = 0; i < 120; i++) { sim.tick(1 / 60); maxY = Math.max(maxY, p.y); }
  assert.ok(maxY > y0 + 0.8, `跳跃最高应 >0.8m，实际 ${(maxY - y0).toFixed(2)}m`);
  assert.ok(Math.abs(p.y - y0) < 0.01, '落地回到地面');
});

test('GameSim: 射击命中与伤害（测试模式开阔可见）', () => {
  const sim = makeSim();
  const a = sim.players.get('aaaaaa');
  const b = sim.players.get('bbbbbb');
  // A 面向 B（yaw 指向 B）
  const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
  a.yaw = yaw;
  const hpBefore = b.hp;
  sim.applyInput('aaaaaa', { keys: {}, yaw, pitch: 0, fire: true });
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  const evs = sim.drainEvents();
  const hit = evs.find(e => e.type === 'hit' && e.shooter === 'aaaaaa');
  assert.ok(hit, '应有命中事件');
  assert.equal(hit.target, 'bbbbbb');
  assert.equal(b.hp, hpBefore - 24);
});

test('GameSim: 射击冷却 250ms（连发不超伤害）', () => {
  const sim = makeSim();
  const a = sim.players.get('aaaaaa');
  const b = sim.players.get('bbbbbb');
  const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
  a.yaw = yaw;
  for (let i = 0; i < 5; i++) { sim.applyInput('aaaaaa', { keys: {}, yaw, pitch: 0, fire: true }); sim.tick(1 / 60); } // E021：每输入一步
  const hits = sim.drainEvents().filter(e => e.type === 'hit');
  assert.equal(hits.length, 1, '250ms 冷却内只应命中 1 次');
  assert.equal(b.hp, 76);
});

test('GameSim: 死亡后不可移动/射击', () => {
  const sim = makeSim();
  const b = sim.players.get('bbbbbb');
  b.hp = 5; b.alive = true;
  const a = sim.players.get('aaaaaa');
  const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
  a.yaw = yaw;
  sim.applyInput('aaaaaa', { keys: {}, yaw, pitch: 0, fire: true });
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  assert.equal(b.alive, false, '被打死');
  const x0 = b.x;
  sim.applyInput('bbbbbb', { keys: { f: 1, b: 0, l: 0, r: 0 }, yaw: 0, pitch: 0 });
  for (let i = 0; i < 30; i++) sim.tick(1 / 60);
  assert.ok(Math.abs(b.x - x0) < 0.01, '死亡后不应移动');
});

test('GameSim: respawn 恢复', () => {
  const sim = makeSim();
  const b = sim.players.get('bbbbbb');
  b.hp = 0; b.alive = false;
  sim.respawn('bbbbbb');
  assert.equal(b.alive, true);
  assert.equal(b.hp, 100);
});

test('GameSim: 事件 drain 机制', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  const evs = sim.drainEvents();
  assert.ok(evs.some(e => e.type === 'playerJoin'));
  assert.equal(sim.drainEvents().length, 0, 'drain 后清空');
});

// ---------- M1a 武器系统 ----------
function akWeapon(ammoCount = 30) {
  return { dmg: 24, ammo: { ammoId: '545x39', count: ammoCount }, magSize: 30 };
}
test('GameSim: 带武器射击用武器伤害并消耗弹药', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { weapon: akWeapon(5) });
  sim.addPlayer('bbbbbb', 'B');
  const a = sim.players.get('aaaaaa');
  const b = sim.players.get('bbbbbb');
  const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
  a.yaw = yaw;
  sim.applyInput('aaaaaa', { keys: {}, yaw, pitch: 0, fire: true });
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  const evs = sim.drainEvents();
  const hit = evs.find(e => e.type === 'hit');
  assert.equal(hit.dmg, 24, '应使用武器伤害 24');
  assert.equal(b.hp, 100 - 24);
  assert.equal(a.weapon.ammo.count, 4, '弹药应消耗 1 发');
  assert.ok(evs.some(e => e.type === 'ammo' && e.count === 4), '应广播弹药剩余');
});
test('GameSim: 弹尽后不可开火（empty 事件）', () => {
  const sim = new GameSim({ testMode: true, shotCooldown: 0 }); // 冷却关掉以测弹药逻辑
  sim.addPlayer('aaaaaa', 'A', { weapon: akWeapon(1) });
  sim.addPlayer('bbbbbb', 'B');
  const a = sim.players.get('aaaaaa');
  const b = sim.players.get('bbbbbb');
  const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
  a.yaw = yaw;
  sim.applyInput('aaaaaa', { keys: {}, yaw, pitch: 0, fire: true }); // 打 1 发
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  sim.drainEvents();
  sim.applyInput('aaaaaa', { keys: {}, yaw, pitch: 0, fire: true }); // 弹尽
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  const evs = sim.drainEvents();
  assert.ok(evs.some(e => e.type === 'empty'), '应触发 empty 事件');
  assert.equal(b.hp, 76, '第二发不应造成伤害');
});
test('GameSim: 无武器不能开枪（塔克夫规则，防止虚空开枪）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  sim.addPlayer('bbbbbb', 'B');
  const a = sim.players.get('aaaaaa');
  const b = sim.players.get('bbbbbb');
  const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
  a.yaw = yaw;
  sim.applyInput('aaaaaa', { keys: {}, yaw, pitch: 0, fire: true });
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  const evs = sim.drainEvents();
  assert.ok(!evs.some(e => e.type === 'hit'), '无武器不得命中');
  assert.ok(!evs.some(e => e.type === 'sound' && e.kind === 'shot'), '无武器不得有枪声');
  assert.equal(b.hp, 100, '目标不掉血');
});
test('GameSim: 装备背包武器后可以开枪（equipWeapon 全链路）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', {
    inventory: [{ itemId: 'w_ak74', isWeapon: true, count: 1, weaponId: 'ak74', dmg: 24, fireRate: 550, magSize: 30, ammoType: '545x39', slots: ['sight', 'mag'], ammo: { ammoId: '545x39', count: 10 } }]
  });
  sim.addPlayer('bbbbbb', 'B');
  const a = sim.players.get('aaaaaa');
  const b = sim.players.get('bbbbbb');
  assert.equal(a.weapon, null, '初始徒手');
  // 装备
  const r = sim.useItem('aaaaaa', 0, 0, null);
  assert.ok(r && r.equipped, '装备应成功');
  assert.equal(a.weapon.weaponId, 'ak74');
  assert.equal(a.inventory.length, 0, '武器条目应从背包移除');
  // 装备后开枪
  const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
  a.yaw = yaw;
  sim.applyInput('aaaaaa', { keys: {}, yaw, pitch: 0, fire: true });
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  const evs = sim.drainEvents();
  assert.ok(evs.some(e => e.type === 'hit'), '装备后应能命中');
  assert.equal(a.weapon.ammo.count, 9, '消耗 1 发');
});
test('GameSim: 换枪时旧武器转背包（可再装备）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'ak74', name: 'AK-74', dmg: 24, fireRate: 550, magSize: 30, slots: [], ammo: { ammoId: '545x39', count: 5 } } });
  const a = sim.players.get('aaaaaa');
  a.inventory.push({ itemId: 'w_pm', isWeapon: true, count: 1, weaponId: 'pm', dmg: 14, fireRate: 320, magSize: 8, ammoType: '9x18', slots: ['mag'], ammo: { ammoId: '9x18', count: 3 } });
  sim.useItem('aaaaaa', 0, 0, null);
  assert.equal(a.weapon.weaponId, 'pm', '新枪装备');
  assert.equal(a.weapon.ammo.count, 3);
  assert.ok(a.inventory.some(i => i.isWeapon && i.weaponId === 'ak74'), '旧 AK 应转背包');
  const oldAk = a.inventory.find(i => i.isWeapon && i.weaponId === 'ak74');
  assert.equal(oldAk.ammo.count, 5, '旧枪弹药保留');
});

// ---------- 枪声与弹药消耗一致性（用户反馈修复验证，真实时间） ----------
test('GameSim: 真实时间持续开火 — 枪声事件数 = 弹药消耗数（一枪一响）', async () => {
  const { makeWeaponInstance, defaultStash } = require('../shared/items');
  const inst = makeWeaponInstance(defaultStash()[0]); // 60 发
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { weapon: inst });
  let shots = 0, consumedTotal = 0;
  for (let i = 0; i < 6; i++) {
    const before = inst.ammo.count;
    sim.applyInput('aaaaaa', { keys: {}, yaw: 0, pitch: 0, fire: true });
    sim.tick(1 / 60);
    consumedTotal += before - inst.ammo.count;
    for (const ev of sim.drainEvents()) {
      if (ev.type === 'sound' && ev.kind === 'shot') shots++;
    }
    await new Promise(r => setTimeout(r, 260)); // > 250ms 冷却
  }
  assert.equal(shots, 6, `应 6 声枪响（实际 ${shots}）`);
  assert.equal(consumedTotal, 6, `应消耗 6 发（实际 ${consumedTotal}）`);
  assert.equal(shots, consumedTotal, '枪声与消耗必须一一对应');
});

// ---------- M2a SCAV 生成与巡逻 ----------
test('GameSim: spawnScavs 生成合法（数量/位置可站立不卡方块）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  sim.spawnScavs(4);
  assert.equal(sim.scavs.size, 4);
  for (const s of sim.scavs.values()) {
    assert.ok(s.alive, 'SCAV 存活');
    assert.ok(s.waypoints.length >= 4, '巡逻路线 ≥4 点');
    assert.equal(typeof s.x, 'number');
  }
});
test('GameSim: SCAV 巡逻移动（tick 后位置变化 + waypoint 切换）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  sim.spawnScavs(1);
  const s = sim.scavs.values().next().value;
  // 明确远点路由（跳过"出生即到达生成点"的暂停），确保移动
  s.x = 0; s.z = 0; s.wpPause = 0;
  s.waypoints = [{ x: 12, z: 12 }, { x: -12, z: -12 }]; s.wpIndex = 0;
  const x0 = s.x, z0 = s.z;
  let moved = false;
  for (let i = 0; i < 120 && !moved; i++) {
    sim.tick(1 / 60);
    if (Math.hypot(s.x - x0, s.z - z0) > 0.1) moved = true;
  }
  assert.ok(moved, 'SCAV 应发生移动');
});
test('GameSim: SCAV 到达 waypoint 后切换并暂停', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  sim.players.get('aaaaaa').x = 60; sim.players.get('aaaaaa').z = 60; // 玩家远离（防 combat 干扰）
  sim.spawnScavs(1);
  const s = sim.scavs.values().next().value;
  s.wpPause = 0;
  const wp0 = s.waypoints[0];
  s.x = wp0.x; s.z = wp0.z;
  sim.tick(1 / 60);
  assert.notEqual(s.wpIndex, 0, '到达后应切换到下一 waypoint');
  assert.ok(s.wpPause > 0, '切换后应暂停');
});
test('GameSim: SCAV 不穿透方块（碰撞复用）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  sim.spawnScavs(1);
  const s = sim.scavs.values().next().value;
  // 北墙 x∈[4,14] 是实心段（门洞在 x∈(-4,4)）——x=8 应被挡住
  s.x = 8; s.y = 0; s.z = -6; s.wpPause = 0;
  s.waypoints = [{ x: 8, z: -40 }]; s.wpIndex = 0;
  for (let i = 0; i < 300; i++) sim.tick(1 / 60);
  assert.ok(s.z > -9.3, 'SCAV 不应穿墙');
});
test('GameSim: snapshot 含 scavs 列表', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  sim.spawnScavs(3);
  const snap = sim.snapshot();
  assert.equal(snap.scavs.length, 3);
  assert.ok(snap.scavs[0].id.startsWith('scav_'));
});

// ---------- 换弹系统（v0.6.11） ----------
test('换弹: 弹匣打空后 reload 补满（备弹减少）', async () => {
  const sim = new GameSim({ testMode: true, shotCooldown: 0 });
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'ak74', name: 'AK-74', dmg: 24, magSize: 30, slots: [], ammo: { ammoId: '545x39', count: 3, reserve: 30 } } });
  const a = sim.players.get('aaaaaa');
  // 打空弹匣（3 发）
  for (let i = 0; i < 3; i++) { sim.applyInput('aaaaaa', { keys: {}, yaw: 0, pitch: 0, fire: true }); sim.tick(1 / 60); } // E021：每输入一步
  assert.equal(a.weapon.ammo.count, 0, '弹匣打空');
  assert.equal(a.ammoLib['545x39'], 30, '弹药库 30 发');
  // 换弹
  sim.applyInput('aaaaaa', { keys: {}, yaw: 0, pitch: 0, reload: true });
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  assert.equal(a.reloading, true, '进入换弹');
  // 等 1.6s 完成
  await new Promise(r => setTimeout(r, 1600));
  sim.tick(1 / 60);
  assert.equal(a.reloading, false, '换弹完成');
  assert.equal(a.weapon.ammo.count, 30, '弹匣补满');
  assert.equal(a.ammoLib['545x39'] || 0, 0, '背包弹药 30 全部装入弹匣（派生库归零）');
});
test('换弹: 换弹中不能开枪', async () => {
  const sim = new GameSim({ testMode: true, shotCooldown: 0 });
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'pm', name: 'PM', dmg: 14, magSize: 8, slots: [], ammo: { ammoId: '9x18', count: 8, reserve: 8 } } });
  sim.addPlayer('bbbbbb', 'B');
  const a = sim.players.get('aaaaaa'), b = sim.players.get('bbbbbb');
  // 清空弹匣
  for (let i = 0; i < 8; i++) { sim.applyInput('aaaaaa', { keys: {}, yaw: 0, pitch: 0, fire: true }); sim.tick(1 / 60); } // E021：每输入一步
  assert.equal(a.weapon.ammo.count, 0);
  // 换弹中尝试开枪
  sim.applyInput('aaaaaa', { keys: {}, yaw: 0, pitch: 0, reload: true });
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
  a.yaw = yaw;
  sim.applyInput('aaaaaa', { keys: {}, yaw, pitch: 0, fire: true });
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  const evs = sim.drainEvents();
  assert.ok(!evs.some(e => e.type === 'hit'), '换弹中不得命中');
  assert.equal(b.hp, 100, 'B 不掉血');
});
test('换弹: 弹匣满或备弹 0 时 reload 无效', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'ak74', name: 'AK-74', dmg: 24, fireRate: 650, magSize: 30, slots: [], ammo: { ammoId: '545x39', count: 30, reserve: 10 } } });
  const a = sim.players.get('aaaaaa');
  sim.applyInput('aaaaaa', { keys: {}, yaw: 0, pitch: 0, reload: true });
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  assert.ok(!a.reloading, '满弹匣不应进入换弹');
});

// ---------- 弹药箱补备弹（v0.6.12 商人经济配套） ----------
test('使用: 弹药箱拆包入背包（不直接进弹匣）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'ak74', name: 'AK-74', dmg: 24, fireRate: 650, magSize: 30, slots: [], ammo: { ammoId: '545x39', count: 10, reserve: 5 } } });
  const a = sim.players.get('aaaaaa');
  a.inventory.push({ itemId: 'ammo_box_545', count: 1, weight: 0.5 });
  const boxIdx = a.inventory.findIndex(x => x.itemId === 'ammo_box_545');
  sim.useItem('aaaaaa', boxIdx, 0, { ammoId: '545x39', count: 30 });
  assert.equal(a.weapon.ammo.count, 10, '弹匣内不变');
  assert.equal(a.ammoLib['545x39'], 35, '背包弹药 5+30=35（E045：拆包入背包实体堆叠）');
});

// ---------- 弹药自动补备弹（v0.6.13 用户反馈修复） ----------
test('拾取: 弹药箱拆包成实体堆叠入背包（占背包格）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'ak74', name: 'AK-74', dmg: 24, fireRate: 650, magSize: 30, slots: [], ammo: { ammoId: '545x39', count: 12, reserve: 5 } } });
  const a = sim.players.get('aaaaaa');
  const box = { id: 'box_t', x: 2, z: 0, label: '弹药箱', looted: false,
    loot: [{ itemId: 'ammo_box_545', weight: 0.5, count: 1, ammo: { ammoId: '545x39', count: 30 } }] };
  sim.containers.push(box);
  a.x = 2; a.z = 0;
  sim.interactContainer('aaaaaa', 'box_t');
  assert.equal(a.ammoLib['545x39'], 35, '弹药库 5+30=35');
  assert.equal(a.weapon.ammo.count, 12, '弹匣不变');
  assert.equal(a.inventory.length, 1, '弹药以实体堆叠进背包');
  assert.equal(a.inventory[0].count, 35, '5 + 30 = 35 发合并成一叠（stackMax 内）');
  const ev = sim.drainEvents().find(e => e.type === 'ammoRefilled');
  assert.ok(ev, '应触发 ammoRefilled 事件');
  assert.equal(ev.reserve['545x39'], 35);
});
test('拾取: 异口径弹药箱 → 拆包入背包（统一收录）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'ak74', name: 'AK-74', dmg: 24, fireRate: 650, magSize: 30, slots: [], ammo: { ammoId: '545x39', count: 30, reserve: 0 } } });
  const a = sim.players.get('aaaaaa');
  const box = { id: 'box_x', x: 2, z: 0, label: '弹药箱', looted: false,
    loot: [{ itemId: 'ammo_box_9x18', weight: 0.4, count: 1, ammo: { ammoId: '9x18', count: 20 } }] };
  sim.containers.push(box);
  a.x = 2; a.z = 0;
  const picked = sim.interactContainer('aaaaaa', 'box_x');
  assert.equal(picked.length, 1, '弹药拆包后计入拾取列表');
  assert.equal(a.inventory.length, 1, '弹药以实体堆叠进背包');
  assert.equal(a.inventory[0].itemId, '9x18', '条目 id = 口径本身');
  assert.equal(a.ammoLib['9x18'], 20, '派生弹药库可见 9x18（统一收录所有口径）');
  assert.equal(a.ammoLib['545x39'] || 0, 0, 'AK 口径弹药库为空');
});
test('拾取: 徒手（无武器）时弹药拆包入背包', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A'); // 无武器
  const a = sim.players.get('aaaaaa');
  const box = { id: 'box_h', x: 2, z: 0, label: '弹药箱', looted: false,
    loot: [{ itemId: 'ammo_box_545', weight: 0.5, count: 1, ammo: { ammoId: '545x39', count: 30 } }] };
  sim.containers.push(box);
  a.x = 2; a.z = 0;
  const picked = sim.interactContainer('aaaaaa', 'box_h');
  assert.equal(picked.length, 1, '弹药拆包入背包');
  assert.equal(a.ammoLib['545x39'], 30, '徒手也能收弹药（派生库可见）');
});
test('射击: ammo 事件带 reserve（联机 HUD 同步依赖）', () => {
  const sim = new GameSim({ testMode: true, shotCooldown: 0 });
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'ak74', name: 'AK-74', dmg: 24, fireRate: 650, magSize: 30, slots: [], ammo: { ammoId: '545x39', count: 10, reserve: 20 } } });
  sim.applyInput('aaaaaa', { keys: {}, yaw: 0, pitch: 0, fire: true });
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  const ev = sim.drainEvents().find(e => e.type === 'ammo');
  assert.ok(ev, '应有 ammo 事件');
  assert.equal(ev.count, 9);
  assert.equal(ev.reserve, 20, 'ammo 事件应含 reserve');
});

// ---------- 射速（v0.6.16：冷却按武器 fireRate，AK 650rpm） ----------
test('射速: AK-74 650rpm（92ms 冷却）— 每 95ms 开枪基本全中', async () => {
  const sim = new GameSim({ testMode: true }); // 默认 _shotCooldown=250ms——必须被武器 fireRate 覆盖
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'ak74', name: 'AK-74', dmg: 24, fireRate: 650, magSize: 30, slots: [], ammo: { ammoId: '545x39', count: 30, reserve: 30 } } });
  let shots = 0;
  for (let i = 0; i < 10; i++) {
    sim.applyInput('aaaaaa', { keys: {}, yaw: 0, pitch: 0, fire: true });
    sim.tick(1 / 60);
    for (const ev of sim.drainEvents()) {
      if (ev.type === 'sound' && ev.kind === 'shot') shots++;
    }
    await new Promise(r => setTimeout(r, 95)); // 95ms > 92ms → 应几乎全响
  }
  assert.ok(shots >= 8, `650rpm 下 95ms 间隔应几乎全中（实际 ${shots}/10，若仍 250ms 冷却只有约 3 发）`);
});
test('射速: PM 320rpm（188ms 冷却）— 150ms 间隔应大多被挡', async () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'pm', name: 'PM', dmg: 14, fireRate: 320, magSize: 8, slots: [], ammo: { ammoId: '9x18', count: 8, reserve: 8 } } });
  let shots = 0;
  for (let i = 0; i < 10; i++) {
    sim.applyInput('aaaaaa', { keys: {}, yaw: 0, pitch: 0, fire: true });
    sim.tick(1 / 60);
    for (const ev of sim.drainEvents()) {
      if (ev.type === 'sound' && ev.kind === 'shot') shots++;
    }
    await new Promise(r => setTimeout(r, 150)); // 150ms < 188ms → 大多被冷却挡
  }
  assert.ok(shots <= 7, `PM 320rpm 150ms 间隔应被冷却挡住（实际 ${shots}/10）`);
});

// ---------- E020 统一弹药库（同口径共用；弹药箱收进弹药库，不再绑定当前武器） ----------
test('E045: 弹药箱拆包入背包（异口径也收，供同口径枪换弹）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'pm', name: 'PM', dmg: 14, fireRate: 320, magSize: 8, slots: [], ammo: { ammoId: '9x18', count: 5, reserve: 10 } } });
  const a = sim.players.get('aaaaaa');
  a.inventory.push({ itemId: 'ammo_box_545', count: 1, weight: 0.5 });
  const boxIdx = a.inventory.findIndex(x => x.itemId === 'ammo_box_545');
  const used = sim.useItem('aaaaaa', boxIdx, 0, { ammoId: '545x39', count: 30 });
  assert.ok(used, '弹药箱使用成功');
  assert.equal(a.ammoLib['545x39'], 30, '5.45 拆包进背包（派生库可见，供 AK 换弹）');
  assert.equal(a.ammoLib['9x18'], 10, 'PM 口径背包弹药不变');
  assert.equal(a.inventory.length, 2, '弹药箱被消耗；备弹以实体堆叠留在背包');
});
test('E045: 同口径弹药箱拆包并入同口径堆叠', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'pm', name: 'PM', dmg: 14, fireRate: 320, magSize: 8, slots: [], ammo: { ammoId: '9x18', count: 5, reserve: 10 } } });
  const a = sim.players.get('aaaaaa');
  a.inventory.push({ itemId: 'ammo_box_9x18', count: 1, weight: 0.4 });
  const boxIdx = a.inventory.findIndex(x => x.itemId === 'ammo_box_9x18');
  sim.useItem('aaaaaa', boxIdx, 0, { ammoId: '9x18', count: 20 });
  assert.equal(a.ammoLib['9x18'], 30, 'PM 口径背包弹药 10+20=30（派生库）');
  assert.equal(a.inventory.length, 1, '弹药箱被消耗；9x18 并入同口径实体堆叠');
});
test('E045: 装备武器只带弹匣（备弹在背包实体堆叠）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { ammoLib: { '545x39': 40 } }); // 进图弹药 → 背包实体堆叠 40 发
  const a = sim.players.get('aaaaaa');
  a.inventory.push({ itemId: 'w_ak74', isWeapon: true, count: 1, weaponId: 'ak74', dmg: 24, fireRate: 650, magSize: 30, ammoType: '545x39', slots: [], ammo: { ammoId: '545x39', count: 12 } });
  const gunIdx = a.inventory.findIndex(x => x.isWeapon);
  sim.useItem('aaaaaa', gunIdx, 0, null);
  assert.equal(a.weapon.ammo.count, 12, '装备后弹匣 12');
  assert.equal(a.weapon.ammo.ammoId, '545x39');
  assert.equal(a.weapon.ammo.reserve, undefined, '武器不再带 reserve（备弹在背包实体堆叠）');
  assert.equal(a.ammoLib['545x39'], 40, '背包弹药独立保留（派生库）');
  // 换弹验证：弹匣 12 + 弹药库 40 → 补 18 发，弹药库 22
  sim.reload(a);
  const doneAt = a.reloadDoneAt;
  a.reloadDoneAt = Date.now() - 2000; // 模拟 1.5s 后
  sim.tick(1 / 60);
  assert.equal(a.weapon.ammo.count, 30, '弹匣补满');
  assert.equal(a.ammoLib['545x39'], 22, '弹药库 40-18=22');
});

// ---------- E032 回归（2026-09-13）：SCAV 尸体弹药箱口径判定 ----------
// 缺陷：尸体弹药箱条目缺 ammo 字段 → 逃逸 interactContainer 的自动入库分支 → 落进背包
//       → 背包 UI 的口径判定因缺武器字段恒显示"口径不符"（.workbuddy/ui-thread/BUG-1_实测报告.md）
// 修复：尸体条目对齐容器条目（携带 ammo）→ 搜刮即自动入统一弹药库，不进背包
test('E032: SCAV 尸体弹药箱携带 ammo 字段 → 搜刮后进弹药库、不进背包', () => {
  const ITEMS = require('../shared/items');
  const isAmmoBox = (x) => ITEMS.LOOT[x.itemId] && ITEMS.LOOT[x.itemId].ammo;
  const N = 40;
  let bodies = 0, dropped = 0, intoBag = 0, intoLib = 0, missingAmmoField = 0;
  for (let i = 0; i < N; i++) {
    const sim = new GameSim({ testMode: true, shotCooldown: 0 });
    sim.addPlayer('aaaaaa', 'A', {
      weapon: { weaponId: 'pm', name: 'PM', dmg: 18, fireRate: 400, magSize: 8, slots: [], ammo: { ammoId: '9x18', count: 8 } },
      ammoLib: { '9x18': 0 }
    });
    sim.spawnScavs(1);
    const s = sim.scavs.values().next().value;
    const a = sim.players.get('aaaaaa');
    s.hp = 12; a.x = 0; a.z = 0; s.x = 5; s.z = 0;
    a.yaw = Math.atan2(-(s.x - a.x), -(s.z - a.z));
    sim.applyInput('aaaaaa', { keys: {}, yaw: a.yaw, pitch: 0, fire: true });
    sim.tick(1 / 60);
    const body = sim.containers.find((c) => String(c.id).startsWith('body_'));
    if (!body) continue;
    bodies++;
    const box = body.loot.find(isAmmoBox);
    if (box) {
      dropped++;
      if (!box.ammo || !box.ammo.count) missingAmmoField++; // E032 核心：条目必须带 ammo
    }
    const libBefore = JSON.stringify(a.ammoLib);
    a.x = body.x; a.z = body.z;
    sim.interactContainer('aaaaaa', body.id);
    if (a.inventory.some(isAmmoBox)) intoBag++;
    if (box && JSON.stringify(a.ammoLib) !== libBefore) intoLib++;
  }
  assert.ok(bodies > 0, '应至少生成 1 具尸体样本');
  assert.equal(missingAmmoField, 0, `尸体弹药箱条目缺失 ammo 字段 ${missingAmmoField} 次（会逃逸自动入库）`);
  assert.equal(intoBag, 0, `弹药箱不得进入背包（实测 ${intoBag} 次入包 / ${bodies} 具尸体）`);
  assert.equal(intoLib, dropped, `掉落的弹药箱应全部自动入弹药库（掉落 ${dropped}，入库 ${intoLib}）`);
});
