'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { GameSim, computeScavHitChance } = require('../shared/sim');

// ---------- M2a 防回归：生成点分散（用户反馈"叠在一起/不会动"） ----------
test('GameSim: randomWalkablePoint 多次调用返回分散点', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push(sim.randomWalkablePoint(0, 60));
  let spread = 0;
  for (let i = 1; i < pts.length; i++) {
    spread = Math.max(spread, Math.hypot(pts[i].x - pts[0].x, pts[i].z - pts[0].z));
  }
  assert.ok(spread > 1, '10 个随机点应分散（最大间距 ' + spread.toFixed(1) + 'm）');
});
test('GameSim: spawnScavs 生成位置互不重叠（>1m）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  sim.spawnScavs(4);
  const list = [...sim.scavs.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const d = Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z);
      assert.ok(d > 1, 'SCAV ' + i + '/' + j + ' 不应重叠（距离 ' + d.toFixed(2) + 'm）');
    }
  }
});
test('GameSim: 默认生成后 SCAV 会离开出生点（不原地打转）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  sim.spawnScavs(1);
  const s = sim.scavs.values().next().value;
  s.wpPause = 0;
  const x0 = s.x, z0 = s.z;
  let moved = false;
  for (let i = 0; i < 180 && !moved; i++) {
    sim.tick(1 / 60);
    if (Math.hypot(s.x - x0, s.z - z0) > 0.1) moved = true;
  }
  assert.ok(moved, 'SCAV 默认巡逻应发生移动');
});

// ---------- M2b 感知系统 ----------
// 注意：yaw=0 朝 -Z（directionFromAngles = (-sin, -cos)）
function setupScav(px, pz, sx, sz, yawDeg) {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { x: px, y: 0, z: pz });
  sim.spawnScavs(1);
  const s = sim.scavs.values().next().value;
  s.x = sx; s.z = sz; s.yaw = yawDeg * Math.PI / 180;
  return { sim, s };
}
test('感知: 视野内玩家被发现（距离+角度+无遮挡）', () => {
  const { sim, s } = setupScav(10, 0, 0, 0, -90); // SCAV 朝 +X（yaw=-90°），玩家在 +X 10m
  const vis = sim.visiblePlayer(s);
  assert.equal(vis.id, 'aaaaaa', '正前方玩家应可见');
});
test('感知: 背后玩家不可见（视野角外）', () => {
  const { sim, s } = setupScav(-10, 0, 0, 0, -90); // SCAV 朝 +X，玩家在 -X（背后）
  assert.equal(sim.visiblePlayer(s), null, '背后应不可见');
});
test('感知: 45° 方向玩家可见（120° 视野内）', () => {
  // 开阔地（厂房外）：SCAV (-30,-30) 朝 -135°（指向玩家 (-22.9,-22.9)，45° 偏角）
  const { sim, s } = setupScav(-22.9, -22.9, -30, -30, -135);
  assert.equal(sim.visiblePlayer(s).id, 'aaaaaa', '45° 在 120° 视野内');
});
test('感知: 隔墙不可见（遮挡判定）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { x: 8, y: 0, z: -14 }); // 玩家在北墙（z∈[-10,-9]）后方 4m
  sim.spawnScavs(1);
  const s = sim.scavs.values().next().value;
  s.x = 8; s.z = -3; s.yaw = Math.atan2(-(8 - 8), -((-14) - (-3))); // 朝 -Z（玩家方向）
  // 射线从 (8,1.6,-3) 到玩家 (8,-14)，墙 z∈[-10,-9] 在中间 → 应被遮挡
  assert.equal(sim.visiblePlayer(s), null, '隔墙应不可见');
});
test('感知: 枪声触发调查（40m 内）', () => {
  const { sim, s } = setupScav(30, 0, 0, 0, 90); // 玩家 30m 外（视野外，但枪声 40m 内）
  sim.applyInput('aaaaaa', { keys: {}, yaw: 0, pitch: 0, fire: true }); // 无武器不开枪！
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  // 直接发枪声事件验证 notifyScavs
  sim.emit('sound', { kind: 'shot', x: 30, y: 0, z: 0 });
  assert.equal(s.state, 'investigate', '枪声应触发调查');
  assert.equal(s.target.x, 30, '目标应为声源位置');
});
test('感知: 远处枪声不触发（>40m）', () => {
  const { sim, s } = setupScav(50, 0, 0, 0, 90);
  sim.emit('sound', { kind: 'shot', x: 50, y: 0, z: 0 });
  assert.equal(s.state, 'patrol', '50m 外枪声不应触发');
});
test('感知: 调查完成后回到巡逻', () => {
  const { sim, s } = setupScav(60, 60, 0, 0, 0); // 玩家放远处（视野 25m/枪声 40m 外均不触发）
  sim.emit('sound', { kind: 'shot', x: 5, y: 0, z: 0 }); // 声源在 (5,0)
  assert.equal(s.state, 'investigate');
  // 走到声源 + 搜索 2s（玩家 60m 外不会转 combat）
  let done = false;
  for (let i = 0; i < 500 && !done; i++) {
    sim.tick(1 / 60);
    if (s.state === 'patrol') done = true;
  }
  assert.ok(done, '调查完应回巡逻');
});

