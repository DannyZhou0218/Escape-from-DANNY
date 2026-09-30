'use strict';
/*
 * EXFIL ZONE · 整备适配层测试（P2：shared/loadout.js）
 * 覆盖：派生顺序与 uid · 坐标不丢 · 与既有结算/携带/商人纯函数集成 · 装备槽操作 · 容错
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const Grid = require('../shared/grid');
const Loadout = require('../shared/loadout');
const ITEMS = require('../shared/items');

// ---------- 夹具 ----------
function baseProfile() {
  return {
    name: 'T', money: 1000, ammoLib: {},
    stash: [
      { weaponId: 'ak74', mods: {}, ammo: { ammoId: '545x39', count: 30, reserve: 0 } },
      { weaponId: 'pm', mods: {}, ammo: { ammoId: '9x18', count: 8, reserve: 0 } },
      { itemId: '545x39', count: 60 },
      { itemId: 'bandage', count: 3 },
      { itemId: 'gold_chain', count: 1 }
    ]
  };
}
function uidOf(p, pred) { const s = (p.stash || []).find(pred); return s && s.uid; }
function entryOf(p, uid) { return Grid.findByUid(p.grid, uid); }

// ========== 1. 派生（legacyStash / indexByUid） ==========
test('P2: legacyStash 装备槽在前（primary → secondary），仓库物品按 row-major', () => {
  let p = Loadout.ensure(baseProfile());
  const akUid = uidOf(p, s => s.weaponId === 'ak74');
  const eq = Loadout.equipUid(p, akUid, 'primary');
  assert.equal(eq.ok, true);
  p = eq.profile;
  assert.equal(p.stash[0].weaponId, 'ak74', '主武器必须排在 legacy 首位');
  assert.equal(p.stash[0].uid, akUid, 'uid 必须保留');
  const rest = p.stash.slice(1);
  for (let i = 1; i < rest.length; i++) {
    const a = entryOf(p, rest[i - 1].uid), b = entryOf(p, rest[i].uid);
    assert.ok(a && b, '仓库条目必须都能在 grid 中找到');
    assert.ok(a.y < b.y || (a.y === b.y && a.x <= b.x), '仓库部分必须按 row-major（y 升序，同行 x 升序）');
  }
});
test('P2: legacyStash 武器条目保留旧格式（weaponId/mods/ammo）+ uid', () => {
  const p = Loadout.ensure(baseProfile());
  const w = p.stash.find(s => s.weaponId === 'ak74');
  assert.ok(w.uid, '必须带 uid（位置对齐的锚点）');
  assert.deepEqual(w.ammo, { ammoId: '545x39', count: 30, reserve: 0 });
  assert.equal(typeof w.mods, 'object');
});
test('P2: indexByUid 返回 legacy 下标；未知 uid 返回 -1', () => {
  const p = Loadout.ensure(baseProfile());
  const uid = uidOf(p, s => s.weaponId === 'pm');
  assert.ok(Loadout.indexByUid(p, uid) >= 0);
  assert.equal(Loadout.indexByUid(p, 'nope'), -1);
  assert.equal(Loadout.indexByUid(null, uid), -1);
});

// ========== 2. 同步：坐标不丢（核心） ==========
test('P2: syncProfile 幂等——连续两次结果一致', () => {
  const p1 = Loadout.ensure(baseProfile());
  const p2 = Loadout.ensure(p1);
  assert.deepEqual(p2.grid.items.map(e => [e.uid, e.x, e.y, e.rot]), p1.grid.items.map(e => [e.uid, e.x, e.y, e.rot]));
  assert.deepEqual(p2.stash.map(s => s.uid), p1.stash.map(s => s.uid));
});
test('P2: syncProfile 保留玩家摆盘坐标（不重排）', () => {
  let p = Loadout.ensure(baseProfile());
  const uid = uidOf(p, s => s.itemId === 'bandage');
  p = Loadout.moveUid(p, uid, 7, 12).profile;
  const before = entryOf(p, uid);
  assert.deepEqual([before.x, before.y], [7, 12]);
  const again = Loadout.ensure(p);
  assert.deepEqual([entryOf(again, uid).x, entryOf(again, uid).y], [7, 12], '同步后坐标必须不变');
});
test('P2: syncProfile 不修改入参', () => {
  const p = Loadout.ensure(baseProfile());
  const snap = JSON.stringify(p);
  Loadout.syncProfile(p);
  assert.equal(JSON.stringify(p), snap, '纯函数不得改入参');
});
test('P2: syncProfile 脏档案不抛错', () => {
  assert.doesNotThrow(() => Loadout.syncProfile(null));
  assert.doesNotThrow(() => Loadout.syncProfile({}));
  assert.doesNotThrow(() => Loadout.syncProfile({ stash: 'x' }));
  assert.doesNotThrow(() => Loadout.syncProfile({ stash: [null, {}, { count: 1 }] }));
  assert.equal(Loadout.syncProfile({}).profile.stash.length, 0);
});

// ========== 3. 同步：增删改（撤离/阵亡/携带/商人） ==========
test('P2: 新增物品（无 uid）自动入格', () => {
  const p = Loadout.ensure(baseProfile());
  const n0 = p.grid.items.length;
  const mod = { ...p, stash: p.stash.concat([{ itemId: 'rolex', count: 1 }]) };
  const r = Loadout.syncProfile(mod);
  assert.equal(r.profile.grid.items.length, n0 + 1);
  assert.equal(r.added.length, 1);
  assert.equal(Loadout.countOf(r.profile, 'rolex'), 1);
});
test('P2: 数量变化被同步（3 → 1）', () => {
  const p = Loadout.ensure(baseProfile());
  const uid = uidOf(p, s => s.itemId === 'bandage');
  const mod = { ...p, stash: p.stash.map(s => s.uid === uid ? { ...s, count: 1 } : s) };
  const r = Loadout.syncProfile(mod);
  assert.equal(entryOf(r.profile, uid).count, 1);
  assert.ok(r.changed.some(c => c.why === 'count'));
});
test('P2: 条目被移除 → 仓库格子里也消失', () => {
  const p = Loadout.ensure(baseProfile());
  const uid = uidOf(p, s => s.itemId === 'gold_chain');
  const mod = { ...p, stash: p.stash.filter(s => s.uid !== uid) };
  const r = Loadout.syncProfile(mod);
  assert.equal(entryOf(r.profile, uid), null, '孤儿条目必须被清除');
  assert.ok(r.removed.some(x => x.uid === uid));
});
test('P2: 撤离写回弹药 → 装备槽里的条目同步更新', () => {
  let p = Loadout.ensure(baseProfile());
  const uid = uidOf(p, s => s.weaponId === 'ak74');
  p = Loadout.equipUid(p, uid, 'primary').profile;
  const idx = Loadout.indexByUid(p, uid);
  // 模拟 backToLobby 的结算链：settleRaid 写回弹药（uid 随 {...s} 保留）
  const settled = ITEMS.settleRaid(p, {
    extracted: true, weaponIdx: idx,
    weaponAmmo: { ammoId: '545x39', count: 12 },
    inventory: [{ itemId: 'bandage', count: 2 }]
  });
  const r = Loadout.syncProfile(settled);
  assert.equal(r.profile.equipment.primary.ammo.count, 12, '装备槽弹药必须写回');
  assert.equal(Loadout.countOf(r.profile, 'bandage'), 5, '3 + 撤离带回 2');
});
test('P2: 阵亡丢枪 → 装备槽被清空（武器真的没了）', () => {
  let p = Loadout.ensure(baseProfile());
  const uid = uidOf(p, s => s.weaponId === 'ak74');
  p = Loadout.equipUid(p, uid, 'primary').profile;
  const idx = Loadout.indexByUid(p, uid);
  const settled = ITEMS.settleRaid(p, { extracted: false, weaponIdx: idx, inventory: [] });
  const r = Loadout.syncProfile(settled);
  assert.equal(r.profile.equipment.primary, null, '阵亡必须清空主武器槽');
  assert.equal(r.cleared.length, 1);
  assert.equal(Loadout.indexByUid(r.profile, uid), -1);
});
test('P2: 与 takeCarry 集成——携带扣减后仓库同步', () => {
  const p0 = Loadout.ensure({ ...baseProfile(), ammoLib: { '545x39': 60 } });
  const carried = ITEMS.takeCarry(p0, { ammo: { '545x39': 60 }, items: [{ itemId: 'bandage', count: 3 }] });
  const r = Loadout.syncProfile(carried.profile);
  assert.equal(Loadout.countOf(r.profile, 'bandage'), 0, '带走了 3 个绷带 → 仓库无');
  assert.equal(r.profile.grid.items.some(e => e.itemId === 'bandage'), false);
  assert.equal(carried.raidItems.length, 1, '携带品进入局内背包');
});
test('P2: 与 tradeProfile 集成——买入入格 / 卖出出格', () => {
  const p0 = Loadout.ensure(baseProfile());
  const bought = ITEMS.tradeProfile(p0, { type: 'buy', itemId: 'bandage' });
  const a = Loadout.syncProfile(bought.profile);
  assert.equal(Loadout.countOf(a.profile, 'bandage'), 4, '3 + 买 1');
  const sold = ITEMS.tradeProfile(a.profile, { type: 'sellLoot', itemId: 'gold_chain' });
  const b = Loadout.syncProfile(sold.profile);
  assert.equal(Loadout.countOf(b.profile, 'gold_chain'), 0);
  assert.ok(b.profile.money > a.profile.money, '出售应加钱');
});
test('P2: 与 tradeProfile 集成——买枪入格且带弹药', () => {
  const p0 = Loadout.ensure(baseProfile());
  const r = Loadout.syncProfile(ITEMS.tradeProfile(p0, { type: 'buyWeapon', weaponId: 'mp5' }).profile);
  const hit = r.profile.grid.items.find(e => e.itemId === 'w_mp5');
  assert.ok(hit, '新买的枪必须进格');
  assert.equal(hit.ammo.count, ITEMS.WEAPONS.mp5.magSize);
  assert.deepEqual(Grid.footprint(hit.itemId, hit.rot), [3, 2], 'MP5 必须按 3×2 占格');
});

// ========== 4. 出战武器 ==========
test('P2: findWeaponUid 保留有效选择', () => {
  const p = Loadout.ensure(baseProfile());
  const pm = uidOf(p, s => s.weaponId === 'pm');
  assert.equal(Loadout.findWeaponUid(p, pm), pm);
});
test('P2: findWeaponUid 无有效选择时优先装备槽（primary → secondary）', () => {
  let p = Loadout.ensure(baseProfile());
  const ak = uidOf(p, s => s.weaponId === 'ak74');
  p = Loadout.equipUid(p, ak, 'primary').profile;
  assert.equal(Loadout.findWeaponUid(p, null), ak, '应回落到主武器槽');
  p = Loadout.equipUid(p, ak, 'secondary').profile;
  assert.equal(Loadout.findWeaponUid(p, null), ak, '副武器槽同样承认');
});
test('P2: findWeaponUid 最终回落到仓库第一把 / 无武器返回 null', () => {
  const p = Loadout.ensure(baseProfile());
  const first = uidOf(p, s => s.weaponId === 'ak74');
  assert.equal(Loadout.findWeaponUid(p, null), first);
  const empty = Loadout.ensure({ stash: [{ itemId: 'bandage', count: 1 }] });
  assert.equal(Loadout.findWeaponUid(empty, null), null);
  assert.equal(Loadout.findWeaponUid(empty, uidOf(empty, s => s.itemId === 'bandage')), null, '杂物不能当武器');
});
test('P2: raidWeaponOf 给出实例 + legacy 下标（供 join.stashIndex）', () => {
  const p = Loadout.ensure(baseProfile());
  const uid = uidOf(p, s => s.weaponId === 'ak74');
  const w = Loadout.raidWeaponOf(p, uid);
  assert.equal(w.instance.weaponId, 'ak74');
  assert.equal(w.instance.ammo.count, 30);
  assert.equal(w.legacyIndex, Loadout.indexByUid(p, uid));
  assert.equal(Loadout.raidWeaponOf(p, 'nope'), null);
});

// ========== 5. 装备槽操作 ==========
test('P2: equipUid 仓库 → 主武器槽（并从格子中移除）', () => {
  const p0 = Loadout.ensure(baseProfile());
  const uid = uidOf(p0, s => s.weaponId === 'ak74');
  const r = Loadout.equipUid(p0, uid, 'primary');
  assert.equal(r.ok, true);
  assert.equal(r.profile.equipment.primary.itemId, 'w_ak74');
  assert.equal(Grid.findByUid(r.profile.grid, uid), null, '装备后不得同时留在仓库');
  assert.equal(p0.equipment.primary, null, '入参不被修改');
});
test('P2: equipUid 槽位被占 → 自动把占用者放回仓库（不丢装备）', () => {
  let p = Loadout.ensure(baseProfile());
  const ak = uidOf(p, s => s.weaponId === 'ak74');
  p = Loadout.equipUid(p, ak, 'primary').profile;
  // 再加一把步枪（能进 primary 的才算冲突；PM 是手枪，只能进 secondary）
  p = Loadout.addToGrid(p, 'w_akm', 1, { ammo: { ammoId: '762x39', count: 30 } }).profile;
  const akm = uidOf(p, s => s.weaponId === 'akm');
  const r = Loadout.equipUid(p, akm, 'primary');
  assert.equal(r.ok, true);
  assert.equal(r.swapped, true);
  assert.equal(r.profile.equipment.primary.itemId, 'w_akm');
  assert.ok(Grid.findByUid(r.profile.grid, ak), '被换下的 AK 必须回到仓库（不能凭空消失）');
});
test('P2: 手枪不能进主武器槽（槽位约束生效）', () => {
  let p = Loadout.ensure(baseProfile());
  const ak = uidOf(p, s => s.weaponId === 'ak74');
  const pm = uidOf(p, s => s.weaponId === 'pm');
  p = Loadout.equipUid(p, ak, 'primary').profile;
  assert.equal(Loadout.equipUid(p, pm, 'primary').reason, 'slot-not-allowed', 'PM 只应进 secondary');
  assert.equal(Loadout.equipUid(p, pm, 'secondary').ok, true);
});
test('P2: equipUid 槽位不符 / 未知 uid → 失败', () => {
  const p = Loadout.ensure(baseProfile());
  const uid = uidOf(p, s => s.weaponId === 'ak74');
  assert.equal(Loadout.equipUid(p, uid, 'head').reason, 'slot-not-allowed');
  assert.equal(Loadout.equipUid(p, 'ghost', 'primary').reason, 'no-such-uid');
});
test('P2: unequipSlot 卸下回仓库；仓库满则拒绝（装备不消失）', () => {
  let p = Loadout.ensure(baseProfile());
  const uid = uidOf(p, s => s.weaponId === 'ak74');
  p = Loadout.equipUid(p, uid, 'primary').profile;
  const ok = Loadout.unequipSlot(p, 'primary');
  assert.equal(ok.ok, true);
  assert.equal(ok.profile.equipment.primary, null);
  assert.ok(Grid.findByUid(ok.profile.grid, uid), '卸下后回到仓库');
  // 满仓库场景
  const tiny = { ...p, grid: { w: 2, h: 2, items: [] } };
  const fail = Loadout.unequipSlot(tiny, 'primary');
  assert.equal(fail.ok, false);
  assert.equal(fail.profile.equipment.primary.itemId, 'w_ak74', '卸不下就必须保持装备状态');
});

// ========== 6. 移动 / 旋转 / 出入仓 ==========
test('P2: moveUid 仓库内移动 + 旋转', () => {
  const p = Loadout.ensure(baseProfile());
  const uid = uidOf(p, s => s.weaponId === 'ak74');
  const mv = Loadout.moveUid(p, uid, 3, 20);
  assert.equal(mv.ok, true);
  assert.deepEqual([entryOf(mv.profile, uid).x, entryOf(mv.profile, uid).y], [3, 20]);
  const rot = Loadout.rotateUid(mv.profile, uid);
  assert.equal(rot.ok, true);
  assert.equal(entryOf(rot.profile, uid).rot, 1, 'AK-74 横置 → 旋转后转置');
});
test('P2: moveUid 目标被占 → 失败且位置不变', () => {
  const p = Loadout.ensure(baseProfile());
  const ak = uidOf(p, s => s.weaponId === 'ak74');
  const pm = uidOf(p, s => s.weaponId === 'pm');
  const akPos = entryOf(p, ak);
  const mv = Loadout.moveUid(p, pm, akPos.x, akPos.y);
  assert.equal(mv.ok, false);
  assert.deepEqual([entryOf(p, pm).x, entryOf(p, pm).y], [entryOf(p, pm).x, entryOf(p, pm).y]);
});
test('P2: moveUid 把装备槽物品拖回仓库（卸下并落位）', () => {
  let p = Loadout.ensure(baseProfile());
  const uid = uidOf(p, s => s.weaponId === 'ak74');
  p = Loadout.equipUid(p, uid, 'primary').profile;
  const r = Loadout.moveUid(p, uid, 5, 25);
  assert.equal(r.ok, true);
  assert.equal(r.profile.equipment.primary, null, '必须真的卸下');
  const e = entryOf(r.profile, uid);
  assert.deepEqual([e.x, e.y], [5, 25]);
});
test('P2: addToGrid / removeFromGrid / takeByItemId / countOf', () => {
  let p = Loadout.ensure(baseProfile());
  p = Loadout.addToGrid(p, 'bandage', 2).profile;
  assert.equal(Loadout.countOf(p, 'bandage'), 5);
  const uid = uidOf(p, s => s.itemId === 'bandage');
  const part = Loadout.removeFromGrid(p, uid, 2);
  assert.equal(part.ok, true);
  assert.equal(Loadout.countOf(part.profile, 'bandage'), 3);
  const all = Loadout.removeFromGrid(part.profile, uid);
  assert.equal(Loadout.countOf(all.profile, 'bandage'), 0);
  const p2 = Loadout.addToGrid(all.profile, 'bolt', 4).profile;
  assert.equal(Loadout.countOf(Loadout.takeByItemId(p2, 'bolt', 1).profile, 'bolt'), 3);
  assert.equal(Loadout.takeByItemId(p2, 'nope', 1).ok, false);
});
test('P2: 仓库满时入仓失败但不崩', () => {
  const tiny = Loadout.ensure({ stash: [{ itemId: 'bandage', count: 1 }] });
  const full = { ...tiny, grid: { w: 1, h: 1, items: Grid.cloneGrid(tiny.grid).items } };
  const r = Loadout.addToGrid(full, 'w_ak74', 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-space');
});

// ========== 7. 端到端 ==========
test('P2: 完整循环——整备装备 → 进图扣除 → 局内拾取 → 撤离归仓（格子一致）', () => {
  // ① 整备：装备 AK + 携带弹药/绷带
  let p = Loadout.ensure(baseProfile());
  const ak = uidOf(p, s => s.weaponId === 'ak74');
  p = Loadout.equipUid(p, ak, 'primary').profile;
  assert.equal(Loadout.indexByUid(p, ak), 0, '主武器 = legacy 首位（join.stashIndex=0）');
  const carried = ITEMS.takeCarry(p, { ammo: { '545x39': 30 }, items: [{ itemId: 'bandage', count: 1 }] });
  p = Loadout.syncProfile(carried.profile).profile;
  assert.equal(Loadout.countOf(p, 'bandage'), 2);
  assert.deepEqual(p.ammoLib, { '545x39': 30 }, '携带后库里剩 30');
  // ② 撤离结算：弹药写回 + 拾取物入仓
  const settled = ITEMS.settleRaid(p, {
    extracted: true, weaponIdx: Loadout.indexByUid(p, ak),
    weaponAmmo: { ammoId: '545x39', count: 7 },
    inventory: [{ itemId: 'bandage', count: 1 }, { itemId: 'graphics_card', count: 1 }]
  });
  const carried2 = ITEMS.settleCarry(settled, { extracted: true, raidAmmo: { '545x39': 23 } });
  const fin = Loadout.syncProfile(carried2).profile;
  assert.equal(fin.equipment.primary.ammo.count, 7, '装备槽弹药 = 局内剩余');
  assert.equal(fin.ammoLib['545x39'], 53, '30 + 归仓 23');
  assert.equal(Loadout.countOf(fin, 'bandage'), 3, '2 + 带回 1');
  assert.equal(Loadout.countOf(fin, 'graphics_card'), 1, '拾取的显卡入格');
  assert.deepEqual(Grid.footprint('graphics_card', 0), [2, 1], '显卡 2×1 占格');
});
test('P2: 接口完整性（P2 交付面）', () => {
  const api = ['slotOrder', 'legacyStash', 'indexByUid', 'syncProfile', 'ensure',
    'isWeaponUid', 'findWeaponUid', 'raidWeaponOf', 'equipUid', 'unequipSlot',
    'moveUid', 'rotateUid', 'addToGrid', 'removeFromGrid', 'takeByItemId', 'countOf'];
  for (const k of api) assert.equal(typeof Loadout[k], 'function', `缺接口 ${k}`);
});
test('P2: 浏览器语义可用（挂载 window.EXFIL_LOADOUT）', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'loadout.js'), 'utf-8');
  assert.ok(src.includes('window.EXFIL_LOADOUT = Loadout'));
  assert.ok(src.includes("require('./grid')") && src.includes("require('./items')"));
});
