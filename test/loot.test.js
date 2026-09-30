/*
 * EXFIL ZONE · M1b 搜刮+背包 单元测试
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LOOT, LOOT_POOL, CONTAINERS, WEAPONS, defaultProfile, rollLoot, rollContainerLoot, invWeight, tradeProfile } = require('../shared/items');
const { GameSim } = require('../shared/sim');

// ---------- items：战利品 ----------
test('loot: 生成池覆盖全部合法物品', () => {
  for (const poolName of Object.keys(LOOT_POOL)) {
    for (let i = 0; i < 200; i++) {
      const id = rollLoot(poolName);
      assert.ok(LOOT[id], `池 ${poolName} 生成了非法物品 ${id}`);
    }
  }
});
test('loot: 容器按池生成（槽位数匹配）', () => {
  const c = CONTAINERS[0];
  const loot = rollContainerLoot(c);
  assert.equal(loot.length, c.pools.length);
});
test('loot: 背包重量计算', () => {
  assert.ok(Math.abs(invWeight([{ itemId: 'ifak', count: 1 }, { itemId: 'junk', count: 3 }]) - 0.9) < 1e-9);
});

// ---------- sim：容器与背包 ----------
function makeSimWithContainer(loot, invCap = 20) {
  const sim = new GameSim({ testMode: true, containers: [
    { id: 'c1', x: -5, z: 20, label: '测试箱', loot }
  ] });
  sim.addPlayer('aaaaaa', 'A', { invCap });
  return sim;
}

test('sim: 近距离可搜刮容器（战利品入包 + 事件）', () => {
  const sim = makeSimWithContainer([{ itemId: 'ifak', weight: 0.3, count: 1 }]);
  const p = sim.players.get('aaaaaa');
  p.x = -5; p.z = 20; // 站在容器旁
  const picked = sim.interactContainer('aaaaaa', 'c1');
  assert.ok(picked && picked.length === 1);
  assert.equal(p.inventory.length, 1);
  assert.equal(p.inventory[0].itemId, 'ifak');
  const evs = sim.drainEvents();
  assert.ok(evs.some(e => e.type === 'containerLooted'), '应广播搜刮完成');
  assert.ok(evs.some(e => e.type === 'invChanged'), '应广播背包变化');
  // 二次搜刮返回 null（已 looted）
  assert.equal(sim.interactContainer('aaaaaa', 'c1'), null);
});
test('sim: 距离 >3m 不可搜刮', () => {
  const sim = makeSimWithContainer([{ itemId: 'junk', weight: 0.2, count: 1 }]);
  const p = sim.players.get('aaaaaa');
  p.x = 0; p.z = 0; // 远离容器（-5,20）
  assert.equal(sim.interactContainer('aaaaaa', 'c1'), null);
  assert.ok(!sim.containers[0].looted, '容器不应被标记搜刮');
});
test('sim: 背包超重拒绝拾取（invFull）', () => {
  const sim = makeSimWithContainer([
    { itemId: 'ifak', weight: 15, count: 1 },
    { itemId: 'ifak', weight: 15, count: 1 }
  ], 20);
  const p = sim.players.get('aaaaaa');
  p.x = -5; p.z = 20;
  const picked = sim.interactContainer('aaaaaa', 'c1');
  assert.equal(picked.length, 1, '只应拾取 1 件（第二件超重被拒）');
  assert.equal(p.inventory.length, 1);
  assert.ok(sim.drainEvents().some(e => e.type === 'invFull'), '应触发 invFull');
});
test('sim: 超重移速减半', () => {
  const sim = makeSimWithContainer([{ itemId: 'ifak', weight: 20, count: 1 }], 20);
  const p = sim.players.get('aaaaaa');
  p.x = -5; p.z = 20;
  sim.interactContainer('aaaaaa', 'c1'); // 重量 20 = 正好容量 → 不超重
  const x0 = p.x;
  sim.applyInput('aaaaaa', { keys: { f: 1, b: 0, l: 0, r: 0 }, yaw: 0, pitch: 0 });
  for (let i = 0; i < 60; i++) sim.tick(1 / 60);
  const normalSpeed = Math.hypot(p.x - x0, p.z - 28.7 - 0); // 测试模式出生 (-5,20) 朝 -z
  // 再加重到超重
  p.inventory.push({ itemId: 'junk', weight: 5, count: 1 }); // 25 > 20
  assert.ok(sim.isOverweight(p), '应判定超重');
  const x1 = p.x, z1 = p.z;
  sim.applyInput('aaaaaa', { keys: { f: 1, b: 0, l: 0, r: 0 }, yaw: 0, pitch: 0 });
  for (let i = 0; i < 60; i++) sim.tick(1 / 60);
  const slowSpeed = Math.hypot(p.x - x1, p.z - z1);
  assert.ok(slowSpeed < normalSpeed * 0.7, `超重移速应明显降低（正常 ${normalSpeed.toFixed(1)}m/s vs 超重 ${slowSpeed.toFixed(1)}m/s）`);
});
test('sim: 使用物品消耗一件并保留其余', () => {
  const sim = makeSimWithContainer([{ itemId: 'bandage', weight: 0.1, count: 3 }]);
  const p = sim.players.get('aaaaaa');
  p.x = -5; p.z = 20;
  sim.interactContainer('aaaaaa', 'c1');
  assert.equal(p.inventory[0].count, 3);
  sim.useItem('aaaaaa', 0);
  assert.equal(p.inventory[0].count, 2, '使用 1 件后剩 2');
  assert.ok(sim.drainEvents().some(e => e.type === 'usedItem'));
});
test('sim: 丢弃物品从背包移除', () => {
  const sim = makeSimWithContainer([{ itemId: 'junk', weight: 0.2, count: 1 }]);
  const p = sim.players.get('aaaaaa');
  p.x = -5; p.z = 20;
  sim.interactContainer('aaaaaa', 'c1');
  assert.equal(p.inventory.length, 1);
  sim.dropItem('aaaaaa', 0);
  assert.equal(p.inventory.length, 0);
  assert.ok(sim.drainEvents().some(e => e.type === 'droppedItem'));
});

// ---------- M1c 结算与撤离 ----------
test('settleRaid: 撤离成功 — 武器弹药写回 + 背包并入仓库', () => {
  const { defaultProfile, settleRaid } = require('../shared/items');
  const profile = defaultProfile('T');
  const result = settleRaid(profile, {
    extracted: true, weaponIdx: 0,
    weaponAmmo: { ammoId: '545x39', count: 45 }, weaponMods: { sight: 'pso' },
    inventory: [{ itemId: 'ifak', count: 1 }, { itemId: 'junk', count: 2 }]
  });
  assert.equal(result.stash[0].ammo.count, 45, '武器弹药应写回');
  assert.equal(result.stash[0].mods.sight, 'pso');
  assert.ok(result.stash.some(s => s.itemId === 'ifak' && s.count === 1), '背包物品应并入');
  assert.equal(result.stash.filter(s => !s.weaponId).length, 2, '两件战利品入仓');
});
test('settleRaid: 死亡 — 武器从仓库移除，背包丢弃', () => {
  const { defaultProfile, settleRaid } = require('../shared/items');
  const profile = defaultProfile('T');
  const stashLen = profile.stash.length;
  const result = settleRaid(profile, { extracted: false, weaponIdx: 0, inventory: [{ itemId: 'ifak', count: 1 }] });
  assert.equal(result.stash.length, stashLen - 1, '武器应被移除（装备丢失）');
  assert.ok(!result.stash.some(s => s.weaponId === 'ak74'), 'AK-74 应消失');
  assert.ok(!result.stash.some(s => s.itemId === 'ifak'), '背包物品死亡不保留');
});
test('settleRaid: 不修改原档案（纯函数）', () => {
  const { defaultProfile, settleRaid } = require('../shared/items');
  const profile = defaultProfile('T');
  const before = JSON.stringify(profile);
  settleRaid(profile, { extracted: false, weaponIdx: 0 });
  assert.equal(JSON.stringify(profile), before, '原档案不应被修改');
});
test('sim: 撤离点倒计时成功（真实时间 0.6s）', async () => {
  const sim = new GameSim({ testMode: true, extracts: [{ id: 'e1', x: 0, z: 0, radius: 5, duration: 0.5 }] });
  sim.addPlayer('aaaaaa', 'A');
  const p = sim.players.get('aaaaaa');
  p.x = 0; p.z = 0; // 站在撤离点
  let started = false, succeeded = false;
  for (let i = 0; i < 8 && !succeeded; i++) {
    sim.tick(1 / 60);
    for (const ev of sim.drainEvents()) {
      if (ev.type === 'extractStart') started = true;
      if (ev.type === 'extractSuccess') succeeded = true;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(started, '应触发 extractStart');
  assert.ok(succeeded, '0.5s 后应撤离成功');
  assert.equal(p.extracted, true);
});
test('sim: 撤离中途离开 → 取消', async () => {
  const sim = new GameSim({ testMode: true, extracts: [{ id: 'e1', x: 0, z: 0, radius: 5, duration: 5 }] });
  sim.addPlayer('aaaaaa', 'A');
  const p = sim.players.get('aaaaaa');
  p.x = 0; p.z = 0;
  sim.tick(1 / 60); sim.drainEvents(); // 进入
  p.x = 20; p.z = 20; // 离开
  sim.tick(1 / 60);
  const evs = sim.drainEvents();
  assert.ok(evs.some(e => e.type === 'extractCancel'), '离开应触发 extractCancel');
  assert.equal(p.extracted, undefined, '不应撤离成功');
});

// ---------- M1b 武器战利品（搜刮可摸到枪 + 结算带出） ----------
test('LOOT_POOL: rare 池含武器掉落（w_pm/w_ak74）', () => {
  const { LOOT_POOL } = require('../shared/items');
  const rareIds = LOOT_POOL.rare.map(e => e.item);
  assert.ok(rareIds.includes('w_pm'), 'rare 池应含 PM');
  assert.ok(rareIds.includes('w_ak74'), 'rare 池应含 AK-74');
});
test('LOOT: 武器条目字段完整（可直接装备）', () => {
  const { LOOT } = require('../shared/items');
  for (const id of ['w_pm', 'w_ak74']) {
    const w = LOOT[id];
    assert.equal(w.type, 'weapon');
    assert.ok(w.weaponId && w.dmg && w.magSize && w.ammoType && w.slots, `${id} 缺装备字段`);
  }
});
test('settleRaid: 局内捡的武器撤离 → 并入仓库武器槽', () => {
  const { defaultProfile, settleRaid } = require('../shared/items');
  const profile = defaultProfile('T');
  const before = profile.stash.filter(s => s.weaponId).length;
  const result = settleRaid(profile, {
    extracted: true, weaponIdx: -1,
    inventory: [{ itemId: 'w_pm', count: 1, isWeapon: true, weaponId: 'pm', ammoType: '9x18', ammo: { ammoId: '9x18', count: 4 }, mods: {} }]
  });
  const guns = result.stash.filter(s => s.weaponId);
  assert.equal(guns.length, before + 1, '多一把枪');
  const pms = guns.filter(s => s.weaponId === 'pm');
  assert.ok(pms.some(s => s.ammo.count === 4), '新捡 PM 弹药 4 发保留（仓库原有 PM 24 发不受影响）');
});
test('settleRaid: 局内捡的武器死亡 → 丢弃', () => {
  const { defaultProfile, settleRaid } = require('../shared/items');
  const profile = defaultProfile('T');
  const before = profile.stash.filter(s => s.weaponId).length;
  const result = settleRaid(profile, {
    extracted: false, weaponIdx: -1,
    inventory: [{ itemId: 'w_ak74', count: 1, isWeapon: true, weaponId: 'ak74', ammoType: '545x39', ammo: { ammoId: '545x39', count: 30 }, mods: {} }]
  });
  assert.equal(result.stash.filter(s => s.weaponId).length, before, '死亡武器不保留');
});

// ---------- E030 tradeProfile：商人/改装（联机服务器权威纯函数） ----------
test('tradeProfile: 卖战利品加钱并移除', () => {
  const p = defaultProfile('T');
  p.stash.push({ itemId: 'junk', count: 3 });
  const money0 = p.money;
  const r = tradeProfile(p, { type: 'sellLoot', itemId: 'junk' });
  assert.ok(r.ok, '卖出成功');
  assert.equal(r.profile.money, money0 + 45, 'junk 15₽×3 = +45');
  assert.ok(!r.profile.stash.some(s => s.itemId === 'junk'), 'junk 已移除');
  assert.ok(p.stash.some(s => s.itemId === 'junk'), '原档案不被修改（纯函数）');
});
test('tradeProfile: 买补给扣钱并入仓', () => {
  const p = defaultProfile('T');
  const money0 = p.money;
  const r = tradeProfile(p, { type: 'buy', itemId: 'bandage' });
  assert.ok(r.ok, '购买成功');
  assert.ok(r.profile.money < money0, '扣钱');
  assert.ok(r.profile.stash.some(s => s.itemId === 'bandage'), '绷带入仓');
});
test('tradeProfile: 钱不够买武器失败（不改档案）', () => {
  const p = defaultProfile('T');
  p.money = 0;
  const r = tradeProfile(p, { type: 'buyWeapon', weaponId: 'ak74' });
  assert.ok(!r.ok, '购买失败');
  assert.equal(r.profile.money, 0, '钱不变');
  assert.equal(r.profile.stash.filter(s => s.weaponId).length, p.stash.filter(s => s.weaponId).length, '武器数不变');
});
test('tradeProfile: 卖武器移除 + 加钱', () => {
  const p = defaultProfile('T');
  const idx = p.stash.findIndex(s => s.weaponId);
  const money0 = p.money;
  const r = tradeProfile(p, { type: 'sellWeapon', index: idx });
  assert.ok(r.ok, '卖出成功');
  assert.ok(r.profile.money > money0, '加钱');
  assert.equal(r.profile.stash.filter(s => s.weaponId).length, p.stash.filter(s => s.weaponId).length - 1, '少一把枪');
});
test('tradeProfile: 改装瞄具切换（安装/卸下）', () => {
  const p = defaultProfile('T');
  const idx = p.stash.findIndex(s => s.weaponId && WEAPONS[s.weaponId].slots.includes('sight'));
  const r1 = tradeProfile(p, { type: 'toggleSight', index: idx });
  assert.ok(r1.ok, '安装成功');
  assert.equal(r1.profile.stash[idx].mods.sight, 'pso', '装上 PSO');
  const r2 = tradeProfile(r1.profile, { type: 'toggleSight', index: idx });
  assert.equal(r2.profile.stash[idx].mods.sight, null, '卸下 PSO');
});
test('tradeProfile: 无瞄具槽的武器改装失败', () => {
  const p = defaultProfile('T');
  const idx = p.stash.findIndex(s => s.weaponId && !WEAPONS[s.weaponId].slots.includes('sight'));
  const r = tradeProfile(p, { type: 'toggleSight', index: idx });
  assert.ok(!r.ok, '失败（无瞄具槽）');
});
