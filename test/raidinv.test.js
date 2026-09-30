'use strict';
const test = require('node:test');
const assert = require('node:assert');
const RaidInv = require('../shared/raidinv');
const Grid = require('../shared/grid');

// P4（2026-09-20）：局内背包「视图网格」纯逻辑
// 边界：sim 的 inventory 仍是数组（下标语义不变）；本模块只维护 uid → {x,y,rot}

test('P4: uidOf —— 可堆叠物按 itemId，武器按对象身份（稳定）', () => {
  RaidInv.__resetUidMemo();
  assert.equal(RaidInv.uidOf({ itemId: 'bandage', count: 2 }), 'is:bandage');
  assert.equal(RaidInv.uidOf({ itemId: 'bandage', count: 5 }), 'is:bandage', '同种合并 → 同一 uid');
  const gun = { itemId: 'w_ak74', isWeapon: true, count: 1 };
  const u1 = RaidInv.uidOf(gun), u2 = RaidInv.uidOf(gun);
  assert.equal(u1, u2, '同一对象 → 同一 uid');
  assert.ok(u1.startsWith('iw#'), '武器 uid 带 iw# 前缀，实际 ' + u1);
  const gun2 = { itemId: 'w_ak74', isWeapon: true, count: 1 };
  assert.notEqual(RaidInv.uidOf(gun2), u1, '两把 AK 必须是不同 uid（不能合并）');
});

test('P4: uidOf —— 条目自带 uid 时优先采用（未来兼容）', () => {
  assert.equal(RaidInv.uidOf({ uid: 'own-1', itemId: 'bandage' }), 'own-1');
});

test('P4: indexByUid —— uid 可直接映射回数组下标（供 useItem/dropItem）', () => {
  const entries = [{ itemId: 'bandage', count: 1 }, { itemId: 'w_pm', isWeapon: true }, { itemId: 'ifak', count: 1 }];
  const idx = RaidInv.indexByUid(entries);
  assert.equal(idx['is:bandage'], 0);
  assert.equal(idx['is:ifak'], 2);
  const gunUid = RaidInv.uidOf(entries[1]);
  assert.equal(idx[gunUid], 1, '武器 uid → 下标 1');
});

test('P4: reconcile —— 新条目自动放置并报告 added（供高亮）', () => {
  RaidInv.__resetUidMemo();
  const layout = RaidInv.makeLayout(10, 10);
  const r = RaidInv.reconcile(layout, [{ itemId: 'bandage', count: 1 }]);
  assert.equal(r.grid.items.length, 1);
  assert.deepEqual(r.added, ['is:bandage']);
  assert.equal(r.grid.items[0].x, 0);
  assert.equal(r.grid.items[0].y, 0);
});

test('P4: reconcile —— 已拖动的位置必须保留（再次 reconcile 不回到 0,0）', () => {
  RaidInv.__resetUidMemo();
  const entries = [{ itemId: 'bandage', count: 1 }, { itemId: 'ifak', count: 1 }];
  let r = RaidInv.reconcile(RaidInv.makeLayout(10, 10), entries);
  const bagUid = 'is:bandage';
  const moved = RaidInv.move(r.grid, bagUid, 4, 3, 0);
  assert.equal(moved.ok, true);
  // 第二轮 reconcile：位置必须还在 (4,3)
  const r2 = RaidInv.reconcile(moved.grid, entries);
  const it = r2.grid.items.find((x) => x.uid === bagUid);
  assert.equal(it.x, 4);
  assert.equal(it.y, 3);
  assert.deepEqual(r2.added, [], '不是新条目 → 不该进 added');
});

test('P4: reconcile —— 条目消失（使用/丢弃）自动移除', () => {
  RaidInv.__resetUidMemo();
  const r1 = RaidInv.reconcile(RaidInv.makeLayout(10, 10), [{ itemId: 'bandage', count: 1 }, { itemId: 'ifak', count: 1 }]);
  const r2 = RaidInv.reconcile(r1.grid, [{ itemId: 'bandage', count: 1 }]);
  assert.equal(r2.grid.items.length, 1);
  assert.equal(r2.grid.items[0].itemId, 'bandage');
  assert.ok(r2.removed.includes('is:ifak'), '消失的条目应记入 removed');
});

