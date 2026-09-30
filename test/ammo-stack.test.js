'use strict';
/*
 * E045 弹药实体化（2026-09-26）专项防线
 * 语义：弹药 = 背包/仓库里的**实体堆叠条目**（itemId 即口径，1×1 格，受 stackMax 约束）；
 *       ammoLib 降级为**派生视图**（口径 → 持有总量），协议字段名不变。
 * 覆盖：内容表实体化 / 堆叠上限与不丢数 / 拆叠 / 迁移幂等 / 携带 / 局内拆包与换弹
 */
const test = require('node:test');
const assert = require('node:assert');
const Grid = require('../shared/grid');
const Loadout = require('../shared/loadout');
const ITEMS = require('../shared/items');
const CFG = require('../shared/config').CFG;

const CAL = ['545x39', '9x18', '762x39', '919', '762x54'];

test('E045: 弹药物品为一等公民（内容表有 size/type/weight，且可堆叠）', () => {
  for (const cal of CAL) {
    const d = ITEMS.LOOT[cal];
    assert.ok(d, cal + ' 必须在物品查找表 ITEMS.LOOT 中（UI 取名/售价走这张表）');
    assert.equal(d.type, 'ammo', cal + ' type 必须为 ammo');
    assert.deepEqual(d.size, [1, 1], cal + ' 必须占 1×1 格');
    assert.ok(d.weight > 0, cal + ' 必须有单发重量（实体化后占背包承重）');
    assert.equal(Grid.isStackable(cal), true, cal + ' 必须可堆叠（非武器）');
    assert.ok(Grid.stackOf(cal) > 0, cal + ' 必须有堆叠上限');
  }
});

test('E045: 堆叠上限统一取调参表 stackMax', () => {
  assert.equal(Grid.stackOf('545x39'), CFG.grid.stackMax);
  assert.equal(Grid.stackOf('9x18'), CFG.grid.stackMax);
});

test('E045: addItem 超上限自动分叠且数量守恒（绝不截断丢弃）', () => {
  const cap = Grid.stackOf('545x39');
  const total = cap * 2 + 7;
  const r = Grid.addItem(Grid.makeGrid(10, 30), { itemId: '545x39', count: total });
  assert.equal(r.ok, true);
  assert.equal(Grid.countOf(r.grid, '545x39'), total, '总数量必须守恒（旧实现会 Math.min 截断）');
  assert.equal(r.grid.items.length, 3, '应分成 3 叠');
  for (const e of r.grid.items) assert.ok(e.count <= cap, '单叠不得超过上限');
});

test('E045: addItem 空间不足 → 原子失败（原网格不变，不留半份）', () => {
  const cap = Grid.stackOf('545x39');
  const g = Grid.makeGrid(1, 1); // 仅 1 格
  const r = Grid.addItem(g, { itemId: '545x39', count: cap + 1 });
  assert.equal(r.ok, false);
  assert.equal(r.grid.items.length, 0, '失败时不得留下半份（否则等于吞掉玩家弹药）');
});

test('E045: splitStack 拆叠——总量守恒、参数非法拒绝', () => {
  const a = Grid.addItem(Grid.makeGrid(10, 30), { itemId: '545x39', count: 40 });
  const uid = a.grid.items[0].uid;
  const s = Grid.splitStack(a.grid, uid, 15);
  assert.equal(s.ok, true);
  assert.equal(Grid.countOf(s.grid, '545x39'), 40, '拆叠前后总量守恒');
  assert.equal(s.grid.items.length, 2);
  assert.equal(s.entry.count, 15);
  assert.equal(Grid.splitStack(s.grid, uid, 0).ok, false, '拆 0 → 拒绝');
  assert.equal(Grid.splitStack(s.grid, uid, 999).ok, false, '拆全部 → 拒绝（应整体移动）');
});

test('E045: ammoLibToGrid 幂等——只补差额，联机往返不翻倍', () => {
  const first = Grid.ammoLibToGrid(Grid.makeGrid(10, 30), { '545x39': 100 });
  assert.equal(Grid.countOf(first.grid, '545x39'), 100, '首次迁入 100');
  const second = Grid.ammoLibToGrid(first.grid, { '545x39': 100 });
  assert.equal(Grid.countOf(second.grid, '545x39'), 100, '再次迁移不得翻倍（关键：档案多轮往返）');
  const third = Grid.ammoLibToGrid(second.grid, { '545x39': 130 });
  assert.equal(Grid.countOf(third.grid, '545x39'), 130, '只补 30 差额');
});

