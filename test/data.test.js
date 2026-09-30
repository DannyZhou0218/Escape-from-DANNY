'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadProfile, saveProfile } = require('../server/data');
const Items = require('../shared/items');

const PROFILES = path.join(__dirname, '..', 'data', 'profiles');
function cleanup(id) {
  try { fs.unlinkSync(path.join(PROFILES, id + '.json')); } catch (e) { /* ignore */ }
}

test('data: 新档案默认含一把满弹 PM 手枪', () => {
  const id = '__test_new_' + Date.now();
  try {
    const prof = loadProfile(id, 'T');
    const guns = prof.stash.filter(s => s.weaponId);
    assert.equal(guns.length, 1, '初始应有一把武器');
    assert.equal(guns[0].weaponId, 'pm', '应为 PM');
    assert.equal(guns[0].ammo.count, 24, '满弹 24 发');
  } finally { cleanup(id); }
});
test('data: 空仓库老档案自动迁移补 PM', () => {
  const id = '__test_mig_' + Date.now();
  try {
    saveProfile({ id, name: 'T', money: 1000, stash: [], created: Date.now() });
    const prof = loadProfile(id, 'T');
    assert.ok(prof.stash.some(s => s.weaponId === 'pm'), '空档案应补 PM');
  } finally { cleanup(id); }
});
test('data: 已有武器的档案不被覆盖', () => {
  const id = '__test_keep_' + Date.now();
  try {
    saveProfile({ id, name: 'T', money: 1000, stash: [{ weaponId: 'ak74', mods: {}, ammo: { ammoId: '545x39', count: 30 } }], created: Date.now() });
    const prof = loadProfile(id, 'T');
    assert.equal(prof.stash.length, 1, '不应新增');
    assert.equal(prof.stash[0].weaponId, 'ak74');
  } finally { cleanup(id); }
});
test('items: 单机 defaultProfile 含 PM（初始手枪）', () => {
  const prof = Items.defaultProfile('T');
  assert.ok(prof.stash.some(s => s.weaponId === 'pm'), 'defaultProfile 应含 PM');
});

// ---------- 保底可开火 ensureLoadable（有枪没子弹修复） ----------
test('ensureLoadable: 无武器 → 补满弹 PM', () => {
  const prof = { stash: [] };
  const changed = Items.ensureLoadable(prof);
  assert.equal(changed, true);
  const pm = prof.stash.find(s => s.weaponId === 'pm');
  assert.ok(pm, '应补 PM');
  assert.ok(pm.ammo.count > 0, 'PM 应有弹');
});
test('ensureLoadable: 空弹武器 → 补满弹匣', () => {
  const prof = { stash: [{ weaponId: 'ak74', mods: {}, ammo: { ammoId: '545x39', count: 0 } }] };
  const changed = Items.ensureLoadable(prof);
  assert.equal(changed, true);
  assert.equal(prof.stash[0].ammo.count, 30, 'AK 补满弹匣 30 发');
});
test('ensureLoadable: 有弹武器不覆盖', () => {
  const prof = { stash: [{ weaponId: 'pm', mods: {}, ammo: { ammoId: '9x18', count: 5 } }] };
  const changed = Items.ensureLoadable(prof);
  assert.equal(changed, false);
  assert.equal(prof.stash[0].ammo.count, 5, '不覆盖');
});
test('data: 空弹档案迁移补弹', () => {
  const id = '__test_ammo_' + Date.now();
  try {
    saveProfile({ id, name: 'T', money: 1000, stash: [{ weaponId: 'pm', mods: {}, ammo: { ammoId: '9x18', count: 0 } }], created: Date.now() });
    const prof = loadProfile(id, 'T');
    assert.ok(prof.stash[0].ammo.count > 0, '空弹 PM 应补弹');
  } finally { cleanup(id); }
});
