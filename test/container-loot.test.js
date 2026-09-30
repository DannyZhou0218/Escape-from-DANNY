'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { GameSim } = require('../shared/sim');

// E043（2026-09-26 用户需求）：塔科夫式容器搜刮 —— 容器有格子，逐件选择拿取
// 语义：openContainer 只读不改状态；takeFromContainer 逐件转移（弹药→ammoLib / 其他→背包）；
//       拿空才 looted；search（全部拿走）原语义保留。

function mkSim(loot, playerOpts) {
  const sim = new GameSim({ testMode: true, containers: [{ id: 'c1', x: 0, z: 0, label: '测试箱', loot }] });
  sim.addPlayer('p', 'A', Object.assign({ x: 1, z: 0 }, playerOpts || {}));
  return sim;
}

test('E043: 容器 loot 在构造时注入稳定且唯一的 uid', () => {
  const sim = mkSim([
    { itemId: 'bandage', weight: 0.1, count: 1 },
    { itemId: 'bandage', weight: 0.1, count: 1 }, // 同 itemId 的两条 → uid 必须不同（逐件摆格的前提）
    { itemId: 'w_ak74', isWeapon: true, weight: 3.5, count: 1 }
  ]);
  const c = sim.containers[0];
  const uids = c.loot.map(i => i.uid);
  assert.ok(uids.every(u => typeof u === 'string' && u.length > 0), '每条都有 uid: ' + uids.join(','));
  assert.equal(new Set(uids).size, 3, 'uid 不得重复（否则布局去重会吞件）');
});

test('E043: openContainer 只读 —— 返回内容副本，容器状态不变，可重复打开', () => {
  const sim = mkSim([{ itemId: 'bandage', weight: 0.1, count: 1 }, { itemId: 'ifak', weight: 0.3, count: 1 }]);
  const r1 = sim.openContainer('p', 'c1');
  assert.ok(Array.isArray(r1) && r1.length === 2, '返回 loot');
  assert.equal(sim.containers[0].looted, false, '打开不标记已搜');
  assert.equal(sim.containers[0].loot.length, 2, '打开不移除条目');
  r1[0].count = 99; // 改返回值不得影响容器（副本）
  assert.equal(sim.containers[0].loot[0].count, 1, 'openContainer 返回的是副本');
  const r2 = sim.openContainer('p', 'c1');
  assert.equal(r2.length, 2, '可重复打开');
});

test('E043: takeFromContainer —— 普通物品逐件转移，容器少一件背包多一件', () => {
  const sim = mkSim([{ itemId: 'bandage', weight: 0.1, count: 1 }, { itemId: 'ifak', weight: 0.3, count: 1 }]);
  const c = sim.containers[0];
  const uid0 = c.loot[0].uid;
  const r = sim.takeFromContainer('p', 'c1', uid0);
  assert.equal(r.ok, true);
  assert.equal(c.loot.length, 1, '容器少一件');
  assert.equal(c.looted, false, '未拿空不标记');
  const p = sim.players.get('p');
  const got = p.inventory.find(i => i.itemId === 'bandage');
  assert.ok(got, '背包多一件');
  assert.equal(c.loot[0].uid !== uid0 || c.loot[0].itemId === 'ifak', true, '剩余条目为 ifak');
  assert.ok(!c.loot.some(i => i.uid === uid0), '拿走的 uid 不在容器');
});

test('E043/E045: takeFromContainer —— 弹药箱拆包成实体堆叠入背包（ammoLib 派生可见）', () => {
  const sim = mkSim([{ itemId: 'ammo_box_545', weight: 0.5, count:1, ammo: { ammoId: '545x39', count: 30 } }]);
  const uid = sim.containers[0].loot[0].uid;
  const r = sim.takeFromContainer('p', 'c1', uid);
  assert.equal(r.ok, true);
  const p = sim.players.get('p');
  assert.equal((p.ammoLib['545x39'] || 0) >= 30, true, 'ammoLib（派生视图）增加');
  assert.equal(p.inventory.length, 1, '弹药以实体堆叠进背包');
  assert.equal(p.inventory[0].itemId, '545x39', '条目 id = 口径本身');
  assert.equal(p.inventory[0].count, 30, '30 发一叠');
  assert.equal(sim.containers[0].loot.length, 0, '容器移除');
});