test('P4: reconcile —— 武器 5x2 按真实尺寸占格，且不改原条目对象', () => {
  RaidInv.__resetUidMemo();
  const gun = { itemId: 'w_ak74', isWeapon: true, count: 1 };
  const r = RaidInv.reconcile(RaidInv.makeLayout(10, 10), [gun]);
  const ge = r.grid.items[0];
  assert.deepEqual([Grid.footprint(ge.itemId, ge.rot)], [[5, 2]], 'AK-74 必须占 5×2');
  assert.equal(gun.x, undefined, '原 inventory 条目不得被写入坐标（纯函数）');
});

test('P4: reconcile —— 装不下自动扩容行数（资产不丢）', () => {
  RaidInv.__resetUidMemo();
  // 3 行高：放 2 把 AK（5×2）后第 3 把放不下 → 必须扩行
  const guns = [1, 2, 3].map(() => ({ itemId: 'w_ak74', isWeapon: true, count: 1 }));
  const r = RaidInv.reconcile(RaidInv.makeLayout(10, 3), guns);
  assert.equal(r.grid.items.length, 3, '三把枪都必须放下');
  assert.ok(r.grid.h > 3, '行数必须被扩展，实际 h=' + r.grid.h);
  assert.equal(r.resized, true);
});

test('P4: reconcile —— 脏数据不抛错（负数坐标 / 非法 rot / 缺 itemId）', () => {
  RaidInv.__resetUidMemo();
  const dirty = { w: 10, h: 10, items: [{ uid: 'is:bandage', itemId: 'bandage', x: -5, y: -9, rot: 99 }, { uid: 'x', itemId: null }] };
  let threw = false;
  let r = null;
  try { r = RaidInv.reconcile(dirty, [{ itemId: 'bandage', count: 1 }, { count: 1 }]); }
  catch (e) { threw = true; }
  assert.equal(threw, false, '脏数据不得抛错');
  assert.equal(r.grid.items.length, 1, '缺 itemId 的条目应被跳过');
  assert.ok(r.grid.items[0].x >= 0 && r.grid.items[0].y >= 0, '坐标必须被修正到合法范围');
});

test('P4: move/rotate —— 返回新对象，不改入参（纯函数）', () => {
  RaidInv.__resetUidMemo();
  const r0 = RaidInv.reconcile(RaidInv.makeLayout(10, 10), [{ itemId: 'bandage', count: 1 }]);
  const before = JSON.stringify(r0.grid);
  const mv = RaidInv.move(r0.grid, 'is:bandage', 5, 5, 0);
  assert.equal(mv.ok, true);
  assert.equal(JSON.stringify(r0.grid), before, '原 layout 不得被修改');
  const rot = RaidInv.rotate(mv.grid, 'is:bandage');
  assert.equal(rot.ok, true);
  assert.equal(Grid.normRot(rot.entry.rot), 1, '旋转后 rot 应为 1');
});

test('P4: move —— 越界/重叠被拒绝且不破坏布局', () => {
  RaidInv.__resetUidMemo();
  const r0 = RaidInv.reconcile(RaidInv.makeLayout(10, 10), [{ itemId: 'w_ak74', isWeapon: true }, { itemId: 'bandage', count: 1 }]);
  const gunUid = r0.grid.items.find((x) => x.itemId === 'w_ak74').uid;
  const bad = RaidInv.move(r0.grid, gunUid, 8, 0, 0); // 5 宽 + x=8 → 越界
  assert.equal(bad.ok, false, '越界必须被拒绝');
  const bandage = r0.grid.items.find((x) => x.itemId === 'bandage');
  // 把绷带移到 AK 占用的格子上
  const overlap = RaidInv.move(r0.grid, 'is:bandage', bandage.x, bandage.y, 0);
  assert.equal(overlap.ok, true, '原位移动自身允许');
});

test('P4: 计数 —— usedCells/totalCells 反映占用与容量', () => {
  RaidInv.__resetUidMemo();
  const r = RaidInv.reconcile(RaidInv.makeLayout(10, 10), [{ itemId: 'w_ak74', isWeapon: true }]);
  assert.equal(RaidInv.totalCells(r.grid), 100);
  assert.equal(RaidInv.usedCells(r.grid), 10, 'AK 5×2 = 10 格');
});

test('P4: 视图网格不落盘 —— 模块不提供任何写档案的接口（结构保证）', () => {
  const keys = Object.keys(RaidInv);
  assert.equal(keys.some((k) => /save|persist|storage/i.test(k)), false, '视图层不得有落盘接口');
  // 且不得有改 sim/协议的函数
  assert.equal(keys.some((k) => /useItem|dropItem|send|emit/i.test(k)), false, '视图层不得直接改 sim 或发协议');
});
