'use strict';
/*
 * EXFIL ZONE · 配装网格测试（P1：shared/grid.js 冻结接口）
 * 覆盖：尺寸/槽位查表 · 放置与碰撞 · 寻空位 · 旋转 · 堆叠 · 不可变性 ·
 *       容错修复（越界/重叠/溢出/脏数据）· 旧档案双向适配 · 装备槽框架
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const G = require('../shared/grid');

// ---------- 工具 ----------
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
function frozenGrid(w, h, entries) {
  const g = { w, h, items: entries.map(e => ({ uid: e.uid || G.makeUid(), rot: 0, count: 1, ...e })) };
  return deepFreeze(g);
}
function firstUid(grid) { return grid.items[0].uid; }

// ========== 1. 尺寸与槽位（D1 = 真实塔克夫尺寸） ==========
test('P1: itemSize 从 content.json 读取真实塔克夫尺寸', () => {
  assert.deepEqual(G.itemSize('w_ak74'), [5, 2], 'AK-74 应为 5×2（Wiki 实测）');
  assert.deepEqual(G.itemSize('w_akm'), [5, 2], 'AKM 应为 5×2');
  assert.deepEqual(G.itemSize('w_mp5'), [3, 2], 'MP5 应为 3×2（Wiki 实测）');
  assert.deepEqual(G.itemSize('w_sv98'), [5, 2], 'SV-98 应为 5×2');
  assert.deepEqual(G.itemSize('w_pm'), [2, 1], 'PM 应为 2×1');
  assert.deepEqual(G.itemSize('bandage'), [1, 1], '绷带应为 1×1');
  assert.deepEqual(G.itemSize('graphics_card'), [2, 1], '显卡应为 2×1');
  assert.deepEqual(G.itemSize('toolbox'), [2, 2], '工具箱应为 2×2');
});
test('P1: weapons 表与 loot 表同名武器尺寸一致（D1 一致性）', () => {
  for (const wid of Object.keys(G.defOf ? require('../shared/items').WEAPONS : {})) {
    const lootId = 'w_' + wid;
    if (!require('../shared/items').LOOT[lootId]) continue;
    assert.deepEqual(G.itemSize(wid), G.itemSize(lootId), `${wid} 与 ${lootId} 尺寸不一致`);
  }
});
test('P1: 未知物品尺寸回退 [1,1]（不崩）', () => {
  assert.deepEqual(G.itemSize('no_such_item_xyz'), [1, 1]);
  assert.deepEqual(G.itemSize(undefined), [1, 1]);
  assert.deepEqual(G.itemSize(null), [1, 1]);
});
test('P1: slotsFor 返回数组（D5：支持复合装备）', () => {
  assert.deepEqual(G.slotsFor('w_ak74'), ['primary', 'secondary']);
  assert.deepEqual(G.slotsFor('w_pm'), ['secondary']);
  assert.deepEqual(G.slotsFor('bandage'), [], '无装备槽物品应返回空数组');
  assert.ok(Array.isArray(G.slotsFor('no_such_item_xyz')), '未知物品也必须是数组');
});
test('P1: isStackable —— 武器不可堆叠，杂物可堆叠', () => {
  assert.equal(G.isStackable('w_ak74'), false, '武器每把独立（各有弹药/改装）');
  assert.equal(G.isStackable('bandage'), true);
  assert.equal(G.isStackable('ammo_box_545'), true);
});
test('P1: 旋转语义（normRot / footprint）', () => {
  assert.equal(G.normRot(1), 1);
  assert.equal(G.normRot(90), 1, '90 视为旋转态');
  assert.equal(G.normRot(0), 0);
  assert.equal(G.normRot('abc'), 0, '非法值归一为 0');
  assert.deepEqual(G.footprint('w_ak74', 0), [5, 2]);
  assert.deepEqual(G.footprint('w_ak74', 1), [2, 5], '旋转后宽高互换');
});
test('P1: gridCfg 从 tuning.json 读取仓库尺寸（10×30）', () => {
  const c = G.gridCfg();
  assert.equal(c.w, 10);
  assert.equal(c.h, 30);
  assert.ok(c.slots.indexOf('primary') >= 0 && c.slots.indexOf('armor') >= 0, '七个装备槽齐全');
  assert.equal(G.totalCells(G.makeGrid()), 300, '仓库总格数 = 10×30');
});

// ========== 2. 放置与碰撞 ==========
test('P1: 空网格任意合法位置可放置', () => {
  const g = G.makeGrid(10, 30);
  assert.equal(G.canPlace(g, 'w_ak74', 0, 0), true);
  assert.equal(G.canPlace(g, 'w_ak74', 5, 28), true, '恰好贴右下边');
});
test('P1: 越界判定（四个方向各一例）', () => {
  const g = G.makeGrid(10, 30);
  assert.equal(G.canPlace(g, 'w_ak74', -1, 0), false, '左越界');
  assert.equal(G.canPlace(g, 'w_ak74', 0, -1), false, '上越界');
  assert.equal(G.canPlace(g, 'w_ak74', 6, 0), false, '右越界（5 宽 + 6 = 11 > 10）');
  assert.equal(G.canPlace(g, 'w_ak74', 0, 29), false, '下越界（2 高 + 29 = 31 > 30）');
  assert.equal(G.canPlace(g, 'w_ak74', 5, 0), true, '右边界合法');
  assert.equal(G.canPlace(g, 'w_ak74', 0, 28), true, '下边界合法');
});
test('P1: 重叠判定', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'w_ak74', x: 0, y: 0, uid: 'a1' }]);
  assert.equal(G.canPlace(g, 'bandage', 0, 0), false, '压在武器上');
  assert.equal(G.canPlace(g, 'bandage', 4, 1), false, '压在武器右下角');
  assert.equal(G.canPlace(g, 'bandage', 5, 0), true, '紧邻武器右侧可放');
  assert.equal(G.canPlace(g, 'bandage', 0, 2), true, '紧邻武器下方可放');
});
test('P1: canPlace 可通过 skipUid 豁免自身（移动/旋转用）', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'w_ak74', x: 0, y: 0, uid: 'self' }]);
  assert.equal(G.canPlace(g, 'w_ak74', 0, 0), false, '不带豁免 → 与自己重叠');
  assert.equal(G.canPlace(g, 'w_ak74', 0, 0, { skipUid: 'self' }), true, '带豁免 → 视为可放');
});
test('P1: place 不修改入参（不可变性）', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'bandage', x: 0, y: 0, uid: 'b1' }]);
  const before = JSON.stringify(g);
  const r = G.place(g, G.makeEntry('w_ak74', { uid: 'a1' }), 2, 2);
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(g), before, '原网格必须原封不动');
  assert.equal(r.grid.items.length, 2, '新网格含新增条目');
  assert.notEqual(r.grid, g, '返回新引用');
});
test('P1: place 失败时返回原网格引用', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'bandage', x: 0, y: 0, uid: 'b1' }]);
  const r = G.place(g, G.makeEntry('bandage', { uid: 'b2' }), 0, 0);
  assert.equal(r.ok, false);
  assert.equal(r.grid, g, '失败不得产生新对象');
});

// ========== 3. 寻空位 ==========
test('P1: findFreeSpot 首次适配（先行后列）', () => {
  assert.deepEqual(G.findFreeSpot(G.makeGrid(10, 30), 'bandage'), { x: 0, y: 0 });
  assert.deepEqual(G.findFreeSpot(G.makeGrid(10, 30), 'w_ak74'), { x: 0, y: 0 });
});
test('P1: findFreeSpot 跳过已占用格', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'bandage', x: 0, y: 0, uid: 'b1' }]);
  assert.deepEqual(G.findFreeSpot(g, 'bandage'), { x: 1, y: 0 });
});
test('P1: findFreeSpot 支持 [w,h] 与旋转', () => {
  const g = G.makeGrid(3, 6);
  assert.equal(G.findFreeSpot(g, [5, 2], 0), null, '5 宽放不进 3 宽');
  assert.deepEqual(G.findFreeSpot(g, [5, 2], 1), { x: 0, y: 0 }, '旋转成 2×5 后可放');
});
test('P1: findFreeSpot 无空位返回 null', () => {
  const g = G.makeGrid(1, 1);
  assert.equal(G.findFreeSpot(g, 'w_ak74'), null);
});

// ========== 4. 自动放入与堆叠 ==========
test('P1: addItem 自动寻位放入', () => {
  const g = G.makeGrid(10, 30);
  const r = G.addItem(g, { itemId: 'w_ak74', count: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.grid.items.length, 1);
  assert.deepEqual([r.grid.items[0].x, r.grid.items[0].y], [0, 0]);
});
test('P1: addItem 可堆叠物品并堆（不新增条目）', () => {
  const g = G.makeGrid(10, 30);
  const a = G.addItem(g, { itemId: 'bandage', count: 2 });
  const b = G.addItem(a.grid, { itemId: 'bandage', count: 3 });
  assert.equal(b.grid.items.length, 1, '同物品应并堆');
  assert.equal(b.grid.items[0].count, 5);
  assert.equal(b.stacked, true);
  assert.equal(G.countOf(b.grid, 'bandage'), 5);
});
test('P1: addItem 武器不堆叠（两把 AK = 两条目）', () => {
  const g = G.makeGrid(10, 30);
  const a = G.addItem(g, { itemId: 'w_ak74' });
  const b = G.addItem(a.grid, { itemId: 'w_ak74' });
  assert.equal(b.grid.items.length, 2, '武器每把独立条目');
  assert.notEqual(b.grid.items[0].uid, b.grid.items[1].uid);
});
test('P1: addItem 可指定 stack:false 强制独立条目', () => {
  const g = G.makeGrid(10, 30);
  const a = G.addItem(g, { itemId: 'bandage', count: 1 });
  const b = G.addItem(a.grid, { itemId: 'bandage', count: 1 }, { stack: false });
  assert.equal(b.grid.items.length, 2);
  assert.equal(b.stacked, undefined);
});
test('P1: addItem 空间不足返回 ok:false 且不丢条目', () => {
  const g = G.makeGrid(2, 1);
  const r = G.addItem(g, { itemId: 'w_ak74' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-space');
  assert.equal(r.grid.items.length, 0);
});
test('P1: addItem 尊重传入的 rot（含 item.rot 与 opts.rot 两种写法）', () => {
  const a = G.addItem(G.makeGrid(10, 30), { itemId: 'w_pm', count: 1, rot: 1 });
  assert.equal(a.ok, true);
  assert.deepEqual(G.footprint(a.grid.items[0].itemId, a.grid.items[0].rot), [1, 2], 'PM 2×1 以旋转态放入 → 1×2');
  const b = G.addItem(G.makeGrid(10, 30), { itemId: 'w_pm', count: 1 }, { rot: 1 });
  assert.deepEqual(G.footprint(b.grid.items[0].itemId, b.grid.items[0].rot), [1, 2], 'opts.rot 同样生效');
});
test('P1: addItem 原位放不下时自动旋转尝试', () => {
  const g = G.makeGrid(1, 2);              // 宽 1：PM 横放（2×1）放不下
  const r = G.addItem(g, { itemId: 'w_pm', count: 1 });
  assert.equal(r.ok, true, '应自动旋转后放入');
  assert.deepEqual(G.footprint('w_pm', r.grid.items[0].rot), [1, 2], '旋转为 1×2 后容纳');
  assert.deepEqual([r.grid.items[0].x, r.grid.items[0].y], [0, 0]);
});

// ========== 5. 移除 / 移动 / 旋转 ==========
test('P1: removeAt 移除并返回被移条目', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'bandage', x: 0, y: 0, uid: 'b1' }, { itemId: 'bolt', x: 1, y: 0, uid: 'b2' }]);
  const r = G.removeAt(g, 'b1');
  assert.equal(r.ok, true);
  assert.equal(r.removed.itemId, 'bandage');
  assert.equal(r.grid.items.length, 1);
  assert.equal(g.items.length, 2, '原网格不变');
});
test('P1: removeAt 未知 uid 返回 ok:false', () => {
  const g = G.makeGrid(10, 30);
  assert.equal(G.removeAt(g, 'nope').ok, false);
  assert.equal(G.removeAt(g, null).ok, false);
});
test('P1: moveItem 成功移动，保持 uid', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'bandage', x: 0, y: 0, uid: 'b1' }]);
  const r = G.moveItem(g, 'b1', 5, 5);
  assert.equal(r.ok, true);
  assert.equal(r.grid.items[0].uid, 'b1');
  assert.deepEqual([r.grid.items[0].x, r.grid.items[0].y], [5, 5]);
});
test('P1: moveItem 目标被占 → 失败且网格不变', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'bandage', x: 0, y: 0, uid: 'b1' }, { itemId: 'bolt', x: 1, y: 0, uid: 'b2' }]);
  const r = G.moveItem(g, 'b1', 1, 0);
  assert.equal(r.ok, false);
  assert.equal(r.grid, g);
});
test('P1: moveItem 未知 uid → 失败', () => {
  const g = G.makeGrid(10, 30);
  assert.equal(G.moveItem(g, 'ghost', 0, 0).reason, 'no-such-uid');
});
test('P1: rotateItem 空间足够时原地旋转', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'w_ak74', x: 0, y: 0, uid: 'a1' }]);
  const r = G.rotateItem(g, 'a1');
  assert.equal(r.ok, true);
  assert.equal(r.grid.items[0].rot, 1);
  assert.deepEqual([r.grid.items[0].x, r.grid.items[0].y], [0, 0], '原地旋转');
});
test('P1: rotateItem 原地受阻时自动换位', () => {
  const g = frozenGrid(10, 8, [
    { itemId: 'w_ak74', x: 0, y: 0, uid: 'a1' },
    { itemId: 'bandage', x: 0, y: 4, uid: 'b1' }   // 挡住旋转后向下延伸的格
  ]);
  const r = G.rotateItem(g, 'a1');
  assert.equal(r.ok, true);
  assert.equal(r.grid.items.find(e => e.uid === 'a1').rot, 1);
  assert.equal(G.usedCells(r.grid), G.usedCells(g), '占格数不变（只是换了朝向/位置）');
});
test('P1: rotateItem 完全放不下 → 失败', () => {
  const g = frozenGrid(3, 6, [{ itemId: 'w_ak74', x: 0, y: 0, rot: 1, uid: 'a1' }]);
  const r = G.rotateItem(g, 'a1');
  assert.equal(r.ok, false, '5 宽放不进 3 宽');
});

// ========== 6. 度量与扩容 ==========
test('P1: 占格/空格/总格统计', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'w_ak74', x: 0, y: 0 }]);
  assert.equal(G.totalCells(g), 300);
  assert.equal(G.usedCells(g), 10, 'AK-74 占 5×2 = 10 格');
  assert.equal(G.freeCells(g), 290);
});
test('P1: resize 扩容成功', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'w_ak74', x: 0, y: 0 }]);
  const r = G.resize(g, 12, 40);
  assert.equal(r.ok, true);
  assert.equal(r.grid.w, 12);
  assert.equal(r.grid.h, 40);
  assert.equal(r.grid.items.length, 1);
});
test('P1: resize 缩小到装不下 → 拒绝', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'w_ak74', x: 8, y: 0 }]);
  const r = G.resize(g, 5, 5);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'items-out-of-bounds');
});

// ========== 7. 容错修复 ==========
test('P1: normalizeGrid 补齐 uid/rot/count', () => {
  const r = G.normalizeGrid({ w: 10, h: 30, items: [{ itemId: 'bandage' }] });
  const e = r.grid.items[0];
  assert.ok(e.uid, '补 uid');
  assert.equal(e.rot, 0, '补 rot');
  assert.equal(e.count, 1, '补 count');
  assert.deepEqual([e.x, e.y], [0, 0]);
});
test('P1: normalizeGrid 越界条目自动重定位', () => {
  const r = G.normalizeGrid({ w: 10, h: 30, items: [{ itemId: 'bandage', x: 99, y: 99 }] });
  assert.equal(r.grid.items.length, 1, '不丢条目');
  assert.deepEqual([r.grid.items[0].x, r.grid.items[0].y], [0, 0]);
  assert.equal(r.repaired[0].action, 'repositioned');
});
test('P1: normalizeGrid 重叠条目自动解冲突', () => {
  const r = G.normalizeGrid({ w: 10, h: 30, items: [{ itemId: 'bandage', x: 0, y: 0 }, { itemId: 'bolt', x: 0, y: 0 }] });
  assert.equal(r.grid.items.length, 2, '两条目都在');
  assert.equal(G.usedCells(r.grid), 2, '不重叠');
  assert.ok(r.repaired.some(x => x.action === 'deduped'));
});
test('P1: normalizeGrid 重复 uid 自动改写', () => {
  const r = G.normalizeGrid({ w: 10, h: 30, items: [{ itemId: 'bandage', uid: 'dup', x: 0, y: 0 }, { itemId: 'bolt', uid: 'dup', x: 1, y: 0 }] });
  assert.equal(r.grid.items.length, 2);
  assert.notEqual(r.grid.items[0].uid, r.grid.items[1].uid, 'uid 必须唯一');
  assert.ok(r.repaired.some(x => x.action === 'uid-fixed'));
});
test('P1: normalizeGrid 装不下 → overflow（资产不丢）', () => {
  const r = G.normalizeGrid({ w: 1, h: 1, items: [{ itemId: 'bandage' }, { itemId: 'bolt' }] }, { autoGrow: false });
  assert.equal(r.grid.items.length, 1);
  assert.equal(r.overflow.length, 1, '溢出条目进 overflow 而非被丢弃');
  assert.equal(r.overflow[0].itemId, 'bolt');
});
test('P1: normalizeGrid 默认自动扩容（迁移老档案兜底）', () => {
  const r = G.normalizeGrid({ w: 1, h: 1, items: [{ itemId: 'bandage' }, { itemId: 'bolt' }] });
  assert.equal(r.overflow.length, 0, '自动加高后全部容纳');
  assert.equal(r.grid.items.length, 2);
  assert.ok(r.grid.h > 1, '高度已增长');
});
test('P1: normalizeGrid 脏数据不抛错', () => {
  assert.doesNotThrow(() => G.normalizeGrid(null));
  assert.doesNotThrow(() => G.normalizeGrid(undefined));
  assert.doesNotThrow(() => G.normalizeGrid({ items: 'not-an-array' }));
  assert.doesNotThrow(() => G.normalizeGrid({ w: -5, h: 0, items: [null, {}, { itemId: 'bandage' }] }));
  const r = G.normalizeGrid({ w: -5, h: 0, items: [null, {}, { itemId: 'bandage' }] });
  assert.equal(r.grid.items.length, 1, '只保留合法条目');
  assert.ok(r.grid.w >= 1 && r.grid.h >= 1, '非法尺寸回退默认');
});

// ========== 8. 旧档案双向适配（P3 迁移基础） ==========
test('P1: fromLegacyStash 旧武器条目映射到 w_<id> 并保留弹药/改装', () => {
  const r = G.fromLegacyStash([{ weaponId: 'ak74', mods: { sight: 'pso' }, ammo: { ammoId: '545x39', count: 30, reserve: 30 } }]);
  const e = r.grid.items[0];
  assert.equal(e.itemId, 'w_ak74');
  assert.equal(e.mods.sight, 'pso');
  assert.equal(e.ammo.count, 30);
  assert.deepEqual(G.footprint(e.itemId, e.rot), [5, 2]);
});
test('P1: fromLegacyStash 非武器条目按 itemId 保持数量', () => {
  const r = G.fromLegacyStash([{ itemId: 'bandage', count: 3 }]);
  assert.equal(r.grid.items[0].itemId, 'bandage');
  assert.equal(r.grid.items[0].count, 3);
});
test('P1: fromLegacyStash 脏输入不抛错', () => {
  assert.doesNotThrow(() => G.fromLegacyStash(null));
  assert.doesNotThrow(() => G.fromLegacyStash([null, {}, { count: 2 }]));
  assert.equal(G.fromLegacyStash([null, {}, { count: 2 }]).grid.items.length, 0);
});
test('P1: toLegacyStash 往返一致（round-trip）', () => {
  const legacy = [
    { weaponId: 'ak74', mods: { sight: null }, ammo: { ammoId: '545x39', count: 30, reserve: 30 } },
    { weaponId: 'pm', mods: {}, ammo: { ammoId: '9x18', count: 8, reserve: 16 } },
    { itemId: 'bandage', count: 2 }
  ];
  const back = G.toLegacyStash(G.fromLegacyStash(legacy).grid);
  assert.equal(back.length, 3);
  assert.equal(back[0].weaponId, 'ak74');
  assert.equal(back[0].ammo.count, 30);
  assert.equal(back[2].itemId, 'bandage');
  assert.equal(back[2].count, 2);
});
test('P1: toLegacyStash 合并同物品堆叠条目', () => {
  const g = G.makeGrid(10, 30);
  const a = G.addItem(g, { itemId: 'bandage', count: 2 });
  const b = G.addItem(a.grid, { itemId: 'bandage', count: 3 }, { stack: false });
  const legacy = G.toLegacyStash(b.grid);
  assert.equal(legacy.length, 1, '同物品在旧数组中合并为一条');
  assert.equal(legacy[0].count, 5);
});
test('P1: migrateProfile 无 grid → 从 stash 迁移并双写', () => {
  const profile = { id: 'p1', name: 'T', money: 1000, stash: [{ weaponId: 'ak74', mods: {}, ammo: { ammoId: '545x39', count: 30 } }, { itemId: 'bandage', count: 2 }] };
  const r = G.migrateProfile(profile);
  assert.equal(r.migrated, true);
  assert.ok(r.profile.grid, '生成 grid');
  assert.equal(r.profile.grid.items.length, 2);
  assert.ok(Array.isArray(r.profile.stash), 'stash 双写保留（过渡期既有代码仍可读）');
  assert.equal(r.profile.stash.length, 2);
  assert.equal(profile.grid, undefined, '原档案对象不被修改');
});
test('P1: migrateProfile 已有 grid → 规范化并保留坐标', () => {
  const profile = { stash: [], grid: { w: 10, h: 30, items: [{ itemId: 'bandage', uid: 'u1', x: 4, y: 7, rot: 0, count: 1 }] } };
  const r = G.migrateProfile(profile);
  assert.equal(r.migrated, false);
  assert.deepEqual([r.profile.grid.items[0].x, r.profile.grid.items[0].y], [4, 7], '位置保留');
});
test('P1: migrateProfile 装备槽齐全（7 槽）且不破坏既有装备', () => {
  const r = G.migrateProfile({ stash: [], equipment: { primary: { uid: 'e1', itemId: 'w_ak74', count: 1 } } });
  for (const s of G.equipSlots()) assert.ok(s in r.profile.equipment, `缺槽位 ${s}`);
  assert.equal(r.profile.equipment.primary.itemId, 'w_ak74', '既有装备保留');
  assert.equal(r.profile.equipment.armor, null);
});
test('P1: migrateProfile 溢出条目回填 stash（绝不丢资产）', () => {
  const profile = { stash: [], grid: { w: 1, h: 1, items: [{ itemId: 'bandage' }, { itemId: 'bolt' }] } };
  const r = G.migrateProfile(profile, { autoGrow: false });
  assert.equal(r.overflow.length, 1);
  assert.ok(r.profile.stash.some(x => x.itemId === 'bolt'), '溢出物品回到 stash，未丢失');
});

// ========== 9. 装备槽框架（D2：只搭框架） ==========
test('P1: makeEquipment 生成全部槽位且初始为空', () => {
  const eq = G.makeEquipment();
  assert.equal(Object.keys(eq).length, G.equipSlots().length);
  for (const s of Object.keys(eq)) assert.equal(eq[s], null);
});
test('P1: canEquip 判定（槽位合法 + 空槽 + 物品允许该槽）', () => {
  const eq = G.makeEquipment();
  assert.equal(G.canEquip(eq, 'w_ak74', 'primary'), true);
  assert.equal(G.canEquip(eq, 'w_ak74', 'head'), false, '步枪不能装头上');
  assert.equal(G.canEquip(eq, 'bandage', 'primary'), false, '绷带没有装备槽');
  assert.equal(G.canEquip(eq, 'w_ak74', 'no_such_slot'), false, '未知槽位');
});
test('P1: equip 成功放入并返回 replaced', () => {
  const r1 = G.equip(G.makeEquipment(), { itemId: 'w_ak74' }, 'primary');
  assert.equal(r1.ok, true);
  assert.equal(r1.equipment.primary.itemId, 'w_ak74');
  assert.equal(r1.replaced, null);
  const r2 = G.equip(r1.equipment, { itemId: 'w_akm' }, 'primary');
  assert.equal(r2.ok, true);
  assert.equal(r2.replaced.itemId, 'w_ak74', '被替换的装备交还调用方');
});
test('P1: equip 槽位不符 / 未知槽位 → 失败', () => {
  assert.equal(G.equip(G.makeEquipment(), { itemId: 'w_ak74' }, 'head').reason, 'slot-not-allowed');
  assert.equal(G.equip(G.makeEquipment(), { itemId: 'w_ak74' }, 'ghost').reason, 'unknown-slot');
});
test('P1: unequip 空槽失败 / 有装备成功', () => {
  const eq = G.equip(G.makeEquipment(), { itemId: 'w_pm' }, 'secondary').equipment;
  assert.equal(G.unequip(eq, 'primary').ok, false);
  const r = G.unequip(eq, 'secondary');
  assert.equal(r.ok, true);
  assert.equal(r.item.itemId, 'w_pm');
  assert.equal(r.equipment.secondary, null);
});
test('P1: equippedItemIds 列出已装备物品', () => {
  let eq = G.makeEquipment();
  eq = G.equip(eq, { itemId: 'w_ak74' }, 'primary').equipment;
  eq = G.equip(eq, { itemId: 'w_pm' }, 'secondary').equipment;
  assert.deepEqual(G.equippedItemIds(eq).sort(), ['w_ak74', 'w_pm']);
});
test('P1: equipFromGrid 仓库 → 槽位（网格移除、uid 保持）', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'w_ak74', x: 0, y: 0, uid: 'a1' }]);
  const r = G.equipFromGrid(g, G.makeEquipment(), 'a1', 'primary');
  assert.equal(r.ok, true);
  assert.equal(r.grid.items.length, 0, '已从仓库移除');
  assert.equal(r.equipment.primary.itemId, 'w_ak74');
  assert.equal(r.equipment.primary.uid, 'a1', 'uid 延续，界面选中态不丢');
});
test('P1: equipFromGrid 槽位被占 / 槽位不符 → 失败（调用方先卸下）', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'w_ak74', x: 0, y: 0, uid: 'a1' }]);
  const occupied = G.equip(G.makeEquipment(), { itemId: 'w_akm' }, 'primary').equipment;
  const r1 = G.equipFromGrid(g, occupied, 'a1', 'primary');
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'slot-occupied');
  assert.equal(r1.grid.items.length, 1, '失败时物品留在仓库');
  assert.equal(G.equipFromGrid(g, G.makeEquipment(), 'a1', 'head').reason, 'slot-not-allowed');
  assert.equal(G.equipFromGrid(g, G.makeEquipment(), 'ghost', 'primary').reason, 'no-such-uid');
});
test('P1: unequipToGrid 槽位 → 仓库自动寻位', () => {
  const eq = G.equip(G.makeEquipment(), { itemId: 'w_ak74' }, 'primary').equipment;
  const r = G.unequipToGrid(G.makeGrid(10, 30), eq, 'primary');
  assert.equal(r.ok, true);
  assert.equal(r.grid.items.length, 1);
  assert.deepEqual(G.footprint(r.grid.items[0].itemId, r.grid.items[0].rot), [5, 2]);
  assert.equal(r.equipment.primary, null);
});
test('P1: unequipToGrid 仓库无空位 → 失败且槽位保持', () => {
  const eq = G.equip(G.makeEquipment(), { itemId: 'w_ak74' }, 'primary').equipment;
  const r = G.unequipToGrid(G.makeGrid(2, 2), eq, 'primary');
  assert.equal(r.ok, false);
  assert.equal(r.equipment.primary.itemId, 'w_ak74', '卸不下就保持装备状态，不凭空消失');
});
test('P1: unequipToGrid 空槽 → 失败', () => {
  assert.equal(G.unequipToGrid(G.makeGrid(10, 30), G.makeEquipment(), 'primary').reason, 'slot-empty');
});

// ========== 10. 不可变性总检 ==========
test('P1: 冻结输入下全部操作不抛错（纯函数保证）', () => {
  const g = frozenGrid(10, 30, [{ itemId: 'w_ak74', x: 0, y: 0, uid: 'a1' }, { itemId: 'bandage', x: 6, y: 0, uid: 'b1' }]);
  const eq = Object.freeze(G.makeEquipment());
  assert.doesNotThrow(() => {
    G.canPlace(g, 'bandage', 0, 0);
    G.findFreeSpot(g, 'bandage');
    G.place(g, G.makeEntry('bolt', { uid: 'c1' }), 8, 8);
    G.addItem(g, { itemId: 'bolt' });
    G.moveItem(g, 'b1', 6, 5);
    G.rotateItem(g, 'a1');
    G.removeAt(g, 'b1');
    G.resize(g, 20, 40);
    G.toLegacyStash(g);
    G.usedCells(g);
    G.cloneGrid(g);
    G.equip(eq, { itemId: 'w_ak74' }, 'primary');
    G.unequip(eq, 'primary');
    G.equipFromGrid(g, eq, 'a1', 'primary');
    G.unequipToGrid(g, eq, 'primary');
  });
});
test('P1: 入口表（冻结接口）必须完整', () => {
  const api = ['gridCfg', 'equipSlots', 'itemSize', 'slotsFor', 'footprint', 'makeUid',
    'makeGrid', 'canPlace', 'findFreeSpot', 'makeEntry', 'place', 'addItem', 'removeAt',
    'moveItem', 'rotateItem', 'resize', 'normalizeGrid', 'fromLegacyStash', 'toLegacyStash',
    'migrateProfile', 'makeEquipment', 'canEquip', 'equip', 'unequip', 'equipFromGrid', 'unequipToGrid'];
  for (const k of api) assert.equal(typeof G[k], 'function', `缺接口 ${k}（P1 接口冻结，P2 只调用不修改）`);
});
test('P1: 浏览器语义可用（挂载 window.EXFIL_GRID）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared', 'grid.js'), 'utf-8');
  assert.ok(src.includes('window.EXFIL_GRID = Grid'), '必须挂载 window.EXFIL_GRID');
  assert.ok(src.includes("require('./config')"), 'Node 端需接入配置层');
  assert.ok(!src.includes('const CFG = {'), '不得把配置值固化（热重载失效）');
});