// ---------- M2d 交火 ----------
test('交火: 玩家开枪命中 SCAV（伤害+血条数据）', () => {
  const sim = new GameSim({ testMode: true, shotCooldown: 0 });
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'ak74', dmg: 24, magSize: 30, ammo: { ammoId: '545x39', count: 30 } } });
  sim.spawnScavs(1);
  const s = sim.scavs.values().next().value;
  s.x = 5; s.z = 0; // 放玩家前方（玩家出生在 (-5,20)/(5,20) 测试点之一）
  const a = sim.players.get('aaaaaa');
  a.x = 0; a.z = 0;
  const yaw = Math.atan2(-(s.x - a.x), -(s.z - a.z));
  a.yaw = yaw;
  sim.applyInput('aaaaaa', { keys: {}, yaw, pitch: 0, fire: true });
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  const evs = sim.drainEvents();
  const hit = evs.find(e => e.type === 'hit' && e.isScav);
  assert.ok(hit, '应命中 SCAV');
  assert.equal(s.hp, 76, "SCAV 100 血掉 24 → 76");
});
test('交火: 击杀 SCAV → scavDead 事件 + 从世界移除', () => {
  const sim = new GameSim({ testMode: true, shotCooldown: 0 });
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'ak74', dmg: 24, magSize: 30, ammo: { ammoId: '545x39', count: 30 } } });
  sim.spawnScavs(1);
  const s = sim.scavs.values().next().value;
  s.hp = 20; // 一枪必死
  const a = sim.players.get('aaaaaa');
  a.x = 0; a.z = 0; s.x = 5; s.z = 0;
  const yaw = Math.atan2(-(s.x - a.x), -(s.z - a.z));
  a.yaw = yaw;
  sim.applyInput('aaaaaa', { keys: {}, yaw, pitch: 0, fire: true });
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  const evs = sim.drainEvents();
  assert.ok(evs.some(e => e.type === 'scavDead'), '应广播 scavDead');
  assert.equal(sim.scavs.size, 0, 'SCAV 应从世界移除');
});
test('交火: SCAV 看到玩家进入 combat 并反击（尝试开火）', async () => {
  const sim = new GameSim({ testMode: true, shotCooldown: 0 });
  sim.addPlayer('aaaaaa', 'A', { x: 5, y: 0, z: 0 });
  sim.spawnScavs(1);
  const s = sim.scavs.values().next().value;
  s.x = 0; s.z = 0; s.yaw = Math.atan2(-(5 - 0), -(0 - 0)); // 朝玩家
  let shots = 0;
  for (let i = 0; i < 60 && shots === 0; i++) {
    sim.tick(1 / 60);
    await new Promise(r => setTimeout(r, 30)); // 真实时间流逝（警觉延迟基于 Date.now）
    for (const ev of sim.drainEvents()) {
      if (ev.type === 'sound' && ev.kind === 'shot' && ev.scav) shots++;
    }
  }
  assert.ok(shots > 0, 'SCAV 应尝试开火（警觉延迟后）');
  assert.equal(s.state, 'combat', 'SCAV 应处于战斗状态');
});
test('交火: SCAV 装备池（AK 30% / PM 70% 均合法）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  sim.spawnScavs(20);
  let ak = 0, pm = 0, other = 0;
  for (const s of sim.scavs.values()) {
    if (s.weapon.weaponId === 'ak74') ak++;
    else if (s.weapon.weaponId === 'pm') pm++;
    else other++;
  }
  assert.equal(other, 0, '武器必须来自装备池');
  assert.ok(ak > 0 && pm > 0, `AK/PM 都应出现（AK=${ak} PM=${pm}）`);
});

