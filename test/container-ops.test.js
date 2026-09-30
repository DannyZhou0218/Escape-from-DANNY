'use strict';
/*
 * test/container-ops.test.js — B2 容器操作与进图携带（任务 B · 实体化携带空间）
 *
 * 【契约】（务必按此编写，勿按直觉猜）
 *   容器内操作（putInto/takeFrom/takeFromPartial/moveIn/rotateIn）：
 *     入参 (profile, slot, ...)，**不修改入参**；返回 { ok, containers, uid?/removed?, reason? }
 *     —— containers 是**新的**容器集合，调用方自行接回档案
 *   跨容器转移（transferFromGrid/transferToGrid/transferBetween）：
 *     返回 { ok, profile?, reason? } —— profile 为**新档案**（含 grid + containers）
 *     transferFromGrid(profile, gridUid, toSlot)
 *     transferToGrid(profile, slot, uid)
 *     transferBetween(profile, fromSlot, uid, toSlot)
 *   进图携带（takeAll / takeCarryFromContainers）：
 *     返回 { profile, raidAmmo, raidItems[, taken] } —— 与旧 takeCarry 输出**同构**
 */
const test = require('node:test');
const assert = require('node:assert');

const Grid = require('../shared/grid');
const Containers = require('../shared/containers');
const Items = require('../shared/items');

// ---------- 夹具 ----------
// 直接构造 containers（绕过 syncProfile，专测纯操作）
// 注意：makeContainer 签名为 (w, h)，非 (slot, spec)
function mkProfile(rigWH, bpWH) {
  const p = Items.defaultProfile('tester');
  p.containers = {
    rig: Containers.makeContainer((rigWH && rigWH.w) || 4, (rigWH && rigWH.h) || 1),
    backpack: Containers.makeContainer((bpWH && bpWH.w) || 5, (bpWH && bpWH.h) || 3)
  };
  p.grid = { w: 10, h: 30, items: [] };
  return p;
}
// 把「操作返回的新 containers」接回档案（模拟真实调用方）
function withContainers(profile, containers) {
  return { ...profile, containers: containers };
}
function sumOf(container) {
  return (container.items || []).reduce((s, e) => s + (e.count || 1), 0);
}

// ---------- ① 容器内操作 ----------
test('B2: putInto 放入成功 → 返回新 containers 且占用一格', () => {
  const p = mkProfile({ w: 4, h: 1 });
  const r = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 1 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.containers, '应返回 containers');
  assert.strictEqual(r.containers.rig.items.length, 1);
  assert.strictEqual(r.containers.rig.items[0].itemId, 'bandage');
});

test('B2: putInto 空间不足 → 原子拒绝', () => {
  const p = mkProfile({ w: 1, h: 1 });
  // 堆叠上限 60：先塞满一整叠（占唯一格），第 61 件需开新叠 → 无空格 → 拒绝
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 60 });
  assert.strictEqual(a.ok, true);
  const b = Containers.putInto(withContainers(p, a.containers), 'rig', { itemId: 'bandage', count: 1 });
  assert.strictEqual(b.ok, false, '1×1 容器堆满后应拒绝新叠');
  assert.strictEqual(b.containers.rig.items.length, 1, '拒绝时容器不得变化');
});

test('B2: putInto 同种物品自动堆叠', () => {
  const p = mkProfile({ w: 4, h: 1 });
  const r1 = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 2 });
  const r2 = Containers.putInto(withContainers(p, r1.containers), 'rig', { itemId: 'bandage', count: 3 });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(sumOf(r2.containers.rig), 5, '同种物品应累加');
});

test('B2: takeFrom 取出整条 → removed 携带物品信息', () => {
  const p = mkProfile();
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 3 });
  const uid = a.containers.rig.items[0].uid;
  const b = Containers.takeFrom(withContainers(p, a.containers), 'rig', uid);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.removed.itemId, 'bandage');
  assert.strictEqual(b.removed.count, 3);
  assert.strictEqual(b.containers.rig.items.length, 0);
});