test('E045: syncProfile 迁移老档案 ammoLib → 仓库实体弹药（且二次同步不翻倍）', () => {
  const legacy = { name: 'L', money: 0, stash: [{ itemId: 'bandage', count: 1 }], ammoLib: { '545x39': 100, '9x18': 40 } };
  const a = Loadout.ensure(legacy);
  assert.equal(Grid.countOf(a.grid, '545x39'), 100, '老档案弹药必须落成仓库格实体');
  assert.equal(Grid.countOf(a.grid, '9x18'), 40);
  assert.deepEqual(a.ammoLib, { '545x39': 100, '9x18': 40 }, '派生视图与仓库一致');
  const b = Loadout.ensure(a);
  assert.equal(Grid.countOf(b.grid, '545x39'), 100, '二次同步不得翻倍');
  assert.equal(CountOfStash(b, '545x39'), 100, 'stash 对外格式亦一致');
});
function CountOfStash(p, id) {
  return (p.stash || []).filter(s => s.itemId === id).reduce((s, x) => s + (x.count || 1), 0);
}

test('E045: 携带从仓库实体弹药扣除，格子同步扣减', () => {
  const p0 = Loadout.ensure({ name: 'C', money: 0, stash: [{ itemId: '545x39', count: 100 }], ammoLib: {} });
  const carried = ITEMS.takeCarry(p0, { ammo: { '545x39': 60 }, items: [] });
  assert.equal(carried.raidAmmo['545x39'], 60, '携带清单 60 发');
  assert.equal(carried.profile.ammoLib['545x39'], 40, '仓库剩 40（派生）');
  const back = Loadout.syncProfile(carried.profile).profile;
  assert.equal(Grid.countOf(back.grid, '545x39'), 40, '格子同步扣减');
});

test('E045: 局内——进图弹药实体化 / 弹药箱拆包 / 派生 ammoLib', () => {
  const SIM = require('../shared/sim');
  const GameSim = SIM.GameSim || SIM;
  const sim = new GameSim({ testMode: true, shotCooldown: 0 });
  sim.addPlayer('aaaaaa', 'A', { ammoLib: { '545x39': 45 }, inventory: [] });
  const a = sim.players.get('aaaaaa');
  assert.equal(a.inventory.length, 1, '进图弹药以实体堆叠入背包');
  assert.equal(a.inventory[0].itemId, '545x39', '条目 id = 口径');
  assert.equal(a.inventory[0].count, 45);
  assert.ok(a.inventory[0].weight > 0, '弹药条目带重量');
  assert.equal(a.ammoLib['545x39'], 45, '派生弹药库可见');
  // 弹药箱进容器 → 拆包成散装堆叠
  const box = { id: 'box_t', x: 0, z: 0, label: '弹药箱', looted: false,
    loot: [{ itemId: 'ammo_box_545', weight: 0.5, count: 1, ammo: { ammoId: '545x39', count: 30 } }] };
  sim.containers.push(box);
  a.x = 0; a.z = 0;
  sim.interactContainer('aaaaaa', 'box_t');
  assert.equal(a.ammoLib['545x39'], 75, '拆包后派生库 45 + 30');
  assert.ok(a.inventory.every(x => x.itemId !== 'ammo_box_545'), '箱体不留背包（已拆包）');
});

test('E045: 局内——换弹从背包实体堆叠扣（打完即从背包消失）', () => {
  const SIM = require('../shared/sim');
  const GameSim = SIM.GameSim || SIM;
  const sim = new GameSim({ testMode: true, shotCooldown: 0 });
  sim.addPlayer('aaaaaa', 'A', {
    weapon: { weaponId: 'ak74', name: 'AK-74', dmg: 24, fireRate: 650, magSize: 30, slots: [], ammo: { ammoId: '545x39', count: 0, reserve: 30 } },
    inventory: []
  });
  const a = sim.players.get('aaaaaa');
  assert.equal(a.ammoLib['545x39'], 30, '备弹进背包（派生可见）');
  sim.reload(a);
  a.reloadDoneAt = Date.now() - 2000;
  sim.tick(1 / 60);
  assert.equal(a.weapon.ammo.count, 30, '弹匣补满');
  assert.equal(a.ammoLib['545x39'] || 0, 0, '背包弹药被抽空（实体消耗）');
  assert.equal(a.inventory.filter(x => x.itemId === '545x39').length, 0, '背包内弹药条目已清空');
});