test('交火: 警觉延迟 0.8s（发现后不立即开火，玩家有反应窗口）', async () => {
  const sim = new GameSim({ testMode: true, shotCooldown: 0 });
  sim.addPlayer('aaaaaa', 'A', { x: 5, y: 0, z: 0 });
  sim.spawnScavs(1);
  const s = sim.scavs.values().next().value;
  s.x = 0; s.z = 0; s.yaw = Math.atan2(-(5), -(0));
  let shots = 0;
  const collect = () => {
    for (const ev of sim.drainEvents()) {
      if (ev.type === 'sound' && ev.kind === 'shot' && ev.scav) shots++;
    }
  };
  // 进入 combat（同步 tick）
  for (let i = 0; i < 10; i++) { sim.tick(1 / 60); collect(); }
  assert.equal(shots, 0, '进入战斗瞬间不应开火');
  assert.equal(s.state, 'combat', 'SCAV 已进入战斗但未开枪');
  // 等待 0.5s（<0.8s 警觉延迟）再 tick → 仍不应开火
  await new Promise(r => setTimeout(r, 500));
  sim.tick(1 / 60); collect();
  assert.equal(shots, 0, '0.5s 后仍不应开火（警觉延迟 0.8s）');
  // 再等 0.5s（累计 1s > 0.8s）→ 应开火
  await new Promise(r => setTimeout(r, 500));
  for (let i = 0; i < 30 && shots === 0; i++) {
    sim.tick(1 / 60); collect();
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(shots > 0, '0.8s 后 SCAV 应开始射击');
});

// ---------- M2e 尸体搜刮 ----------
test('尸体: 击杀 SCAV 生成尸体容器（含完整武器条目）', () => {
  const sim = new GameSim({ testMode: true, shotCooldown: 0 });
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'ak74', dmg: 24, magSize: 30, ammo: { ammoId: '545x39', count: 30 } } });
  sim.spawnScavs(1);
  const s = sim.scavs.values().next().value;
  s.hp = 20;
  const a = sim.players.get('aaaaaa');
  a.x = 0; a.z = 0; s.x = 5; s.z = 0;
  a.yaw = Math.atan2(-(s.x - a.x), -(s.z - a.z));
  sim.applyInput('aaaaaa', { keys: {}, yaw: a.yaw, pitch: 0, fire: true });
  sim.tick(1 / 60); // E021：输入入队后需 tick 消费一步
  sim.drainEvents();
  assert.equal(sim.scavs.size, 0, 'SCAV 已移除');
  const body = sim.containers.find(c => c.id.startsWith('body_'));
  assert.ok(body, '应生成尸体容器');
  assert.equal(body.label, 'SCAV 尸体');
  const wpn = body.loot.find(i => i.isWeapon);
  assert.ok(wpn, '尸体应有武器');
  assert.ok(wpn.weaponId && wpn.ammo && wpn.dmg, '武器条目字段完整');
});
test('尸体: 搜刮尸体武器入包（isWeapon 完整字段可装备）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  const a = sim.players.get('aaaaaa');
  const body = { id: 'body_test', x: 2, z: 0, label: 'SCAV 尸体', looted: false,
    loot: [{ itemId: 'w_ak74', isWeapon: true, count: 1, weaponId: 'ak74', dmg: 24, fireRate: 550, magSize: 30, ammoType: '545x39', slots: ['sight', 'mag'], ammo: { ammoId: '545x39', count: 30 } }] };
  sim.containers.push(body);
  a.x = 2; a.z = 0;
  const picked = sim.interactContainer('aaaaaa', 'body_test');
  assert.ok(picked && picked.length === 1, '应拾取武器');
  const inv = a.inventory[0];
  assert.equal(inv.isWeapon, true, '武器条目保留 isWeapon');
  assert.equal(inv.dmg, 24, 'dmg 保留');
  assert.equal(inv.ammo.count, 30, 'ammo 保留');
  // 装备验证
  sim.useItem('aaaaaa', 0, 0, null);
  assert.equal(a.weapon.weaponId, 'ak74', '尸体武器可直接装备');
});
test('尸体: 搜刮后容器标记 looted 不可重复搜', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  const a = sim.players.get('aaaaaa');
  const body = { id: 'body_x', x: 2, z: 0, label: 'SCAV 尸体', looted: false, loot: [{ itemId: 'bandage', count: 1, weight: 0.1 }] };
  sim.containers.push(body);
  a.x = 2; a.z = 0;
  sim.interactContainer('aaaaaa', 'body_x');
  const again = sim.interactContainer('aaaaaa', 'body_x');
  assert.equal(again, null, '已搜刮尸体不可重复');
  assert.equal(body.looted, true);
});