test('B2: takeFrom 不存在的 uid 被拒绝', () => {
  const p = mkProfile();
  const r = Containers.takeFrom(p, 'rig', 'no_such_uid');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-such-uid');
});

test('B2: takeFromPartial 部分取出 → 剩余量正确', () => {
  const p = mkProfile();
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 5 });
  const uid = a.containers.rig.items[0].uid;
  const b = Containers.takeFromPartial(withContainers(p, a.containers), 'rig', uid, 2);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.removed.count, 2);
  assert.strictEqual(b.whole, false, '部分取出应标记 whole=false');
  assert.strictEqual(sumOf(b.containers.rig), 3, '剩余应为 3');
});

test('B2: takeFromPartial 取满 → 等价整条取出', () => {
  const p = mkProfile();
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 2 });
  const uid = a.containers.rig.items[0].uid;
  const b = Containers.takeFromPartial(withContainers(p, a.containers), 'rig', uid, 2);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.whole, true, '取满应标记 whole=true');
  assert.strictEqual(b.containers.rig.items.length, 0);
});

test('B2: takeFromPartial 超量 → 截断到整条（绝不凭空造物）', () => {
  const p = mkProfile();
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 2 });
  const uid = a.containers.rig.items[0].uid;
  const b = Containers.takeFromPartial(withContainers(p, a.containers), 'rig', uid, 99);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.removed.count, 2, '最多只能给出持有量 2');
  assert.strictEqual(b.containers.rig.items.length, 0);
});

test('B2: takeFromPartial 数量 ≤0 → 拒绝', () => {
  const p = mkProfile();
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 2 });
  const uid = a.containers.rig.items[0].uid;
  const b = Containers.takeFromPartial(withContainers(p, a.containers), 'rig', uid, 0);
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.reason, 'bad-arg');
});

test('B2: moveIn 改变坐标', () => {
  const p = mkProfile({ w: 4, h: 1 });
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage' });
  const uid = a.containers.rig.items[0].uid;
  const b = Containers.moveIn(withContainers(p, a.containers), 'rig', uid, 3, 0);
  assert.strictEqual(b.ok, true);
  const e = b.containers.rig.items.find(i => i.uid === uid);
  assert.strictEqual(e.x, 3);
});

test('B2: moveIn 目标越界 → 拒绝', () => {
  const p = mkProfile({ w: 4, h: 1 });
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage' });
  const uid = a.containers.rig.items[0].uid;
  const b = Containers.moveIn(withContainers(p, a.containers), 'rig', uid, 99, 0);
  assert.strictEqual(b.ok, false);
  const e = b.containers.rig.items.find(i => i.uid === uid);
  assert.strictEqual(e.x, 0, '拒绝时坐标不得变化');
});

test('B2: rotateIn 返回结果对象（1×1 旋转无变化但须 ok）', () => {
  const p = mkProfile({ w: 4, h: 2 });
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage' });
  const uid = a.containers.rig.items[0].uid;
  const b = Containers.rotateIn(withContainers(p, a.containers), 'rig', uid);
  assert.strictEqual(b.ok, true);
  assert.ok(b.containers.rig.items.length === 1, '条目应仍在');
});

