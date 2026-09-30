/*
 * EXFIL ZONE · items/storage 单元测试
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { WEAPONS, AMMO, MODS, defaultStash, defaultProfile, makeWeaponInstance, canFire, consumeAmmo } = require('../shared/items');
const Storage = require('../shared/storage');

test('items: 默认档案结构', () => {
  const p = defaultProfile('测试');
  assert.equal(p.name, '测试');
  assert.equal(p.money, 1000);
  assert.equal(p.stash.length, 2);
  assert.ok(p.created > 0);
});
test('items: 武器实例从仓库条目生成', () => {
  const inst = makeWeaponInstance(defaultStash()[0]); // ak74
  assert.equal(inst.weaponId, 'ak74');
  assert.equal(inst.dmg, 24);
  assert.equal(inst.ammo.count, 30, '弹匣内 30');
  assert.equal(inst.ammo.reserve, 30, '备弹 30');
  assert.ok(inst.slots.includes('sight'));
  assert.ok(inst.slots.includes('mag'));
});
test('items: 弹药口径匹配', () => {
  const ak = makeWeaponInstance(defaultStash()[0]);
  assert.equal(ak.ammo.ammoId, WEAPONS.ak74.ammoType);
  const pm = makeWeaponInstance(defaultStash()[1]);
  assert.equal(pm.ammo.ammoId, WEAPONS.pm.ammoType);
});
test('items: canFire / consumeAmmo', () => {
  const inst = makeWeaponInstance({ weaponId: 'ak74', mods: {}, ammo: { ammoId: '545x39', count: 3 } });
  assert.equal(canFire(inst), true);
  consumeAmmo(inst); consumeAmmo(inst); consumeAmmo(inst);
  assert.equal(canFire(inst), false, '弹尽后不可开火');
});
test('items: 改装件槽位类型', () => {
  assert.ok(MODS.pso.type === 'sight');
  assert.ok(WEAPONS.ak74.slots.includes('sight'));
});

test('storage: 浏览器语义 localStorage 存取（vm 沙箱）', () => {
  const vm = require('vm');
  const sandbox = { window: {}, console, localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); } } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'storage.js'), 'utf-8'), sandbox, { filename: 'storage.js' });
  const ok = sandbox.window.EXFIL_STORAGE.set('test', { a: 1 });
  assert.equal(ok, true);
  // 跨 realm 对象不可 deepEqual（原型不同），逐字段断言
  const got = sandbox.window.EXFIL_STORAGE.get('test');
  assert.equal(got.a, 1);
});
test('storage: Node 路径存取往返（data/local/）', () => {
  const key = 'unit_' + Date.now();
  const ok = Storage.set(key, { money: 500, stash: [1, 2, 3] });
  assert.equal(ok, true);
  const got = Storage.get(key);
  assert.equal(got.money, 500);
  assert.equal(got.stash.length, 3);
  // 清理测试文件
  try { fs.unlinkSync(path.join(__dirname, '..', 'data', 'local', `${key}.json`)); } catch (e) {}
});

// ---------- 弹匣+备弹模型（v0.6.11） ----------
test('弹药模型: 旧格式自动迁移（PM 24 发 → 弹匣 8 + 备弹 16）', () => {
  const { makeWeaponInstance } = require('../shared/items');
  const inst = makeWeaponInstance({ weaponId: 'pm', mods: {}, ammo: { ammoId: '9x18', count: 24 } });
  assert.equal(inst.ammo.count, 8, '弹匣内 8 发');
  assert.equal(inst.ammo.reserve, 16, '备弹 16 发');
});
test('弹药模型: AK 60 发 → 弹匣 30 + 备弹 30', () => {
  const { makeWeaponInstance } = require('../shared/items');
  const inst = makeWeaponInstance({ weaponId: 'ak74', mods: {}, ammo: { ammoId: '545x39', count: 60 } });
  assert.equal(inst.ammo.count, 30);
  assert.equal(inst.ammo.reserve, 30);
});
test('弹药模型: 新格式直接使用（count≤magSize 不迁移）', () => {
  const { makeWeaponInstance } = require('../shared/items');
  const inst = makeWeaponInstance({ weaponId: 'ak74', mods: {}, ammo: { ammoId: '545x39', count: 12, reserve: 40 } });
  assert.equal(inst.ammo.count, 12);
  assert.equal(inst.ammo.reserve, 40);
});
test('弹药模型: ensureLoadable 补满弹匣+一匣备弹', () => {
  const { ensureLoadable } = require('../shared/items');
  const prof = { stash: [{ weaponId: 'ak74', mods: {}, ammo: { ammoId: '545x39', count: 0, reserve: 0 } }] };
  ensureLoadable(prof);
  assert.equal(prof.stash[0].ammo.count, 30);
  assert.equal(prof.stash[0].ammo.reserve, 30);
});
test('武器表: AK-74 射速 650 发/分', () => {
  const { WEAPONS } = require('../shared/items');
  assert.equal(WEAPONS.ak74.fireRate, 650, 'AK-74 应 650 rpm');
});

// ---------- M4 携带机制（2026-09-14 方案 A：按量携带 + 仓库扣除 / 撤离归仓 / 死亡丢失） ----------
const { takeCarry, settleCarry, suggestCarry } = require('../shared/items');

test('携带: takeCarry 按口径从仓库弹药堆叠扣除（不超量，扣空移除条目；ammoLib 为派生）', () => {
  const profile = { name: 'A', money: 0, stash: [{ itemId: '545x39', count: 100 }, { itemId: '9x18', count: 20 }], ammoLib: {} };
  const r = takeCarry(profile, { ammo: { '545x39': 60, '9x18': 999 }, items: [] });
  assert.equal(r.raidAmmo['545x39'], 60, '携带 60 发');
  assert.equal(r.profile.ammoLib['545x39'], 40, '仓库剩 40');
  assert.equal(r.raidAmmo['9x18'], 20, '不超量（库仅 20）');
  assert.equal(r.profile.ammoLib['9x18'], undefined, '扣空删键');
});

test('携带: takeCarry 从仓库扣除物资（不超量，扣空移除条目）', () => {
  const profile = { name: 'A', money: 0, stash: [{ itemId: 'ifak', count: 3 }, { itemId: 'bandage', count: 1 }], ammoLib: {} };
  const r = takeCarry(profile, { ammo: {}, items: [{ itemId: 'ifak', count: 2 }, { itemId: 'bandage', count: 5 }] });
  assert.equal(r.raidItems.length, 2);
  assert.equal(r.raidItems[0].itemId, 'ifak');
  assert.equal(r.raidItems[0].count, 2);
  assert.equal(r.profile.stash.find(s => s.itemId === 'ifak').count, 1, '仓库剩 1');
  assert.equal(r.profile.stash.some(s => s.itemId === 'bandage'), false, '绷带扣空移除');
});

test('携带: takeCarry 不改原档案（纯函数）', () => {
  const profile = { name: 'A', money: 0, stash: [{ itemId: 'ifak', count: 2 }, { itemId: '545x39', count: 50 }], ammoLib: {} };
  const before = JSON.stringify(profile);
  takeCarry(profile, { ammo: { '545x39': 30 }, items: [{ itemId: 'ifak', count: 1 }] });
  assert.equal(JSON.stringify(profile), before, '原档案不变');
});

test('携带: takeCarry 武器槽不参与物资携带', () => {
  const profile = { name: 'A', money: 0, stash: [{ weaponId: 'ak74', ammo: {} }], ammoLib: {} };
  const r = takeCarry(profile, { ammo: {}, items: [{ itemId: 'w_ak74', count: 1 }] });
  assert.equal(r.raidItems.length, 0, '武器不可当物资携带');
  assert.equal(r.profile.stash.length, 1, '仓库武器保留');
});

test('携带: settleCarry 撤离成功 → 局内剩余归仓并集', () => {
  const r = settleCarry({ name: 'A', stash: [{ itemId: '545x39', count: 40 }] }, { extracted: true, raidAmmo: { '545x39': 15 } });
  assert.equal(r.ammoLib['545x39'], 55, '40 + 15 = 55');
});

test('携带: settleCarry 死亡 → 不归还（携带量丢失）', () => {
  const r = settleCarry({ name: 'A', stash: [{ itemId: '545x39', count: 40 }] }, { extracted: false, raidAmmo: { '545x39': 15 } });
  assert.equal(r.ammoLib['545x39'], 40, '仓库不变（携带的 15 丢失）');
});

test('携带: 端到端 撤离 → 净损失 = 局内消耗量', () => {
  const taken = takeCarry({ name: 'A', stash: [{ itemId: '545x39', count: 100 }] }, { ammo: { '545x39': 60 }, items: [] });
  const after = settleCarry(taken.profile, { extracted: true, raidAmmo: { '545x39': 25 } });
  assert.equal(after.ammoLib['545x39'], 65, '100 - 60 + 25 = 65（净耗 35）');
});

test('携带: 端到端 死亡 → 净损失 = 全部携带量', () => {
  const taken = takeCarry({ name: 'A', stash: [{ itemId: '545x39', count: 100 }] }, { ammo: { '545x39': 60 }, items: [] });
  const after = settleCarry(taken.profile, { extracted: false, raidAmmo: { '545x39': 25 } });
  assert.equal(after.ammoLib['545x39'], 40, '100 - 60 = 40（携带 60 全丢）');
});

test('携带: suggestCarry 默认每口径 min(库量, 60) 且物资不带', () => {
  const r = suggestCarry({ stash: [{ itemId: '545x39', count: 100 }, { itemId: '9x18', count: 20 }] });
  assert.equal(r.ammo['545x39'], 60);
  assert.equal(r.ammo['9x18'], 20);
  assert.equal(r.items.length, 0);
});

test('携带: defaultProfile 含 carry 与 ammoLib 初值', () => {
  const p = defaultProfile('测试');
  assert.ok(p.ammoLib, '含 ammoLib');
  assert.ok(p.carry, '含 carry');
  assert.equal(p.carry.ammo && Object.keys(p.carry.ammo).length, 0);
  assert.equal(p.stash.length, 2, '新手仓库仍 2 件');
});

// ---------- 选中态守卫（2026-09-19 缺陷回归） ----------
// 缺陷：selectedIdx 是裸下标，仓库结构变化后不重算 → 悬空/落到杂货上
//       → 整备界面「装备详情」误报「无武器可选」、按钮变「徒手进图」
//       → 表现为「仓库里明明有枪却无法装备」（阵亡为主触发场景）
const { pickWeaponIndex, settleRaid } = require('../shared/items');
const gunStash = () => ([
  { weaponId: 'ak74', mods: {}, ammo: { ammoId: '545x39', count: 30 } },
  { weaponId: 'pm', mods: {}, ammo: { ammoId: '9x18', count: 8 } },
  { weaponId: 'pm', mods: {}, ammo: { ammoId: '9x18', count: 8 } }
]);

test('选中态守卫: 空仓库 / 全杂货 → -1（确实无可装备武器）', () => {
  assert.equal(pickWeaponIndex([], 0), -1);
  assert.equal(pickWeaponIndex(undefined, 3), -1);
  assert.equal(pickWeaponIndex([{ itemId: 'bandage', count: 5 }, { itemId: 'junk', count: 1 }], 0), -1);
});

test('选中态守卫: 原下标仍是有效武器 → 保留（不打断用户已选）', () => {
  assert.equal(pickWeaponIndex(gunStash(), 1), 1);
});

test('选中态守卫【缺陷回归】: 阵亡结算移除所带武器 → 下标不再悬空', () => {
  const after = settleRaid({ name: 'A', stash: gunStash() }, { extracted: false, weaponIdx: 2, inventory: [] });
  assert.equal(after.stash.length, 2, '阵亡移除所带武器');
  assert.equal(after.stash[2], undefined, '旧下标已悬空 —— 缺陷触发条件');
  const fixed = pickWeaponIndex(after.stash, 2);
  assert.equal(fixed, 0, '回落到第一把有效武器');
  assert.equal(after.stash[fixed].weaponId, 'ak74', '守卫给出的下标必须是真实武器');
});

test('选中态守卫: 下标落到杂货上 → 回落到有效武器', () => {
  const stash = [{ itemId: 'bandage', count: 5 }, { itemId: 'junk', count: 1 }, { weaponId: 'pm', mods: {}, ammo: {} }];
  assert.equal(pickWeaponIndex(stash, 0), 2);
});

test('选中态守卫: 未知 weaponId 条目不作为可装备目标', () => {
  const stash = [{ weaponId: 'ghost_gun', mods: {} }, { weaponId: 'sv98', mods: {}, ammo: {} }];
  assert.equal(pickWeaponIndex(stash, 0), 1, '跳过未登记武器，选到真实武器');
});

test('选中态守卫: 出售所选武器后下标越界 → 回落到有效武器', () => {
  const after = { stash: gunStash() };
  after.stash.splice(2, 1);
  assert.equal(pickWeaponIndex(after.stash, 2), 0);
});