test('E043: 拿空 → looted=true + containerLooted 事件；未空 → containerLootChanged', () => {
  const sim = mkSim([
    { itemId: 'bandage', weight: 0.1, count: 1 },
    { itemId: 'ifak', weight: 0.3, count: 1 }
  ]);
  const evs = [];
  const c = sim.containers[0];
  const [u0, u1] = c.loot.map(i => i.uid);
  sim.takeFromContainer('p', 'c1', u0);
  for (const e of sim.drainEvents()) evs.push(e.type);
  assert.ok(evs.includes('containerLootChanged'), '未拿空 → containerLootChanged');
  assert.ok(!evs.includes('containerLooted'), '未拿空不发 containerLooted');
  sim.takeFromContainer('p', 'c1', u1);
  for (const e of sim.drainEvents()) evs.push(e.type);
  assert.ok(evs.includes('containerLooted'), '拿空 → containerLooted');
  assert.equal(c.looted, true);
});

test('E043: 拿空后的容器不可再打开/再拿（no-container）', () => {
  const sim = mkSim([{ itemId: 'bandage', weight: 0.1, count: 1 }]);
  const uid = sim.containers[0].loot[0].uid;
  sim.takeFromContainer('p', 'c1', uid);
  assert.equal(sim.openContainer('p', 'c1'), null, '拿空后 openContainer 返回 null');
  const r = sim.takeFromContainer('p', 'c1', uid);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-container');
});

test('E043: 距离校验 —— 走远后拿取被拒（too-far），条目留在容器', () => {
  const sim = mkSim([{ itemId: 'bandage', weight: 0.1, count: 1 }]);
  const uid = sim.containers[0].loot[0].uid;
  const p = sim.players.get('p');
  p.x = 50; p.z = 50; // 远离（searchRange 3m）
  const r = sim.takeFromContainer('p', 'c1', uid);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-far');
  assert.equal(sim.containers[0].loot.length, 1, '条目留在容器');
  assert.equal(sim.openContainer('p', 'c1'), null, '走远后也打不开');
});

test('E043: 背包容量校验 —— 超重拒绝（inv-full），条目留在容器', () => {
  const sim = mkSim([{ itemId: 'gold_chain', weight: 25, count: 1 }]); // invCap 20kg
  const uid = sim.containers[0].loot[0].uid;
  const r = sim.takeFromContainer('p', 'c1', uid);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'inv-full');
  assert.equal(sim.containers[0].loot.length, 1, '拒绝后条目留在容器');
  const p = sim.players.get('p');
  assert.equal(p.inventory.length, 0, '背包未收');
});

test('E043: 无效 uid / 不存在的容器 → 明确拒绝原因', () => {
  const sim = mkSim([{ itemId: 'bandage', weight: 0.1, count: 1 }]);
  assert.equal(sim.takeFromContainer('p', 'c1', 'nope').reason, 'no-item');
  assert.equal(sim.takeFromContainer('p', 'c404', 'x').reason, 'no-container');
});

test('E043: interactContainer（全部拿走）在带 uid 的 loot 上仍工作 —— search 语义零回归', () => {
  const sim = mkSim([
    { itemId: 'bandage', weight: 0.1, count: 1 },
    { itemId: 'ifak', weight: 0.3, count: 1 }
  ]);
  const r = sim.interactContainer('p', 'c1');
  assert.ok(Array.isArray(r) && r.length === 2, '全拿 2 件');
  assert.ok(r.every(i => i.uid), 'picked 条目带 uid');
  assert.equal(sim.containers[0].looted, true, '全拿后 looted（原语义：只标记不清数组，客户端靠 looted 置灰）');
});

test('E043: _tagLoot 直接可用（尸体等运行时生成路径同一实现）', () => {
  const sim = mkSim([]);
  const a = sim._tagLoot({ itemId: 'bandage', count: 1 });
  const b = sim._tagLoot({ itemId: 'bandage', count: 1 });
  assert.ok(a.uid && b.uid && a.uid !== b.uid, '每次生成唯一 uid');
  const again = sim._tagLoot({ itemId: 'x', uid: 'keep-me' });
  assert.equal(again.uid, 'keep-me', '已有 uid 保留');
});