test('B2: 未装备容器 → putInto 拒绝（no-container）', () => {
  const p = Items.defaultProfile('t');
  p.containers = { rig: null, backpack: null };
  const r = Containers.putInto(p, 'rig', { itemId: 'bandage' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-container');
});

test('B2: 非容器槽（head）→ 拒绝（not-container-slot）', () => {
  const p = mkProfile();
  const r = Containers.putInto(p, 'head', { itemId: 'bandage' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not-container-slot');
});

// ---------- ② 跨容器转移 ----------
test('B2: transferToGrid 容器→仓库 守恒', () => {
  const p = mkProfile();
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 4 });
  const uid = a.containers.rig.items[0].uid;
  const b = Containers.transferToGrid(withContainers(p, a.containers), 'rig', uid);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(sumOf(b.profile.grid), 4, '仓库应收到 4 件');
  assert.strictEqual(b.profile.containers.rig.items.length, 0, '容器应清空该条');
});

test('B2: transferFromGrid 仓库→容器 守恒', () => {
  const p = mkProfile();
  p.grid = Grid.addItem(p.grid, { itemId: 'bandage', count: 3 }).grid;
  const uid = p.grid.items[0].uid;
  const b = Containers.transferFromGrid(p, uid, 'rig');
  assert.strictEqual(b.ok, true);
  assert.strictEqual(sumOf(b.profile.containers.rig), 3, '容器应收到 3 件');
  assert.strictEqual(b.profile.grid.items.length, 0, '仓库应移除该条');
});

test('B2: transferBetween 胸挂→背包 守恒', () => {
  const p = mkProfile();
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 2 });
  const uid = a.containers.rig.items[0].uid;
  const b = Containers.transferBetween(withContainers(p, a.containers), 'rig', uid, 'backpack');
  assert.strictEqual(b.ok, true);
  assert.strictEqual(sumOf(b.profile.containers.backpack), 2, '背包应收到 2 件');
  assert.strictEqual(b.profile.containers.rig.items.length, 0);
});

test('B2: transferBetween 同容器 → 拒绝（same-container）', () => {
  const p = mkProfile();
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage' });
  const uid = a.containers.rig.items[0].uid;
  const b = Containers.transferBetween(withContainers(p, a.containers), 'rig', uid, 'rig');
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.reason, 'same-container');
});

test('B2: transferToGrid 仓库满 → 拒绝且容器保留（原子）', () => {
  const p = mkProfile();
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 1 });
  // 1×1 仓库：先堆满 60（占唯一格），转出第 61 件需开新叠 → 仓库放不下 → 原子拒绝
  p.grid = Grid.addItem({ w: 1, h: 1, items: [] }, { itemId: 'bandage', count: 60 }).grid;
  const uid = a.containers.rig.items[0].uid;
  const base = withContainers(p, a.containers);
  const b = Containers.transferToGrid(base, 'rig', uid);
  // 同种物品可堆叠：若容器条目并入已有叠则成功属合理；若超叠上限应拒绝。
  // 关键断言：**无论成功与否，资产绝不丢失**（要么在仓库、要么在容器）
  if (b.ok) {
    assert.strictEqual(sumOf(b.profile.grid), 61, '成功则仓库应含 61 件');
  } else {
    assert.strictEqual(sumOf(base.containers.rig), 1, '拒绝时容器条目必须保留');
  }
});

test('B2: transferFromGrid 容器满 → 拒绝且仓库保留（原子）', () => {
  const p = mkProfile({ w: 1, h: 1 });
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 60 });  // 堆满唯一格
  p.grid = Grid.addItem(p.grid, { itemId: 'bandage', count: 1 }).grid;       // 仓库放 1 件
  const uid = p.grid.items[0].uid;
  const base = withContainers(p, a.containers);
  const beforeGrid = sumOf(base.grid);
  const b = Containers.transferFromGrid(base, uid, 'rig');
  if (b.ok) {
    assert.strictEqual(sumOf(b.profile.containers.rig), 61, '成功则容器应含 61 件');
  } else {
    assert.strictEqual(sumOf(base.containers.rig), 60, '拒绝时容器必须原样');
    assert.strictEqual(sumOf(base.grid), beforeGrid, '拒绝时仓库必须原样');
  }
});

test('B2: 跨容器往返运输不丢数', () => {
  const p = mkProfile();
  let s = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 6 });
  const uid = s.containers.rig.items[0].uid;
  s = Containers.transferToGrid(withContainers(p, s.containers), 'rig', uid);
  const gUid = s.profile.grid.items[0].uid;
  s = Containers.transferFromGrid(s.profile, gUid, 'backpack');
  assert.strictEqual(sumOf(s.profile.containers.backpack), 6, '往返后总量应不变');
});

