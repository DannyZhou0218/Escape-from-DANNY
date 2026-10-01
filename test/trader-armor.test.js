/*
 * EXFIL ZONE · 商人护具交易单元测试（v0.15.1）
 *
 * 背景（用户实测反馈）：商人处原本只卖弹药箱与药品，**没有任何护具**，护甲系统因此无法通过正常经济途径获得。
 * 修复：① content.json 货表新增 4 件护具；② items.js 购买逻辑区分「装备类不可堆叠」。
 *
 * 本文件锁死的不变量：
 *   1. 货表必须包含 4 件护具（护甲/头盔各 2），且都带价格与标签
 *   2. 装备类（有 slot）**不可堆叠**：每件独立成条（旧实现会并成 count=2 → 表现为"买两件只有一件"）
 *   3. 消耗品仍合并堆叠（防误伤回归）
 *   4. 钱不够 → 不扣钱、不给货
 *   5. 经济铁律：任何货品「买价 >= 卖价」，否则可无限印钞
 *   6. 买来的护具能真正走完整链路：syncProfile 入格 → 装备 → takeCarryFromContainers 产出 raidArmor
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Items = require('../shared/items');
const Loadout = require('../shared/loadout');

const CONTENT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'content.json'), 'utf8'));
const ARMOR_IDS = ['helm_ssh68', 'armor_paca', 'armor_6b13', 'helm_alt'];

function freshProfile(money) {
  return Loadout.syncProfile({
    money: money === undefined ? 20000 : money,
    stash: [], grid: null, equipment: null, containers: null, ammoLib: {}
  }).profile;
}
function buy(p, itemId) { return Items.tradeProfile(p, { type: 'buy', itemId }); }
function gridCount(p, itemId) {
  return (p.grid.items || []).filter((e) => e.itemId === itemId).reduce((a, b) => a + (b.count || 1), 0);
}
function goodsOf(itemId) { return CONTENT.traderGoods.find((g) => g.id === itemId); }

// ---------- 1. 货表内容 ----------
test('商人货表：包含 4 件护具，护甲/头盔各 2 件', () => {
  const armorEntries = ARMOR_IDS.map(goodsOf);
  assert.ok(armorEntries.every(Boolean), '4 件护具必须都在货表里');
  const chest = ARMOR_IDS.filter((id) => (CONTENT.loot[id].cover || []).includes('chest'));
  const head = ARMOR_IDS.filter((id) => (CONTENT.loot[id].cover || []).includes('head'));
  assert.equal(chest.length, 2, '护胸 2 件');
  assert.equal(head.length, 2, '护头 2 件');
});

test('商人货表：每件货品都有正数价格与非空标签', () => {
  for (const g of CONTENT.traderGoods) {
    assert.ok(g.id && typeof g.id === 'string', '每件货品必须有 id');
    assert.ok(Number.isFinite(g.price) && g.price > 0, g.id + ' 价格必须为正数');
    assert.ok(g.label && g.label.length > 0, g.id + ' 必须有标签');
  }
});

// ---------- 2. 装备类不可堆叠 ----------
test('装备类不可堆叠：买一件护甲 → 独立条目 count=1，钱正确扣减', () => {
  const price = goodsOf('armor_6b13').price;
  const r = buy(freshProfile(20000), 'armor_6b13');
  assert.equal(r.ok, true);
  assert.equal(r.profile.money, 20000 - price);
  const entries = r.profile.stash.filter((e) => e.itemId === 'armor_6b13');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].count, 1);
});

test('装备类不可堆叠：连买两件护甲 → 两条 count=1（旧实现会并成一条 count=2）', () => {
  let r = buy(freshProfile(20000), 'armor_6b13');
  r = buy(r.profile, 'armor_6b13');
  const entries = r.profile.stash.filter((e) => e.itemId === 'armor_6b13');
  assert.equal(entries.length, 2, '两件护甲必须是两条独立条目');
  assert.deepEqual(entries.map((e) => e.count), [1, 1]);
});

test('装备类不可堆叠：连买两件头盔 → 两条 count=1', () => {
  let r = buy(freshProfile(20000), 'helm_alt');
  r = buy(r.profile, 'helm_alt');
  const entries = r.profile.stash.filter((e) => e.itemId === 'helm_alt');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.count), [1, 1]);
});

test('消耗品仍合并堆叠（防误伤回归）', () => {
  let r = buy(freshProfile(20000), 'bandage');
  r = buy(r.profile, 'bandage');
  const entries = r.profile.stash.filter((e) => e.itemId === 'bandage');
  assert.equal(entries.length, 1, '消耗品应合并成一条');
  assert.equal(entries[0].count, 2);
});

test('武器类不在 buy 分支堆叠（buyWeapon 独立路径）', () => {
  const r = Items.tradeProfile(freshProfile(20000), { type: 'buyWeapon', weaponId: 'ak74' });
  assert.equal(r.ok, true);
  assert.ok(r.profile.stash.some((e) => e.weaponId === 'ak74'));
});

// ---------- 3. 钱不够 ----------
test('钱不够：不扣钱、不得货、返回 ok=false', () => {
  const price = goodsOf('helm_alt').price;
  const r = buy(freshProfile(price - 1), 'helm_alt');
  assert.equal(r.ok, false);
  assert.equal(r.profile.money, price - 1, '失败时余额不得变化');
  assert.equal(r.profile.stash.filter((e) => e.itemId === 'helm_alt').length, 0, '失败时不得给货');
});

test('未知货品：ok=false 且不扣钱', () => {
  const r = buy(freshProfile(20000), 'not_a_real_item');
  assert.equal(r.ok, false);
  assert.equal(r.profile.money, 20000);
});

// ---------- 4. 经济铁律 ----------
test('经济铁律：所有货品「买价 >= 卖价」（否则可无限印钞）', () => {
  const bad = [];
  for (const g of CONTENT.traderGoods) {
    const sell = (CONTENT.loot[g.id] || {}).price || 0;
    if (g.price < sell) bad.push(g.id + ' 买' + g.price + ' < 卖' + sell);
  }
  assert.deepEqual(bad, [], '存在买价低于卖价的货品 → 印钞漏洞: ' + bad.join('; '));
});

// ---------- 5. 完整链路：买 → 入格 → 装备 → 进图带甲 ----------
test('链路闭环：买的护甲能 syncProfile 进格（联机路径依赖）', () => {
  const r = buy(freshProfile(20000), 'armor_paca');
  const p = Loadout.syncProfile(r.profile).profile;
  assert.equal(gridCount(p, 'armor_paca'), 1, '护甲必须落进仓库格子');
});

test('链路闭环：连买两件护甲 → syncProfile 后格子里确实是 2 件', () => {
  let r = buy(freshProfile(20000), 'armor_paca');
  r = buy(r.profile, 'armor_paca');
  const p = Loadout.syncProfile(r.profile).profile;
  assert.equal(gridCount(p, 'armor_paca'), 2, '两件护甲必须在格子里是 2 件，而不是 1 件');
});

test('链路闭环：买 6B13 → 装备 armor 槽 → 进图产出 raidArmor.armor（耐久/等级/覆盖正确）', () => {
  const r = buy(freshProfile(20000), 'armor_6b13');
  const p = Loadout.syncProfile(r.profile).profile;
  const uid = p.grid.items.find((e) => e.itemId === 'armor_6b13').uid;
  const eq = Loadout.equipUid(p, uid, 'armor');
  assert.equal(eq.ok, true, '装备必须成功');
  const carried = Items.takeCarryFromContainers(eq.profile);
  const a = carried.raidArmor.armor;
  assert.ok(a, 'armor 槽的护具必须带进局内');
  assert.equal(a.itemId, 'armor_6b13');
  const def = CONTENT.loot.armor_6b13;
  assert.equal(a.durMax, def.dur);
  assert.equal(a.durNow, def.dur, '新买的甲应为满耐久');
  assert.equal(a.armorClass, def.armorClass);
  assert.deepEqual(a.cover, def.cover);
  assert.equal(carried.raidArmor.helm, null, '没戴头盔时 helm 必须为 null');
});

test('链路闭环：买 Altyn → 装备 head 槽 → 进图产出 raidArmor.helm（cover=head）', () => {
  const r = buy(freshProfile(20000), 'helm_alt');
  const p = Loadout.syncProfile(r.profile).profile;
  const uid = p.grid.items.find((e) => e.itemId === 'helm_alt').uid;
  const eq = Loadout.equipUid(p, uid, 'head');
  assert.equal(eq.ok, true);
  const carried = Items.takeCarryFromContainers(eq.profile);
  const h = carried.raidArmor.helm;
  assert.ok(h, 'head 槽的头盔必须带进局内');
  assert.equal(h.itemId, 'helm_alt');
  assert.equal(h.armorClass, CONTENT.loot.helm_alt.armorClass);
  assert.deepEqual(h.cover, ['head']);
  assert.equal(carried.raidArmor.armor, null, '没穿甲时 armor 必须为 null');
});

test('护具不进弹药库：买护甲不会污染 ammoLib', () => {
  const r = buy(freshProfile(20000), 'armor_paca');
  const p = Loadout.syncProfile(r.profile).profile;
  const total = Object.values(p.ammoLib || {}).reduce((a, b) => a + b, 0);
  assert.equal(total, 0, '护甲不得计入弹药持有量');
});
