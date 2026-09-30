'use strict';
/*
 * EXFIL ZONE · 装备容器测试（任务 B · B1：shared/containers.js + loadout 接入）
 * 覆盖：规格查表 · 未装备=无空间 · 容器构造 · 统计 · 按装备重建 ·
 *       换装退回仓库 · 老档 carry 迁移（幂等/不丢资产）· 与 syncProfile/_finalize 一致性
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const C = require('../shared/containers');
const L = require('../shared/loadout');
const I = require('../shared/items');
const G = require('../shared/grid');

// ---------- 工具 ----------
function fresh() { return L.syncProfile(I.defaultProfile('T')).profile; }
// 往仓库加物品（**必须走对外格式 stash**，否则会被 syncProfile 当孤儿清理）
function give(profile, itemId, count) {
  const p = { ...profile, stash: (profile.stash || []).concat([{ itemId: itemId, count: count || 1 }]) };
  return L.syncProfile(p).profile;
}
// 装备仓库里指定 itemId 的物品
function equip(profile, itemId, slot) {
  const e = profile.grid.items.find(x => x.itemId === itemId);
  if (!e) throw new Error('仓库中无 ' + itemId);
  const r = L.equipUid(profile, e.uid, slot);
  if (!r.ok) throw new Error('装备失败 ' + itemId + ': ' + r.reason);
  return r.profile;
}

// ========== 1. 规格查表（content.json 的 container 字段） ==========
test('B1: specOfItem 读取装备物品的内部规格', () => {
  assert.deepEqual(C.specOfItem('rig_blackrock'), { w: 6, h: 2 });
  assert.deepEqual(C.specOfItem('rig_scav'), { w: 4, h: 1 });
  assert.deepEqual(C.specOfItem('rig_ana'), { w: 8, h: 2 });
  assert.deepEqual(C.specOfItem('bp_pilgrim'), { w: 8, h: 5 });
  assert.deepEqual(C.specOfItem('bp_berkut'), { w: 10, h: 6 });
});
test('B1: 非容器物品返回 null', () => {
  assert.equal(C.specOfItem('bandage'), null);
  assert.equal(C.specOfItem('w_ak74'), null);
  assert.equal(C.specOfItem('armor_paca'), null, '护甲本轮无容器规格');
  assert.equal(C.specOfItem('helm_alt'), null, '头盔本轮无容器规格');
  assert.equal(C.specOfItem(''), null);
  assert.equal(C.specOfItem(null), null);
});
test('B1: 十件装备均在内容表中且槽位正确', () => {
  const want = {
    rig_scav: 'rig', rig_blackrock: 'rig', rig_ana: 'rig',
    bp_scav: 'backpack', bp_pilgrim: 'backpack', bp_berkut: 'backpack',
    armor_paca: 'armor', armor_6b13: 'armor',
    helm_ssh68: 'head', helm_alt: 'head'
  };
  for (const id of Object.keys(want)) {
    assert.deepEqual(G.slotsFor(id), [want[id]], id + ' 槽位应为 ' + want[id]);
  }
});
test('B1: 三个胸挂规格互不相同（穿不同装备→空间不同）', () => {
  const a = C.specOfItem('rig_scav'), b = C.specOfItem('rig_blackrock'), c = C.specOfItem('rig_ana');
  const key = s => s.w + 'x' + s.h;
  assert.notEqual(key(a), key(b));
  assert.notEqual(key(b), key(c));
});
test('B1: 三个背包规格互不相同', () => {
  const a = C.specOfItem('bp_scav'), b = C.specOfItem('bp_pilgrim'), c = C.specOfItem('bp_berkut');
  const key = s => s.w + 'x' + s.h;
  assert.notEqual(key(a), key(b));
  assert.notEqual(key(b), key(c));
});

// ========== 2. 未装备 = 无携带空间（塔科夫语义） ==========
test('B1: 未装备胸挂/背包 → 容器为 null（无携带空间）', () => {
  const p = fresh();
  assert.equal(p.containers.rig, null, '没穿胸挂不应有携带空间');
  assert.equal(p.containers.backpack, null);
});
test('B1: 未装备时 stats 显示 total=0', () => {
  const p = fresh();
  const s = C.containerStats(p);
  assert.equal(s.rig.equipped, false);
  assert.equal(s.rig.total, 0);
  assert.equal(s.backpack.total, 0);
});
test('B1: specOfSlot 对未装备返回 null，不回落 fallback', () => {
  assert.equal(C.specOfSlot({}, 'rig'), null, '未装备必须是 null，不能给默认空间');
  assert.equal(C.specOfSlot({ rig: null }, 'rig'), null);
  assert.equal(C.specOfSlot({ rig: {} }, 'rig'), null, '无 itemId 视为未装备');
});
test('B1: 已装备但规格缺失 → fallback 兜底（避免装备了却完全无空间）', () => {
  const s = C.specOfSlot({ rig: { uid: 'x', itemId: 'bandage' } }, 'rig');
  assert.ok(s && s.w > 0 && s.h > 0, '兜底规格必须有效');
});

// ========== 3. 容器构造与统计 ==========
test('B1: makeContainer 构造空容器', () => {
  const c = C.makeContainer(6, 2);
  assert.equal(c.w, 6); assert.equal(c.h, 2);
  assert.deepEqual(c.items, []);
});
test('B1: makeContainer 对脏尺寸容错（0/负/NaN → 至少 1）', () => {
  assert.equal(C.makeContainer(0, -3).w, 1);
  assert.equal(C.makeContainer(NaN, 'x').h, 1);
});
test('B1: makeContainer 受 maxDim 上限约束', () => {
  const c = C.makeContainer(9999, 9999);
  assert.ok(c.w <= 20 && c.h <= 20, '单边不得超过 maxDim');
});
test('B1: emptyContainers 两槽均为 null', () => {
  const e = C.emptyContainers();
  assert.equal(e.rig, null); assert.equal(e.backpack, null);
});
test('B1: containersOf 对脏档案容错（不抛错）', () => {
  assert.doesNotThrow(() => C.containersOf(null));
  assert.doesNotThrow(() => C.containersOf({}));
  assert.doesNotThrow(() => C.containersOf({ containers: 'garbage' }));
  assert.doesNotThrow(() => C.containersOf({ containers: { rig: 123 } }));
  const r = C.containersOf({ containers: { rig: { w: 0, h: 0, items: [] } } });
  assert.equal(r.rig, null, '形态不正确的容器视为未装备');
});
test('B1: containersOf 返回副本（不共享引用）', () => {
  const p = equip(give(fresh(), 'rig_blackrock', 1), 'rig_blackrock', 'rig');
  const a = C.containersOf(p);
  const b = C.containersOf(p);
  assert.notEqual(a.rig, b.rig, '必须返回新对象，不允许调用方改到档案');
  assert.deepEqual(a.rig, b.rig);
});

// ========== 4. 按装备重建 ==========
test('B1: 装备胸挂 → 容器按规格生成', () => {
  const p = equip(give(fresh(), 'rig_blackrock', 1), 'rig_blackrock', 'rig');
  assert.deepEqual({ w: p.containers.rig.w, h: p.containers.rig.h }, { w: 6, h: 2 });
  assert.deepEqual(p.containers.rig.items, []);
});
test('B1: 装备背包 → 独立容器（与胸挂互不影响）', () => {
  let p = equip(give(fresh(), 'rig_blackrock', 1), 'rig_blackrock', 'rig');
  p = equip(give(p, 'bp_pilgrim', 1), 'bp_pilgrim', 'backpack');
  assert.deepEqual({ w: p.containers.rig.w, h: p.containers.rig.h }, { w: 6, h: 2 });
  assert.deepEqual({ w: p.containers.backpack.w, h: p.containers.backpack.h }, { w: 8, h: 5 });
});
test('B1: 规格未变时重建幂等（changed=false）', () => {
  const p = equip(give(fresh(), 'rig_blackrock', 1), 'rig_blackrock', 'rig');
  const r = C.rebuildForSlot(p, 'rig');
  assert.equal(r.changed, false, '规格未变不得标记变更');
  assert.deepEqual(r.overflow, []);
});
test('B1: 换装后规格随新装备变化', () => {
  let p = equip(give(fresh(), 'rig_scav', 1), 'rig_scav', 'rig');
  assert.deepEqual({ w: p.containers.rig.w, h: p.containers.rig.h }, { w: 4, h: 1 });
  // 换上更大的胸挂
  p = equip(give(p, 'rig_ana', 1), 'rig_ana', 'rig');
  assert.deepEqual({ w: p.containers.rig.w, h: p.containers.rig.h }, { w: 8, h: 2 });
});
test('B1: 卸下装备 → 容器消失（null）', () => {
  let p = equip(give(fresh(), 'rig_blackrock', 1), 'rig_blackrock', 'rig');
  p = L.unequipSlot(p, 'rig').profile;
  assert.equal(p.containers.rig, null);
});
test('B1: 卸下的装备回到仓库（不丢）', () => {
  let p = equip(give(fresh(), 'rig_blackrock', 1), 'rig_blackrock', 'rig');
  p = L.unequipSlot(p, 'rig').profile;
  const back = p.stash.filter(s => s.itemId === 'rig_blackrock');
  assert.equal(back.length, 1, '卸下的胸挂必须回到仓库');
});
test('B1: 非容器槽位的重建为无操作', () => {
  const p = fresh();
  const r = C.rebuildForSlot(p, 'head');
  assert.deepEqual(r.overflow, []);
  assert.equal(r.changed, false);
});
test('B1: rebuildAll 同时处理两个容器槽', () => {
  let p = equip(give(fresh(), 'rig_ana', 1), 'rig_ana', 'rig');
  p = equip(give(p, 'bp_berkut', 1), 'bp_berkut', 'backpack');
  const r = C.rebuildAll(p);
  assert.equal(r.containers.rig.w, 8);
  assert.equal(r.containers.backpack.w, 10);
});

// ========== 5. 换小容器 → 物品退回仓库（P0 风险 R3） ==========
test('B1★: 换小容器时放不下的物品退回仓库（绝不销毁）', () => {
  // 用大胸挂装东西，再换小胸挂
  let p = equip(give(fresh(), 'rig_ana', 1), 'rig_ana', 'rig');   // 8x2
  // 手动往容器里放东西（模拟 UI 拖入）
  const big = C.makeContainer(8, 2);
  let g = big;
  for (let i = 0; i < 8; i++) { const r = G.addItem(g, { itemId: 'junk', count: 1 }); if (r.ok) g = r.grid; }
  p = { ...p, containers: { ...p.containers, rig: g } };
  const before = G.countOf(g, 'junk');
  assert.ok(before > 0, '前置：容器内应有物品');

  // 换小胸挂（4x1 = 4 格 < 8 件）
  p = equip(give(p, 'rig_scav', 1), 'rig_scav', 'rig');
  const inContainer = p.containers.rig.items.reduce((s, e) => s + (e.count || 1), 0);
  const inStash = p.stash.filter(s => s.itemId === 'junk').reduce((s, e) => s + (e.count || 1), 0);
  assert.equal(inContainer + inStash, before, '总量守恒：容器 + 仓库必须等于原数量（不丢）');
});
test('B1★: 卸下容器装备时内部物品全部退回仓库', () => {
  let p = equip(give(fresh(), 'bp_pilgrim', 1), 'bp_pilgrim', 'backpack');
  const g = C.makeContainer(8, 5);
  let cur = g;
  for (let i = 0; i < 5; i++) { const r = G.addItem(cur, { itemId: 'bolt', count: 1 }); if (r.ok) cur = r.grid; }
  p = { ...p, containers: { ...p.containers, backpack: cur } };
  const before = G.countOf(cur, 'bolt');

  p = L.unequipSlot(p, 'backpack').profile;
  assert.equal(p.containers.backpack, null);
  const inStash = p.stash.filter(s => s.itemId === 'bolt').reduce((s, e) => s + (e.count || 1), 0);
  assert.equal(inStash, before, '卸下装备后容器内物品必须回到仓库');
});

// ========== 6. 老档 carry 迁移（P0 风险 R1） ==========
test('B1★: 老档 carry 弹药迁入胸挂', () => {
  let p = equip(give(fresh(), 'rig_ana', 1), 'rig_ana', 'rig');   // 8x2
  p = { ...p, carry: { ammo: { '545x39': 20 }, items: [] } };
  const r = C.migrateCarry(p);
  const cnt = r.containers.rig.items.filter(e => e.itemId === '545x39').reduce((s, e) => s + (e.count || 1), 0);
  assert.equal(cnt, 20, '弹药应完整迁入胸挂');
  assert.equal(r.leftover, null, '全部迁完不应有残留');
});
test('B1★: 老档 carry 物资迁入背包', () => {
  let p = equip(give(fresh(), 'bp_pilgrim', 1), 'bp_pilgrim', 'backpack');
  p = { ...p, carry: { ammo: {}, items: [{ itemId: 'bandage', count: 3 }] } };
  const r = C.migrateCarry(p);
  const cnt = r.containers.backpack.items.filter(e => e.itemId === 'bandage').reduce((s, e) => s + (e.count || 1), 0);
  assert.equal(cnt, 3);
});
test('B1★: carry 迁移幂等（重复调用不翻倍）', () => {
  let p = equip(give(fresh(), 'rig_ana', 1), 'rig_ana', 'rig');
  p = { ...p, carry: { ammo: { '545x39': 30 }, items: [] } };
  const r1 = C.migrateCarry(p);
  const n1 = r1.containers.rig.items.reduce((s, e) => s + (e.count || 1), 0);
  // 第二次：用迁移后的容器再迁一次（模拟 syncProfile 多轮调用 / 联机往返）
  const r2 = C.migrateCarry({ ...p, containers: r1.containers });
  const n2 = r2.containers.rig.items.reduce((s, e) => s + (e.count || 1), 0);
  assert.equal(n2, n1, '幂等：重复迁移总量不得翻倍');
});
test('B1★: carry 放不下时残留保留在原字段（绝不丢资产）', () => {
  // 未装备任何容器 → 无空间 → 全部残留
  let p = fresh();
  p = { ...p, carry: { ammo: { '545x39': 50 }, items: [{ itemId: 'bandage', count: 5 }] } };
  const r = C.migrateCarry(p);
  assert.ok(r.leftover, '无容器时必须有残留');
  assert.equal(r.leftover.ammo['545x39'], 50, '残留量必须完整');
  assert.equal(r.leftover.items[0].count, 5);
});
test('B1★: carry 部分放得下 → 已迁入 + 残留量守恒', () => {
  let p = equip(give(fresh(), 'rig_scav', 1), 'rig_scav', 'rig');   // 4x1 = 4 格
  p = { ...p, carry: { ammo: {}, items: [{ itemId: 'junk', count: 10 }] } };
  const r = C.migrateCarry(p);
  const inContainer = r.containers.rig.items.reduce((s, e) => s + (e.count || 1), 0);
  const left = r.leftover ? r.leftover.items.reduce((s, e) => s + (e.count || 1), 0) : 0;
  assert.equal(inContainer + left, 10, '守恒：迁入 + 残留 = 原数量');
  assert.ok(inContainer > 0, '至少应迁入一部分');
});
test('B1: 无 carry 字段时迁移为无操作', () => {
  const p = fresh();
  const r = C.migrateCarry(p);
  assert.equal(r.moved, false);
  assert.equal(r.leftover, null);
});
test('B1: carry 为脏数据时不抛错', () => {
  assert.doesNotThrow(() => C.migrateCarry({ carry: 'garbage' }));
  assert.doesNotThrow(() => C.migrateCarry({ carry: { ammo: { x: -5 }, items: [{}, null] } }));
});

// ========== 7. syncProfile 接入（P0 风险 R2：孤儿清理误删） ==========
test('B1★: syncProfile 后容器存在（未装备则为 null）', () => {
  const p = fresh();
  assert.ok('containers' in p, 'syncProfile 必须产出 containers 字段');
  assert.equal(p.containers.rig, null);
});
test('B1★: 老档 carry 经 syncProfile 自动迁移', () => {
  let p = equip(give(fresh(), 'rig_ana', 1), 'rig_ana', 'rig');
  p = { ...p, carry: { ammo: { '545x39': 20 }, items: [] } };
  p = L.syncProfile(p).profile;
  const cnt = p.containers.rig.items.reduce((s, e) => s + (e.count || 1), 0);
  assert.equal(cnt, 20, 'syncProfile 应完成迁移');
  assert.equal(p.carry, undefined, '全部迁完后 carry 字段应清除');
});
test('B1★: 迁移发生在 orphan 清理之后（迁入条目不被打回）', () => {
  let p = equip(give(fresh(), 'bp_pilgrim', 1), 'bp_pilgrim', 'backpack');
  p = { ...p, carry: { ammo: {}, items: [{ itemId: 'junk', count: 6 }] } };
  const r = L.syncProfile(p);
  const cnt = r.profile.containers.backpack.items.reduce((s, e) => s + (e.count || 1), 0);
  assert.equal(cnt, 6, '迁入的条目必须留在容器（E045-a 教训：放前面会被当孤儿删掉）');
  assert.equal(r.removed.length, 0, '不应产生误删记录');
});
test('B1★: 反复 syncProfile 幂等（联机档案多轮往返不翻倍）', () => {
  let p = equip(give(fresh(), 'rig_ana', 1), 'rig_ana', 'rig');
  p = { ...p, carry: { ammo: { '9x18': 12 }, items: [] } };
  let cur = L.syncProfile(p).profile;
  const n1 = cur.containers.rig.items.reduce((s, e) => s + (e.count || 1), 0);
  for (let i = 0; i < 4; i++) cur = L.syncProfile(cur).profile;
  const n2 = cur.containers.rig.items.reduce((s, e) => s + (e.count || 1), 0);
  assert.equal(n2, n1, '多轮 syncProfile 后总量必须稳定');
});
test('B1★: 装备经 equipUid 后容器立即可用（_finalize 路径）', () => {
  const p = equip(give(fresh(), 'rig_blackrock', 1), 'rig_blackrock', 'rig');
  assert.ok(p.containers.rig, '_finalize 路径也必须重建容器（否则「装上了却没空间」）');
  assert.deepEqual({ w: p.containers.rig.w, h: p.containers.rig.h }, { w: 6, h: 2 });
});
test('B1★: 仓库物品不被容器逻辑误删', () => {
  let p = fresh();
  p = give(p, 'junk', 5);
  const before = p.stash.filter(s => s.itemId === 'junk').reduce((s, e) => s + (e.count || 1), 0);
  p = equip(give(p, 'rig_ana', 1), 'rig_ana', 'rig');
  const after = p.stash.filter(s => s.itemId === 'junk').reduce((s, e) => s + (e.count || 1), 0);
  assert.equal(after, before, '容器逻辑不得影响仓库既有物品');
});

// ========== 8. 重量统计 ==========
test('B1: containerWeight 统计容器内总重', () => {
  let p = equip(give(fresh(), 'bp_pilgrim', 1), 'bp_pilgrim', 'backpack');
  assert.equal(C.containerWeight(p), 0, '空容器重量为 0');
  const g = C.makeContainer(8, 5);
  const r = G.addItem(g, { itemId: 'toolbox', count: 1 });   // weight 1.5
  p = { ...p, containers: { ...p.containers, backpack: r.grid } };
  assert.equal(C.containerWeight(p), 1.5);
});
test('B1: containerWeight 对脏数据容错', () => {
  assert.doesNotThrow(() => C.containerWeight(null));
  assert.equal(C.containerWeight({}), 0);
});

// ========== 9. 接口与浏览器语义 ==========
test('B1: Containers 导出接口完整', () => {
  const api = ['isContainerSlot', 'specOfItem', 'specOfSlot', 'makeContainer', 'cloneContainer',
    'emptyContainers', 'containersOf', 'containerOf', 'containerStats', 'containerWeight',
    'rebuildForSlot', 'rebuildAll', 'migrateCarry'];
  for (const k of api) assert.equal(typeof C[k], 'function', '缺接口 ' + k);
});
test('B1: 浏览器语义可用（挂载 window.EXFIL_CONTAINERS）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared', 'containers.js'), 'utf-8');
  assert.ok(src.includes('window.EXFIL_CONTAINERS = Containers'), '必须挂载 window.EXFIL_CONTAINERS');
  assert.ok(src.includes("require('./grid')"), 'Node 端需复用 grid 库');
  assert.ok(src.includes("require('./config')"), 'Node 端需接入配置层');
  assert.ok(!src.includes('const CFG = {'), '不得把配置值固化（热重载失效）');
});
test('B1: isContainerSlot 只认 rig/backpack', () => {
  assert.equal(C.isContainerSlot('rig'), true);
  assert.equal(C.isContainerSlot('backpack'), true);
  assert.equal(C.isContainerSlot('head'), false);
  assert.equal(C.isContainerSlot('armor'), false);
  assert.equal(C.isContainerSlot('primary'), false);
  assert.equal(C.isContainerSlot('melee'), false);
});
test('B1: loadout 暴露容器便捷出口', () => {
  assert.equal(typeof L.containersOf, 'function');
  assert.equal(typeof L.containerStats, 'function');
  assert.equal(typeof L.containerOf, 'function');
});
test('B1: 纯函数性——不修改入参档案', () => {
  const p = equip(give(fresh(), 'rig_ana', 1), 'rig_ana', 'rig');
  const snapshot = JSON.stringify(p);
  C.rebuildAll(p);
  C.containersOf(p);
  C.containerStats(p);
  C.migrateCarry(p);
  assert.equal(JSON.stringify(p), snapshot, '所有 containers 函数不得修改入参');
});