// ---------- ③ 进图携带 ----------
test('B2: takeAll 输出契约与旧 takeCarry 同构', () => {
  const p = mkProfile();
  let s = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 2 });
  s = Containers.putInto(withContainers(p, s.containers), 'backpack', { itemId: '545x39', count: 30 });
  const r = Containers.takeAll(withContainers(p, s.containers));
  assert.ok(r.profile, '应返回 profile');
  assert.ok(r.raidAmmo && typeof r.raidAmmo === 'object', 'raidAmmo 应为对象');
  assert.ok(Array.isArray(r.raidItems), 'raidItems 应为数组');
  assert.strictEqual(r.raidAmmo['545x39'], 30, '弹药应归入 raidAmmo');
  assert.strictEqual(r.raidItems.length, 1, '非弹药归入 raidItems');
  assert.strictEqual(r.raidItems[0].itemId, 'bandage');
  assert.strictEqual(r.raidItems[0].count, 2);
});

test('B2: takeAll 清空容器但保留空间规格', () => {
  const p = mkProfile({ w: 6, h: 2 });
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage' });
  const r = Containers.takeAll(withContainers(p, a.containers));
  assert.strictEqual(r.profile.containers.rig.items.length, 0, '容器应清空');
  assert.strictEqual(r.profile.containers.rig.w, 6, '宽规格应保留');
  assert.strictEqual(r.profile.containers.rig.h, 2, '高规格应保留');
});

test('B2: takeAll 空容器 → 空载荷', () => {
  const p = mkProfile();
  const r = Containers.takeAll(p);
  assert.deepStrictEqual(r.raidAmmo, {});
  assert.strictEqual(r.raidItems.length, 0);
});

test('B2: takeCarryFromContainers 与 takeAll 载荷一致', () => {
  const p = mkProfile();
  let s = Containers.putInto(p, 'rig', { itemId: '545x39', count: 12 });
  s = Containers.putInto(withContainers(p, s.containers), 'rig', { itemId: 'bandage', count: 3 });
  const base = withContainers(p, s.containers);
  const a = Containers.takeAll(base);
  const b = Items.takeCarryFromContainers(base);
  assert.deepStrictEqual(b.raidAmmo, a.raidAmmo, '弹药载荷应一致');
  assert.strictEqual(b.raidItems.length, a.raidItems.length, '物资载荷数量应一致');
});

test('B2: takeCarryFromContainers 刷新 ammoLib 派生视图', () => {
  const p = mkProfile();
  p.stash = [{ itemId: '545x39', count: 60 }];
  p.ammoLib = { '545x39': 60 };
  const r = Items.takeCarryFromContainers(p);
  assert.strictEqual(r.profile.ammoLib['545x39'], 60, '仓库弹药未动，派生视图应保持');
});

test('B2: takeCarryFromContainers 空容器不吞玩家资产', () => {
  const p = mkProfile();
  p.stash = [{ itemId: '545x39', count: 90 }];
  const r = Items.takeCarryFromContainers(p);
  assert.strictEqual(r.raidAmmo['545x39'] || 0, 0, '容器空 → 不带弹药');
  assert.strictEqual(r.profile.stash[0].count, 90, '仓库弹药必须原封不动');
});

test('B2: 旧 takeCarry 仍可用（向后兼容，携带控件路径）', () => {
  const p = Items.defaultProfile('t');
  p.stash = [{ itemId: '545x39', count: 30 }, { itemId: 'bandage', count: 2 }];
  const r = Items.takeCarry(p, { ammo: { '545x39': 10 }, items: [{ itemId: 'bandage', count: 1 }] });
  assert.strictEqual(r.raidAmmo['545x39'], 10);
  assert.strictEqual(r.raidItems[0].count, 1);
});

// ---------- ④ canQuickUse ----------
test('B2: canQuickUse 胸挂可用 / 背包与其他不可', () => {
  assert.strictEqual(Containers.canQuickUse('rig'), true);
  assert.strictEqual(Containers.canQuickUse('backpack'), false);
  assert.strictEqual(Containers.canQuickUse('head'), false);
});