// ---------- E017 尸体武器被自动补备弹吞掉（同口径） ----------
test('E017: 搜刮尸体武器（玩家同口径）→ 枪进背包不被吞', () => {
  const sim = new GameSim({ testMode: true });
  // 玩家拿 AK-74
  sim.addPlayer('aaaaaa', 'A', { weapon: { weaponId: 'ak74', name: 'AK-74', dmg: 24, fireRate: 650, magSize: 30, slots: [], ammo: { ammoId: '545x39', count: 10, reserve: 5 } } });
  const a = sim.players.get('aaaaaa');
  // 尸体容器：SCAV 也掉 AK（同口径 545x39）——武器条目带 ammo 字段
  const body = { id: 'body_e17', x: 2, z: 0, label: 'SCAV 尸体', looted: false,
    loot: [{ itemId: 'w_ak74', isWeapon: true, count: 1, weaponId: 'ak74', dmg: 24, fireRate: 650, magSize: 30, ammoType: '545x39', slots: ['sight', 'mag'], ammo: { ammoId: '545x39', count: 12 } }] };
  sim.containers.push(body);
  a.x = 2; a.z = 0;
  const picked = sim.interactContainer('aaaaaa', 'body_e17');
  assert.equal(picked.length, 1, '应拾取武器');
  assert.equal(a.inventory.length, 2, '武器 + 玩家自有备弹都在背包（E045 实体化后可并存）');
  const gun = a.inventory.find(x => x.isWeapon);
  assert.ok(gun, '武器条目在背包');
  assert.equal(gun.weaponId, 'ak74');
  assert.equal(a.ammoLib['545x39'], 5, '玩家备弹 545x39 仍为 5（武器不是弹药，不被吞）');
});

