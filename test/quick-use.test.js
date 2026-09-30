/*
 * EXFIL ZONE · B4 快捷使用单元测试（test/quick-use.test.js）
 *
 * 锁定 shared/sim.js 的 B4 契约（2026-09-26）：
 *   1) quickUse 仅放行 src==='rig' 的条目；backpack / 缺省 src 一律拒绝且状态零变化
 *   2) useItem 原语义零变化（不校验 src = 全背包可手动使用）—— E020/E045 回归锁
 *   3) addInvItem：不同 src 的同 itemId 不合并（防胸挂叠被搜刮物污染）；同 src 照常合并
 *   4) _consumeInvItem 主体：事件（usedItem/invChanged）+ refreshAmmoLib 派生与原实现一致
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GameSim } = require('../shared/sim');

function makeSimWith(items) {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { inventory: items });
  return sim;
}
// 找到指定 itemId 的背包下标
function idxOf(p, itemId) {
  return p.inventory.findIndex((e) => e.itemId === itemId && !e.isWeapon);
}

test('B4: quickUse 放行胸挂（src=rig）医疗品，消耗 1 件并加血', () => {
  const sim = makeSimWith([{ itemId: 'bandage', weight: 0.1, count: 3, src: 'rig' }]);
  const p = sim.players.get('aaaaaa');
  p.hp = 60;
  const i = idxOf(p, 'bandage');
  const r = sim.quickUse('aaaaaa', i, 20, null);
  assert.equal(r.ok, true, 'rig 条目必须放行');
  assert.equal(r.used.itemId, 'bandage');
  assert.equal(p.hp, 80, 'heal=20 应生效');
  assert.equal(p.inventory[i].count, 2, '应消耗 1 件');
});

test('B4: quickUse 拒绝背包条目（src=backpack）且状态零变化', () => {
  const sim = makeSimWith([{ itemId: 'bandage', weight: 0.1, count: 3, src: 'backpack' }]);
  const p = sim.players.get('aaaaaa');
  p.hp = 60;
  const i = idxOf(p, 'bandage');
  const r = sim.quickUse('aaaaaa', i, 20, null);
  assert.equal(r.ok, false, 'backpack 条目必须拒绝');
  assert.equal(r.reason, 'not-quick-usable');
  assert.equal(p.hp, 60, '拒绝时不得加血');
  assert.equal(p.inventory[i].count, 3, '拒绝时不得消耗');
});

test('B4: quickUse 对缺省 src（undefined）保守拒绝（宁少不多）', () => {
  const sim = makeSimWith([{ itemId: 'bandage', weight: 0.1, count: 2 }]);
  const p = sim.players.get('aaaaaa');
  const i = idxOf(p, 'bandage');
  const r = sim.quickUse('aaaaaa', i, 20, null);
  assert.equal(r.ok, false, '缺省 src 必须拒绝（视为 backpack）');
  assert.equal(r.reason, 'not-quick-usable');
});

test('B4: quickUse 拒绝武器条目（武器走 equipWeapon，不参与快捷使用）', () => {
  const sim = makeSimWith([]);
  const p = sim.players.get('aaaaaa');
  p.inventory.push({ isWeapon: true, weaponId: 'w_ak74', itemId: 'w_ak74', weight: 3, count: 1, src: 'rig' });
  const r = sim.quickUse('aaaaaa', p.inventory.length - 1, 0, null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'is-weapon');
});

test('B4: quickUse 对无效玩家/下标返回 no-item', () => {
  const sim = makeSimWith([]);
  assert.deepEqual(sim.quickUse('nobody', 0, 0, null), { ok: false, reason: 'no-item' });
  assert.deepEqual(sim.quickUse('aaaaaa', 99, 0, null), { ok: false, reason: 'no-item' });
});

test('B4 回归锁: useItem 原语义不变——背包条目手动使用放行（不校验 src）', () => {
  const sim = makeSimWith([{ itemId: 'bandage', weight: 0.1, count: 3, src: 'backpack' }]);
  const p = sim.players.get('aaaaaa');
  p.hp = 50;
  const i = idxOf(p, 'bandage');
  const used = sim.useItem('aaaaaa', i, 30, null);
  assert.ok(used, 'useItem 必须放行（E020 原语义）');
  assert.equal(used.itemId, 'bandage');
  assert.equal(p.hp, 80);
  assert.equal(p.inventory[i].count, 2);
});

test('B4 回归锁: useItem 对缺省 src 条目照常放行（老存档/搜刮物兼容）', () => {
  const sim = makeSimWith([{ itemId: 'bandage', weight: 0.1, count: 2 }]);
  const p = sim.players.get('aaaaaa');
  p.hp = 10;
  const used = sim.useItem('aaaaaa', idxOf(p, 'bandage'), 25, null);
  assert.ok(used);
  assert.equal(p.hp, 35);
});

test('B4 回归锁: useItem 弹药箱拆包 + ammoLib 派生（E045 契约不破）', () => {
  const sim = makeSimWith([]);
  const p = sim.players.get('aaaaaa');
  p.inventory.push({ itemId: 'ammo_box_545', weight: 0.5, count: 1 });
  const i = p.inventory.findIndex((e) => e.itemId === 'ammo_box_545');
  sim.useItem('aaaaaa', i, 0, { ammoId: '545x39', count: 60 });
  // 弹药箱消耗 → 散装弹药堆叠入包 → 派生 ammoLib
  assert.ok(!p.inventory.some((e) => e.itemId === 'ammo_box_545'), '弹药箱应被消耗');
  const stack = p.inventory.find((e) => e.itemId === '545x39');
  assert.ok(stack, '散装弹药应入包');
  assert.equal(p.ammoLib['545x39'], 60, 'ammoLib 派生必须正确（E045）');
});

test('B4: addInvItem 不同 src 的同 itemId 不合并（防胸挂叠被搜刮物污染）', () => {
  const sim = makeSimWith([{ itemId: 'bandage', weight: 0.1, count: 2, src: 'rig' }]);
  const p = sim.players.get('aaaaaa');
  sim.addInvItem(p, { itemId: 'bandage', weight: 0.1, count: 3 }); // 搜刮入包（缺省 backpack）
  const stacks = p.inventory.filter((e) => e.itemId === 'bandage');
  assert.equal(stacks.length, 2, '必须分成两个叠');
  const rig = stacks.find((e) => e.src === 'rig');
  const bag = stacks.find((e) => !e.src || e.src === 'backpack');
  assert.ok(rig && bag, 'rig 叠与 backpack 叠各自独立');
  assert.equal(rig.count, 2, '胸挂叠数量不得被污染');
  assert.equal(bag.count, 3);
});

test('B4: addInvItem 同 itemId 同 src 照常合并（进图载荷/多次同源入包）', () => {
  const sim = makeSimWith([{ itemId: 'bandage', weight: 0.1, count: 2, src: 'rig' }]);
  const p = sim.players.get('aaaaaa');
  sim.addInvItem(p, { itemId: 'bandage', weight: 0.1, count: 1, src: 'rig' });
  const stacks = p.inventory.filter((e) => e.itemId === 'bandage');
  assert.equal(stacks.length, 1, '同 src 应合并为一个叠');
  assert.equal(stacks[0].count, 3);
});

test('B4: addInvItem 弹药（缺省 src）在 stackMax 内照常合并为一叠', () => {
  const sim = makeSimWith([]);
  const p = sim.players.get('aaaaaa');
  sim.addInvItem(p, { itemId: '545x39', weight: 0.01, count: 20 });
  sim.addInvItem(p, { itemId: '545x39', weight: 0.01, count: 30 });
  const stacks = p.inventory.filter((e) => e.itemId === '545x39');
  assert.equal(stacks.length, 1, '20+30=50 ≤ stackMax(60) → 一叠');
  assert.equal(stacks[0].count, 50);
});

test('B4: _consumeInvItem 事件契约（usedItem/invChanged）与原实现一致', () => {
  const sim = makeSimWith([{ itemId: 'bandage', weight: 0.1, count: 3, src: 'rig' }]);
  const p = sim.players.get('aaaaaa');
  p.hp = 50;
  const events = [];
  const origEmit = sim.emit.bind(sim);
  sim.emit = (type, data) => { events.push({ type, data }); return origEmit(type, data); };
  const i = idxOf(p, 'bandage');
  sim.quickUse('aaaaaa', i, 10, null);
  const used = events.find((e) => e.type === 'usedItem');
  const inv = events.find((e) => e.type === 'invChanged');
  assert.ok(used, '必须发 usedItem');
  assert.equal(used.data.id, 'aaaaaa');
  assert.equal(used.data.hp, 60);
  assert.equal(used.data.remaining, 2);
  assert.ok(inv, '必须发 invChanged');
  assert.equal(inv.data.weight, 0.1 * 2, 'invWeight 应按剩余数量计算');
});