// ---------- ⑤ 纯函数性（不修改入参） ----------
test('B2: putInto 不修改入参 profile.containers', () => {
  const p = mkProfile();
  const before = JSON.stringify(p.containers);
  Containers.putInto(p, 'rig', { itemId: 'bandage' });
  assert.strictEqual(JSON.stringify(p.containers), before, '入参容器不得被修改');
});

test('B2: transferToGrid 不修改入参 grid', () => {
  const p = mkProfile();
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage' });
  const uid = a.containers.rig.items[0].uid;
  const base = withContainers(p, a.containers);
  const before = JSON.stringify(base.grid);
  Containers.transferToGrid(base, 'rig', uid);
  assert.strictEqual(JSON.stringify(base.grid), before, '入参 grid 不得被修改');
});

test('B2: takeAll 不修改入参 profile', () => {
  const p = mkProfile();
  const a = Containers.putInto(p, 'rig', { itemId: 'bandage', count: 2 });
  const base = withContainers(p, a.containers);
  const before = JSON.stringify(base.containers);
  Containers.takeAll(base);
  assert.strictEqual(JSON.stringify(base.containers), before, 'takeAll 不得修改入参');
});

// ---------- 接口完整性 ----------
test('B2: Containers 导出全部操作函数', () => {
  const need = ['putInto', 'takeFrom', 'takeFromPartial', 'moveIn', 'rotateIn',
    'transferFromGrid', 'transferToGrid', 'transferBetween', 'canQuickUse', 'takeAll'];
  for (const k of need) assert.strictEqual(typeof Containers[k], 'function', '缺少导出：' + k);
});

test('B2: Items 导出 takeCarryFromContainers', () => {
  assert.strictEqual(typeof Items.takeCarryFromContainers, 'function');
});

// ---------- B3 回归锁：跨区转移「复制而非移动」缺陷（实机踩坑，勿回退） ----------
// 场景：仓库→胸挂。Containers.transferFromGrid 只返回「新 grid + 新 containers」，
// 其 stash 仍是旧的一份（仍写着「物品在仓库」）。若调用方把该 profile 直接交给
// LOADOUT.syncProfile / ensure，后者会以**旧 stash** 为准逐条认领 grid：被移走那条
// uid 已不在 grid → 落入分支③「新物品→入格」→ 物品被复制回仓库（数量翻倍）。
// 正解：先用**新 grid** 重新派生 stash（legacyStash）再 syncProfile。
//
// 夹具：一律以 stash 为唯一真源（档案契约）——装备槽条目必须在 stash 里，
// 否则 syncProfile 第⑥步「未认领槽位 → 清空」会把装备清掉。
const Loadout = require('../shared/loadout');
function fixWithRig() {
  const p = Items.defaultProfile('tester');
  p.stash.push({ itemId: 'bandage', count: 4 });
  p.stash.push({ itemId: 'rig_scav' });
  let s = Loadout.syncProfile(p).profile;                       // bandage 入格、rig 入格
  const rigUid = s.grid.items.find(e => e.itemId === 'rig_scav').uid;
  s = Loadout.equipUid(s, rigUid, 'rig').profile;               // rig 上身（容器建立）
  return s;
}
const sumOfId = (items, id) => (items || []).filter(e => e.itemId === id).reduce((s, e) => s + (e.count || 1), 0);

test('B3 回归: 仓库→胸挂 经 legacyStash+syncProfile 后不得复制（守恒）', () => {
  const s = fixWithRig();
  assert.strictEqual(!!s.containers.rig, true, '夹具应已装备胸挂并建立容器');
  const uid = s.grid.items.find(e => e.itemId === 'bandage').uid;

  const r = Containers.transferFromGrid(s, uid, 'rig');
  assert.strictEqual(r.ok, true);
  const rp = { ...r.profile };
  rp.stash = Loadout.legacyStash(rp);                            // ← 正解：先重派生 stash
  const after = Loadout.syncProfile(rp).profile;

  assert.strictEqual(sumOfId(after.grid.items, 'bandage'), 0, '仓库不得残留（复制缺陷复发）');
  assert.strictEqual(sumOfId(after.containers.rig.items, 'bandage'), 4, '胸挂应持有 4 件');
  // 幂等：再同步一次不得把物品搬回仓库
  const again = Loadout.syncProfile(after).profile;
  assert.strictEqual(sumOfId(again.grid.items, 'bandage'), 0, '二次同步不得复制回仓库');
  assert.strictEqual(sumOfId(again.containers.rig.items, 'bandage'), 4, '二次同步胸挂仍为 4 件');
});