// ---------- E024 SCAV 命中率：移动规避（用户反馈"移动中根本躲不开"） ----------
test('E024: 命中率随目标速度显著下降（跑动可有效规避）', () => {
  const CFG = require('../shared/config').CFG;
  const spd = CFG.physics.speed;
  const stillNear = computeScavHitChance(5, 0);
  const movingNear = computeScavHitChance(5, spd);
  const stillMid = computeScavHitChance(15, 0);
  const movingMid = computeScavHitChance(15, spd);
  assert.ok(movingNear < stillNear * 0.4, '全速移动命中率应大幅低于静止（移动 ' + movingNear.toFixed(3) + ' vs 静止 ' + stillNear.toFixed(3) + '）');
  assert.ok(movingMid < stillMid * 0.4, '中距离同样成立（移动 ' + movingMid.toFixed(3) + ' vs 静止 ' + stillMid.toFixed(3) + '）');
  assert.ok(movingNear <= 0.15, '全速移动近距命中率应 <=0.15（实际 ' + movingNear.toFixed(3) + '）');
});
test('E024: 命中率单调性（距离越远越低 / 速度越快越低）', () => {
  assert.ok(computeScavHitChance(5, 0) > computeScavHitChance(15, 0) && computeScavHitChance(15, 0) > computeScavHitChance(30, 0), '静止时距离越远命中率越低');
  assert.ok(computeScavHitChance(10, 0) > computeScavHitChance(10, 3) && computeScavHitChance(10, 3) > computeScavHitChance(10, 6), '速度越快命中率越低');
  assert.ok(computeScavHitChance(5, 0) <= 1 && computeScavHitChance(50, 6) >= 0.05, '命中率限制在 [min,1]');
});
test('E024: 半速移动即有明显规避收益', () => {
  const CFG = require('../shared/config').CFG;
  const half = CFG.physics.speed / 2;
  const still = computeScavHitChance(10, 0), moving = computeScavHitChance(10, half);
  assert.ok(moving <= still * 0.6, '半速移动应降低至少 40% 命中率（' + moving.toFixed(3) + ' vs ' + still.toFixed(3) + '）');
});
test('E024: 集成验证——静止被命中明显多于移动（玩家真实横向走位）', () => {
  // 统计法：同一场景下，目标静止 vs 真实横向移动，SCAV 各开火 240 次
  function countHits(targetMoving) {
    const sim = new GameSim({ testMode: true });
    sim.addPlayer('p', 'A', { x: 5, y: 0, z: 0 });
    sim.spawnScavs(1);
    const sc = sim.scavs.values().next().value;
    sc.x = 0; sc.z = 0; sc.yaw = Math.atan2(-(5), -(0)); // 朝目标
    const p = sim.players.get('p');
    let hits = 0;
    for (let i = 0; i < 240; i++) {
      // 移动组：沿 Z 轴左右来回横移（保持大致距离，仅改变速度）；静止组：不输入
      const keys = targetMoving
        ? { f: 0, b: 0, l: (Math.floor(i / 15) % 2 === 0) ? 1 : 0, r: (Math.floor(i / 15) % 2 === 0) ? 0 : 1 }
        : { f: 0, b: 0, l: 0, r: 0 };
      sim.applyInput('p', { keys, jump: false, yaw: 0, pitch: 0 });
      sc.lastShot = 0; sc.lastSeenAt = 0; // 每轮清除开火冷却与警觉延迟，专注命中率
      p.hp = 100; p.alive = true;          // 保持存活，避免被打死后统计中断（100HP/14伤害=8 发即死）
      sim.tick(1 / 60);
      for (const ev of sim.drainEvents()) if (ev.type === 'hit' && ev.fromScav) hits++;
    }
    return hits;
  }
  const stillHits = countHits(false);
  const movingHits = countHits(true);
  assert.ok(stillHits > 0, '静止组应有命中（场景有效，实际 ' + stillHits + '）');
  assert.ok(movingHits < stillHits, '移动组命中应少于静止（静止 ' + stillHits + ' vs 移动 ' + movingHits + '）');
  assert.ok(movingHits <= stillHits * 0.6, '移动时命中应至少降 40%（静止 ' + stillHits + ' vs 移动 ' + movingHits + '）');
});