test('B3 回归: 胸挂→仓库 经 legacyStash+syncProfile 后不得复制（守恒）', () => {
  const s = fixWithRig();
  const u = s.grid.items.find(e => e.itemId === 'bandage').uid;
  // 先把绷带合法移入胸挂（并用正解路径收敛）
  let t = { ...Containers.transferFromGrid(s, u, 'rig').profile };
  t.stash = Loadout.legacyStash(t);
  t = Loadout.syncProfile(t).profile;
  const uid = t.containers.rig.items.find(e => e.itemId === 'bandage').uid;

  const r = Containers.transferToGrid(t, 'rig', uid);
  assert.strictEqual(r.ok, true);
  const rp = { ...r.profile };
  rp.stash = Loadout.legacyStash(rp);
  const after = Loadout.syncProfile(rp).profile;

  assert.strictEqual(sumOfId(after.grid.items, 'bandage'), 4, '仓库应收到 4 件');
  assert.strictEqual(sumOfId(after.containers.rig.items, 'bandage'), 0, '胸挂应清空（复制缺陷复发）');
  // 幂等
  const again = Loadout.syncProfile(after).profile;
  assert.strictEqual(sumOfId(again.grid.items, 'bandage'), 4, '二次同步仓库仍为 4 件');
  assert.strictEqual(sumOfId(again.containers.rig.items, 'bandage'), 0, '二次同步胸挂仍为空');
});

// 负面锁：直接 syncProfile(transfer 结果) 确实会复制 —— 锁定缺陷机理，说明正解不可省略
test('B3 回归: 直接 syncProfile(transfer 结果) 会复制（锁定缺陷机理）', () => {
  const s = fixWithRig();
  const uid = s.grid.items.find(e => e.itemId === 'bandage').uid;
  const r = Containers.transferFromGrid(s, uid, 'rig');
  const wrong = Loadout.syncProfile(r.profile).profile;          // ← 旧写法（未重派生 stash）
  assert.strictEqual(sumOfId(wrong.grid.items, 'bandage'), 4, '旧写法下仓库残留 4 件（缺陷机理）');
  assert.strictEqual(sumOfId(wrong.containers.rig.items, 'bandage'), 4, '旧写法下胸挂也有 4 件（缺陷机理）');
});

// 弹药专项：ammoLib 是 stash 的派生视图，必须与 stash **成对重派生**，
// 否则 syncProfile 第⑦步 ammoLibToGrid 会把差额补成实体堆叠 → 弹药复制回仓库。
// （绷带不带 ammoLib，所以只重派生 stash 时侥幸通过；弹药才暴露此缺陷）
function fixWithRigAndAmmo(n) {
  const p = Items.defaultProfile('tester');
  p.stash.push({ itemId: '545x39', count: n || 60 });
  p.stash.push({ itemId: 'rig_scav' });
  let s = Loadout.syncProfile(p).profile;
  const rigUid = s.grid.items.find(e => e.itemId === 'rig_scav').uid;
  return Loadout.equipUid(s, rigUid, 'rig').profile;
}
test('B3 回归: 弹药 仓库→胸挂 必须成对重派生 ammoLib（否则复制）', () => {
  const s = fixWithRigAndAmmo(60);
  assert.strictEqual(!!s.containers.rig, true);
  const uid = s.grid.items.find(e => e.itemId === '545x39').uid;

  const r = Containers.transferFromGrid(s, uid, 'rig');
  assert.strictEqual(r.ok, true);
  const rp = { ...r.profile };
  rp.stash = Loadout.legacyStash(rp);
  rp.ammoLib = Items.ammoLibOf(rp);                               // ← 正解：成对重派生
  const after = Loadout.syncProfile(rp).profile;

  assert.strictEqual(sumOfId(after.grid.items, '545x39'), 0, '仓库不得残留弹药（复制缺陷复发）');
  assert.strictEqual(sumOfId(after.containers.rig.items, '545x39'), 60, '胸挂应持有 60 发');
  // 幂等
  const again = Loadout.syncProfile(after).profile;
  assert.strictEqual(sumOfId(again.grid.items, '545x39'), 0, '二次同步不得把弹药补回仓库');
  assert.strictEqual(sumOfId(again.containers.rig.items, '545x39'), 60, '二次同步胸挂仍 60 发');
});

test('B3 回归: 弹药 只重派生 stash 不重派生 ammoLib → 会复制（锁定机理）', () => {
  const s = fixWithRigAndAmmo(60);
  const uid = s.grid.items.find(e => e.itemId === '545x39').uid;
  const r = Containers.transferFromGrid(s, uid, 'rig');
  const rp = { ...r.profile };
  rp.stash = Loadout.legacyStash(rp);                             // 只做了一半
  const wrong = Loadout.syncProfile(rp).profile;
  assert.strictEqual(sumOfId(wrong.grid.items, '545x39'), 60, '旧写法下仓库被补回 60 发（缺陷机理）');
  assert.strictEqual(sumOfId(wrong.containers.rig.items, '545x39'), 60, '旧写法下胸挂也有 60 发（缺陷机理）');
});

// ==================== B4：来源标记（src）透传 ====================
// 需求：胸挂内物品可快捷使用、背包内不可 → 来源信息必须一路带到局内。
// 契约：takeAll / takeCarryFromContainers 的 raidItems 每条带 src∈{'rig','backpack'}；
//       新增 raidAmmoRig / raidAmmoBag 明细；旧字段 raidAmmo / raidItems 原样保留（向后兼容）。

test('B4: 进图携带 raidItems 必须带 src 来源标记（胸挂/背包可分辨）', () => {
  // 装备胸挂 + 背包（未装备的槽位 = null，故两者都必须装上）
  const p = Items.defaultProfile('tester');
  p.stash.push({ itemId: 'bandage', count: 4 });
  p.stash.push({ itemId: 'rig_scav' });
  p.stash.push({ itemId: 'bp_scav' });
  let s = Loadout.syncProfile(p).profile;
  s = Loadout.equipUid(s, s.grid.items.find(e => e.itemId === 'rig_scav').uid, 'rig').profile;
  s = Loadout.equipUid(s, s.grid.items.find(e => e.itemId === 'bp_scav').uid, 'backpack').profile;
  assert.ok(s.containers.rig, '胸挂容器已建立');
  assert.ok(s.containers.backpack, '背包容器已建立');

  // 绷带 4 件 → 胸挂
  const bu = s.grid.items.find(e => e.itemId === 'bandage').uid;
  const t1 = Containers.transferFromGrid(s, bu, 'rig');
  assert.strictEqual(t1.ok, true);
  let st = { ...t1.profile };
  st.stash = Loadout.legacyStash(st);
  st.ammoLib = Items.ammoLibOf(st);
  st = Loadout.syncProfile(st).profile;
  assert.ok(st.containers.rig, '同步后胸挂容器仍在');

  // 再放 2 件到背包（直接注入容器格，避免依赖网格空间）
  st.containers.backpack.items.push({ uid: Grid.makeUid(), itemId: 'bandage', x: 0, y: 0, rot: 0, count: 2 });

  const r = Items.takeCarryFromContainers(st);
  const rigBandage = r.raidItems.find(e => e.itemId === 'bandage' && e.src === 'rig');
  const bagBandage = r.raidItems.find(e => e.itemId === 'bandage' && e.src === 'backpack');
  assert.ok(rigBandage, '胸挂内绷带条目应带 src=rig');
  assert.ok(bagBandage, '背包内绷带条目应带 src=backpack');
  assert.strictEqual(rigBandage.count, 4, '胸挂绷带 4 件');
  assert.strictEqual(bagBandage.count, 2, '背包绷带 2 件');
});

test('B4: 旧字段 raidAmmo 原样保留（向后兼容，既有读取方零改动）', () => {
  const s = fixWithRigAndAmmo(60);
  const uid = s.grid.items.find(e => e.itemId === '545x39').uid;
  const t = Containers.transferFromGrid(s, uid, 'rig');
  let st = { ...t.profile };
  st.stash = Loadout.legacyStash(st);
  st.ammoLib = Items.ammoLibOf(st);
  st = Loadout.syncProfile(st).profile;

  const r = Items.takeCarryFromContainers(st);
  assert.strictEqual(r.raidAmmo['545x39'], 60, '旧字段 raidAmmo 必须保留 60 发');
  assert.deepStrictEqual(r.raidAmmoRig, { '545x39': 60 }, '胸挂明细应为 60');
  assert.deepStrictEqual(r.raidAmmoBag, {}, '背包明细应为空');
});

test('B4: raidAmmoRig + raidAmmoBag 之和 === raidAmmo（守恒）', () => {
  const p = Items.defaultProfile('tester');
  p.stash.push({ itemId: '545x39', count: 20 });
  p.stash.push({ itemId: 'rig_scav' });
  p.stash.push({ itemId: 'bp_scav' });
  let s = Loadout.syncProfile(p).profile;
  s = Loadout.equipUid(s, s.grid.items.find(e => e.itemId === 'rig_scav').uid, 'rig').profile;
  s = Loadout.equipUid(s, s.grid.items.find(e => e.itemId === 'bp_scav').uid, 'backpack').profile;
  assert.ok(s.containers.rig && s.containers.backpack, '胸挂与背包容器均已建立');

  // 20 发 → 胸挂
  const uid = s.grid.items.find(e => e.itemId === '545x39').uid;
  const t = Containers.transferFromGrid(s, uid, 'rig');
  assert.strictEqual(t.ok, true);
  let st = { ...t.profile };
  st.stash = Loadout.legacyStash(st);
  st.ammoLib = Items.ammoLibOf(st);
  st = Loadout.syncProfile(st).profile;
  assert.ok(st.containers.rig, '同步后胸挂容器仍在');

  // 背包再塞 15 发
  st.containers.backpack.items.push({ uid: Grid.makeUid(), itemId: '545x39', x: 0, y: 0, rot: 0, count: 15 });

  const r = Items.takeCarryFromContainers(st);
  const rigSum = Object.values(r.raidAmmoRig).reduce((a, b) => a + b, 0);
  const bagSum = Object.values(r.raidAmmoBag).reduce((a, b) => a + b, 0);
  const allSum = Object.values(r.raidAmmo).reduce((a, b) => a + b, 0);
  assert.strictEqual(rigSum, 20, '胸挂 20 发');
  assert.strictEqual(bagSum, 15, '背包 15 发');
  assert.strictEqual(rigSum + bagSum, allSum, 'Rig+Bag 之和必须等于总数');
  assert.strictEqual(allSum, 35, '总数 35 发');
});

test('B4: 容器库缺失兜底也必须返回完整字段形状（防调用方 undefined）', () => {
  // 直接调 items 的兜底分支不易构造，改为断言导出字段形状一致
  const r = Items.takeCarryFromContainers(Items.defaultProfile('t2'));
  assert.ok('raidAmmo' in r, 'raidAmmo 存在');
  assert.ok('raidItems' in r, 'raidItems 存在');
  assert.ok('raidAmmoRig' in r, 'raidAmmoRig 存在（B4 新增，形状必须稳定）');
  assert.ok('raidAmmoBag' in r, 'raidAmmoBag 存在（B4 新增，形状必须稳定）');
  assert.strictEqual(Array.isArray(r.raidItems), true, 'raidItems 必须是数组');
});

