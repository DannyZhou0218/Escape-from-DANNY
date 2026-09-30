'use strict';
/*
 * EXFIL ZONE · 护甲 / 穿透 / 命中部位测试（v0.15.0 契约 3）
 * ---------------------------------------------------------------------------
 * - 纯函数（baseDamageOf / penOf / hitPartOf / normalizeArmor* / resolveDamage）用
 *   new Function 从 shared/sim.js 的 ARMOR_PURE 区块原文抽取求值（同 realm）——
 *   遵循项目铁律，不使用 vm.runInNewContext。
 * - 集成用例直接驱动 GameSim（真实 CFG / content.json / tuning.json）。
 * - 兼容红线：无护甲目标的实际伤害必须与旧 `inst.dmg` 路径一致。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GameSim } = require('../shared/sim');
const ConfigLib = require('../shared/config');

const ROOT = path.join(__dirname, '..');
const SIM_SRC = fs.readFileSync(path.join(ROOT, 'shared', 'sim.js'), 'utf-8').replace(/\r\n/g, '\n');
const CONTENT = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
const TUNING = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tuning.json'), 'utf-8'));

const near = (a, b, eps) => Math.abs(a - b) < (eps === undefined ? 1e-9 : eps);

// 从 sim.js 抽取纯函数区块并用 new Function 求值（CFG 可注入，隔离真实配置）
function loadPure(CFG) {
  const m = SIM_SRC.match(/\/\/ === ARMOR_PURE_BEGIN ===([\s\S]*?)\/\/ === ARMOR_PURE_END ===/);
  assert.ok(m, 'sim.js 缺少 ARMOR_PURE 区块标记');
  const factory = new Function('CFG',
    m[1] + '\nreturn { combatNum, baseDamageOf, penOf, hitPartOf, normalizeArmorEntry, normalizeArmorState, coversPart, resolveDamage };');
  return factory(CFG);
}
function sandbox(opts) {
  const o = opts || {};
  return loadPure({
    combat: o.combat || {},
    content: { ammo: o.ammo || {}, loot: o.loot || {} }
  });
}
function armorEntry(over) {
  return Object.assign({ itemId: 'test_armor', name: '测试护具', armorClass: 2, durNow: 10, durMax: 10, cover: ['chest'] }, over || {});
}

// ---------- 集成夹具 ----------
function duel(opts) {
  const o = opts || {};
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', o.shooterArmor ? { raidArmor: o.shooterArmor } : {});
  sim.addPlayer('bbbbbb', 'B', o.targetArmor ? { raidArmor: o.targetArmor } : {});
  const a = sim.players.get('aaaaaa');
  const b = sim.players.get('bbbbbb');
  a.weapon = {
    weaponId: 'ak74', name: 'AK-74', dmg: o.dmg === undefined ? 24 : o.dmg,
    fireRate: 650, magSize: 30, slots: [],
    ammo: { ammoId: o.cal === undefined ? '545x39' : o.cal, count: 30 }
  };
  a.yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
  a.pitch = o.pitch || 0;
  return { sim, a, b };
}
const HEAD_PITCH = -0.03; // 10m 水平距离下命中点 y≈1.9（头区 1.8~2.1），躯干为 1.6
function shoot(sim, a) {
  a.lastShot = 0;
  sim.drainEvents();
  sim.handleShoot(a);
  return sim.drainEvents();
}
function hitOf(evs) { return evs.find(e => e.type === 'hit'); }

// ================= 纯函数：baseDamageOf =================
test('护甲纯函数: 弹药 dmg 优先于 weapon.dmg', () => {
  const p = sandbox({ ammo: { A: { dmg: 30 } } });
  assert.equal(p.baseDamageOf('A', { dmg: 99 }), 30);
});
test('护甲纯函数: dmg 缺失回落 weapon.dmg（契约 3.1）', () => {
  const p = sandbox({ ammo: { A: { pen: 5 } } });
  assert.equal(p.baseDamageOf('A', { dmg: 99 }), 99);
});
test('护甲纯函数: 未知/缺省口径回落 weapon.dmg', () => {
  const p = sandbox({});
  assert.equal(p.baseDamageOf('NOPE', { dmg: 99 }), 99);
  assert.equal(p.baseDamageOf(null, { dmg: 7 }), 7);
});
test('护甲纯函数: 弹药 dmg=0 视为缺失 → 回落 weapon.dmg', () => {
  const p = sandbox({ ammo: { A: { dmg: 0 } } });
  assert.equal(p.baseDamageOf('A', { dmg: 99 }), 99);
});

// ================= 纯函数：penOf =================
test('护甲纯函数: pen 缺失视为 0（契约 3.1）', () => {
  const p = sandbox({ ammo: { A: { dmg: 10 } } });
  assert.equal(p.penOf('A'), 0);
});
test('护甲纯函数: pen 原样返回 / 未知口径为 0', () => {
  const p = sandbox({ ammo: { A: { pen: 18 } } });
  assert.equal(p.penOf('A'), 18);
  assert.equal(p.penOf('NOPE'), 0);
});

// ================= 纯函数：hitPartOf =================
test('护甲纯函数: 命中点高于头线 → head，低于 → chest', () => {
  const p = sandbox({});
  assert.equal(p.hitPartOf(1.9, 0, { hitboxTop: 2.1, headZone: 0.3 }), 'head');
  assert.equal(p.hitPartOf(1.79, 0, { hitboxTop: 2.1, headZone: 0.3 }), 'chest');
});
test('护甲纯函数: 恰好等于头线算 head（>= 语义）', () => {
  const p = sandbox({});
  assert.equal(p.hitPartOf(1.8, 0, { hitboxTop: 2.1, headZone: 0.3 }), 'head');
});
test('护甲纯函数: 配置缺失走兜底（hitboxTop 2.1 / headZone 0.3 → 1.8）', () => {
  const p = sandbox({});
  assert.equal(p.hitPartOf(1.85, 0, {}), 'head');
  assert.equal(p.hitPartOf(1.7, 0, {}), 'chest');
});
test('护甲纯函数: 部位判定相对目标脚部高度', () => {
  const p = sandbox({});
  assert.equal(p.hitPartOf(3.9, 2, {}), 'head');
  assert.equal(p.hitPartOf(3.7, 2, {}), 'chest');
});

// ================= 纯函数：无护甲 / 不覆盖 / 耐久=0 =================
test('护甲纯函数: 无护甲 → 全额 base，armorHit=false', () => {
  const p = sandbox({ ammo: { A: { dmg: 24 } } });
  const r = p.resolveDamage('A', { dmg: 99 }, 'chest', null);
  assert.equal(r.dmg, 24);
  assert.equal(r.base, 24);
  assert.equal(r.armorHit, false);
  assert.equal(r.absorbed, 0);
  assert.equal(r.durNow, null);
});
test('护甲纯函数: 爆头无护具照样吃 headMul（默认 2.0）', () => {
  const p = sandbox({ ammo: { A: { dmg: 24 } } });
  const r = p.resolveDamage('A', { dmg: 99 }, 'head', null);
  assert.equal(r.dmg, 48);
  assert.equal(r.part, 'head');
});
test('护甲纯函数: 护具不覆盖该部位 → 全额（头盔不护胸）', () => {
  const p = sandbox({ ammo: { A: { dmg: 24 } } });
  const helm = armorEntry({ cover: ['head'], armorClass: 5, durNow: 40 });
  const r = p.resolveDamage('A', { dmg: 99 }, 'chest', { armor: null, helm: helm });
  assert.equal(r.dmg, 24);
  assert.equal(r.armorHit, false);
  assert.equal(helm.durNow, 40, '未命中的部位不应掉耐久');
});
test('护甲纯函数: 对应护具 durNow=0 失效 → 全额、无损耗', () => {
  const p = sandbox({ ammo: { A: { dmg: 24, pen: 100 } } });
  const e = armorEntry({ durNow: 0 });
  const r = p.resolveDamage('A', { dmg: 99 }, 'chest', { armor: e, helm: null });
  assert.equal(r.dmg, 24);
  assert.equal(r.armorHit, false);
  assert.equal(e.durNow, 0);
});

// ================= 纯函数：穿透 / 阻挡分支 =================
test('护甲纯函数: pen >= armorClass*10 → 穿透（dmg×0.85 / 耐久−base×0.10）', () => {
  const p = sandbox({ ammo: { A: { dmg: 20, pen: 20 } } });
  const e = armorEntry({ armorClass: 2, durNow: 10 });
  const r = p.resolveDamage('A', { dmg: 99 }, 'chest', { armor: e, helm: null });
  assert.ok(near(r.dmg, 17), 'dmg 应为 20×0.85=17，实际 ' + r.dmg);
  assert.ok(near(r.absorbed, 3), '吸收应为 3');
  assert.ok(near(e.durNow, 8), '耐久应为 10−2=8，实际 ' + e.durNow);
  assert.equal(r.armorHit, true);
});
test('护甲纯函数: pen < armorClass*10 → 阻挡（dmg×max(0.10, 0.30−0.03×class) / 耐久−base×0.50）', () => {
  const p = sandbox({ ammo: { A: { dmg: 20, pen: 19 } } });
  const e = armorEntry({ armorClass: 2, durNow: 10 });
  const r = p.resolveDamage('A', { dmg: 99 }, 'chest', { armor: e, helm: null });
  assert.ok(near(r.dmg, 20 * 0.24), 'class2 阻挡系数应为 0.24，实际 ' + r.dmg);
  assert.ok(near(e.durNow, 0), '耐久 10−10=0，实际 ' + e.durNow);
});
test('护甲纯函数: 阻挡系数下限 0.10（高等级护甲）', () => {
  const p = sandbox({ ammo: { A: { dmg: 20, pen: 1 } } });
  const e = armorEntry({ armorClass: 12, durNow: 100 });
  const r = p.resolveDamage('A', { dmg: 99 }, 'chest', { armor: e, helm: null });
  assert.ok(near(r.dmg, 2), '下限 0.10 → 20×0.10=2，实际 ' + r.dmg);
});
test('护甲纯函数: pen 缺失（=0）走阻挡分支而非崩溃', () => {
  const p = sandbox({ ammo: { A: { dmg: 20 } } });
  const e = armorEntry({ armorClass: 1, durNow: 100 });
  const r = p.resolveDamage('A', { dmg: 99 }, 'chest', { armor: e, helm: null });
  assert.equal(r.armorHit, true);
  assert.ok(near(r.dmg, 20 * 0.27), 'class1 阻挡系数 0.27，实际 ' + r.dmg);
});
test('护甲纯函数: 耐久扣减不得为负', () => {
  const p = sandbox({ ammo: { A: { dmg: 100, pen: 1 } } });
  const e = armorEntry({ armorClass: 5, durNow: 1 });
  p.resolveDamage('A', { dmg: 99 }, 'chest', { armor: e, helm: null });
  assert.equal(e.durNow, 0);
});
test('护甲纯函数: 爆头 base（含 headMul）参与护甲吸收与耐久损耗', () => {
  const p = sandbox({ ammo: { A: { dmg: 10, pen: 20 } } }); // base=20（爆头）
  const e = armorEntry({ armorClass: 1, durNow: 10, cover: ['head'] }); // 阈值 10 → 穿透
  const r = p.resolveDamage('A', { dmg: 99 }, 'head', { armor: null, helm: e });
  assert.ok(near(r.dmg, 17), '20×0.85=17');
  assert.ok(near(r.absorbed, 3));
  assert.ok(near(e.durNow, 8), '20×0.10=2 → 10−2=8，实际 ' + e.durNow);
});

// ================= 纯函数：配置缺失兜底 =================
test('护甲纯函数: combat 配置整体缺失 → 全走默认值', () => {
  const p = loadPure({}); // 无 combat / 无 content
  const r = p.resolveDamage('A', { dmg: 10 }, 'chest', { armor: { armorClass: 1, durNow: 5, cover: ['chest'] }, helm: null });
  assert.ok(near(r.dmg, 2.7), '默认 perClass=10 → pen0<10 阻挡；class1 系数 0.27 → 10×0.27=2.7，实际 ' + r.dmg);
});
test('护甲纯函数: content 缺失 → base 回落 weapon.dmg', () => {
  const p = loadPure({});
  assert.equal(p.baseDamageOf('X', { dmg: 7 }), 7);
  const r = p.resolveDamage('X', { dmg: 7 }, 'chest', null);
  assert.equal(r.dmg, 7);
});
test('护甲纯函数: combat 缺 headMul → 默认 2.0；缺 cap 字段不崩', () => {
  const p = sandbox({ combat: { headMul: 3 }, ammo: { A: { dmg: 10 } } });
  assert.equal(p.resolveDamage('A', { dmg: 1 }, 'head', null).dmg, 30);
  const q = sandbox({ combat: {} });
  assert.equal(q.hitPartOf(1.9, 0, {}), 'head');
});

// ================= 纯函数：normalizeArmor* =================
test('护具归一化: 缺失字段从 CFG.content.loot[itemId] 补齐', () => {
  const p = sandbox({ loot: { armor_6b13: { armorClass: 4, dur: 50, cover: ['chest'], name: '6B13 防弹衣' } } });
  const e = p.normalizeArmorEntry({ itemId: 'armor_6b13' });
  assert.equal(e.armorClass, 4);
  assert.equal(e.durMax, 50);
  assert.equal(e.durNow, 50);
  assert.deepEqual(e.cover, ['chest']);
  assert.equal(e.name, '6B13 防弹衣');
});
test('护具归一化: 显式字段优先于内容表', () => {
  const p = sandbox({ loot: { A: { armorClass: 4, dur: 50, cover: ['chest'], name: 'X' } } });
  const e = p.normalizeArmorEntry({ itemId: 'A', armorClass: 2, durMax: 30, durNow: 7, cover: ['head'], name: 'Y' });
  assert.equal(e.armorClass, 2);
  assert.equal(e.durMax, 30);
  assert.equal(e.durNow, 7);
  assert.deepEqual(e.cover, ['head']);
  assert.equal(e.name, 'Y');
});
test('护具归一化: durNow 夹在 [0,durMax] / durMax 缺省时取 durNow', () => {
  const p = sandbox({});
  assert.equal(p.normalizeArmorEntry({ itemId: 'A', durNow: -5, durMax: 10 }).durNow, 0);
  assert.equal(p.normalizeArmorEntry({ itemId: 'A', durNow: 999, durMax: 10 }).durNow, 10);
  assert.equal(p.normalizeArmorEntry({ itemId: 'A', durNow: 12 }).durMax, 12);
});
test('护具归一化: {armor,helm} 状态对象直通', () => {
  const p = sandbox({});
  const st = p.normalizeArmorState({ armor: { itemId: 'A', durNow: 3, durMax: 30, armorClass: 2, cover: ['chest'] }, helm: null });
  assert.equal(st.armor.durNow, 3);
  assert.equal(st.armor.durMax, 30);
  assert.equal(st.helm, null);
});
test('护具归一化: 条目数组按 cover/slot 自动分槽', () => {
  const p = sandbox({});
  const st = p.normalizeArmorState([
    { itemId: 'A', armorClass: 2, durMax: 30, cover: ['chest'] },
    { itemId: 'H', armorClass: 2, durMax: 20, cover: ['head'] }
  ]);
  assert.equal(st.armor.itemId, 'A');
  assert.equal(st.helm.itemId, 'H');
});
test('护具归一化: 单条目按槽位落位；null → 双 null', () => {
  const p = sandbox({});
  assert.equal(p.normalizeArmorState({ itemId: 'H', armorClass: 2, durMax: 20, cover: ['head'] }).helm.itemId, 'H');
  assert.deepEqual(p.normalizeArmorState(null), { armor: null, helm: null });
});

// ================= 集成：进图初始化 / 快照 =================
test('集成: addPlayer raidArmor 初始化（内容表兜底）且快照 armor 只含 durNow', () => {
  const { b, sim } = duel({ targetArmor: { armor: { itemId: 'armor_6b13', durNow: 35 } } });
  assert.equal(b.armor.armor.armorClass, 4, 'armorClass 应从 content.loot 补齐');
  assert.equal(b.armor.armor.durMax, 50);
  assert.deepEqual(b.armor.armor.cover, ['chest']);
  assert.equal(b.armor.helm, null);
  const snap = sim.snapshot().players.find(p => p.id === 'bbbbbb');
  assert.deepEqual(snap.armor, { armor: 35, helm: null });
  assert.ok('hp' in snap && 'alive' in snap && 'ammoLib' in snap, '快照既有字段不得消失');
});
test('集成: 无护甲玩家快照 armor = { armor:null, helm:null }', () => {
  const { sim } = duel({});
  const snap = sim.snapshot().players.find(p => p.id === 'bbbbbb');
  assert.deepEqual(snap.armor, { armor: null, helm: null });
});
test('集成: setArmor 运行时替换（含内容表兜底）', () => {
  const { sim, b } = duel({});
  const st = sim.setArmor('bbbbbb', { armor: { itemId: 'armor_paca', durNow: 10 } });
  assert.equal(st.armor.armorClass, 2);
  assert.equal(st.armor.durMax, 30);
  assert.equal(b.armor.armor.durNow, 10);
});

// ================= 集成：兼容红线 + 各分支 =================
test('兼容红线: 无甲目标实际伤害 === 旧 inst.dmg 路径（545 胸击 24）', () => {
  const { sim, a, b } = duel({});
  const hit = hitOf(shoot(sim, a));
  assert.equal(hit.dmg, 24, '无护甲伤害必须与改动前 inst.dmg 一致');
  assert.equal(b.hp, 76);
  assert.equal(hit.part, 'chest');
  assert.equal(hit.armorHit, false);
  assert.equal(hit.absorbed, 0);
  assert.equal(hit.durNow, null);
});
test('兼容红线: 口径缺失时回落到武器 dmg（老路径语义）', () => {
  const { sim, a, b } = duel({ cal: 'no_such_cal', dmg: 33 });
  const hit = hitOf(shoot(sim, a));
  assert.equal(hit.dmg, 33);
  assert.equal(b.hp, 67);
});
test('集成: 护甲阻挡分支 — 事件字段 / 耐久扣减 / hp 一致（6B13 挡 545）', () => {
  const { sim, a, b } = duel({ targetArmor: { armor: { itemId: 'armor_6b13', durNow: 50, durMax: 50 } } });
  const hit = hitOf(shoot(sim, a));
  assert.equal(hit.part, 'chest');
  assert.equal(hit.armorHit, true);
  assert.ok(near(hit.dmg, 24 * 0.18), 'dmg 应为 4.32，实际 ' + hit.dmg);
  assert.ok(near(hit.absorbed, 24 - 24 * 0.18));
  assert.ok(near(hit.durNow, 38), '耐久 50−12=38，实际 ' + hit.durNow);
  assert.ok(near(b.hp, 100 - hit.dmg));
  assert.equal(b.armor.armor.durNow, 38);
});
test('集成: 护甲穿透分支 — pen>=class*10（PACA 被 545 穿透）', () => {
  const { sim, a, b } = duel({ targetArmor: { armor: { itemId: 'armor_paca', durNow: 30, durMax: 30 } } });
  const hit = hitOf(shoot(sim, a));
  assert.equal(hit.armorHit, true);
  assert.ok(near(hit.dmg, 24 * 0.85), 'dmg 应为 20.4，实际 ' + hit.dmg);
  assert.ok(near(hit.durNow, 30 - 2.4), '耐久 27.6，实际 ' + hit.durNow);
  assert.ok(near(b.hp, 100 - 20.4));
});
test('集成: 爆头 headMul（无护甲 24→48）', () => {
  const { sim, a, b } = duel({ pitch: HEAD_PITCH });
  const hit = hitOf(shoot(sim, a));
  assert.equal(hit.part, 'head');
  assert.equal(hit.dmg, 48);
  assert.equal(b.hp, 52);
});
test('集成: 头盔只护头 — 胸击全额且头盔不掉耐久；头击才吃头盔', () => {
  const { sim, a, b } = duel({ targetArmor: { helm: { itemId: 'helm_alt', durNow: 40, durMax: 40 } } });
  const chestHit = hitOf(shoot(sim, a)); // pitch 0 → 胸
  assert.equal(chestHit.part, 'chest');
  assert.equal(chestHit.dmg, 24);
  assert.equal(chestHit.armorHit, false);
  assert.equal(b.armor.helm.durNow, 40, '胸击不得消耗头盔耐久');
  a.pitch = HEAD_PITCH;
  const headHit = hitOf(shoot(sim, a));
  assert.equal(headHit.part, 'head');
  assert.equal(headHit.armorHit, true);
  assert.ok(near(headHit.dmg, 48 * 0.15), 'Altyn class5 阻挡系数 0.15 → 7.2，实际 ' + headHit.dmg);
  assert.equal(b.armor.helm.durNow, 16, '头击 40−24=16');
});
test('集成: 耐久归零后护甲失效（第二枪全额）', () => {
  const { sim, a, b } = duel({ targetArmor: { armor: { itemId: 'armor_6b13', durNow: 8, durMax: 50 } } });
  const first = hitOf(shoot(sim, a));
  assert.equal(first.armorHit, true);
  assert.equal(first.durNow, 0, '耐久不得为负');
  const second = hitOf(shoot(sim, a));
  assert.equal(second.armorHit, false);
  assert.equal(second.dmg, 24);
  assert.equal(second.durNow, 0);
});
test('集成: hit 事件保留旧字段（shooter/target/dmg/hp/alive）并只增新字段', () => {
  const { sim, a } = duel({});
  const hit = hitOf(shoot(sim, a));
  for (const k of ['shooter', 'target', 'dmg', 'hp', 'alive']) assert.ok(k in hit, '缺少既有字段 ' + k);
  assert.equal(typeof hit.part, 'string');
  assert.equal(typeof hit.armorHit, 'boolean');
  assert.equal(typeof hit.absorbed, 'number');
  assert.ok(hit.durNow === null || typeof hit.durNow === 'number');
});

// ================= 数据 / 配置锁 =================
test('数据锁: 五种弹药 dmg 与对应武器 dmg 一致（无甲伤害向后兼容数据源）且 pen 存在', () => {
  for (const cal of ['545x39', '9x18', '762x39', '919', '762x54']) {
    assert.ok(CONTENT.ammo[cal], cal + ' 缺 ammo 定义');
    assert.equal(typeof CONTENT.ammo[cal].dmg, 'number', cal + ' 缺 dmg');
    assert.equal(typeof CONTENT.ammo[cal].pen, 'number', cal + ' 缺 pen');
  }
  for (const [wid, w] of Object.entries(CONTENT.weapons)) {
    assert.equal(CONTENT.ammo[w.ammoType].dmg, w.dmg,
      `${w.ammoType} dmg 必须等于 ${wid}.dmg（否则无甲伤害与改动前不一致）`);
  }
});
test('数据锁: 护甲/头盔 armorClass+dur+cover 齐全（头盔 head / 护甲 chest）', () => {
  const chest = ['armor_paca', 'armor_6b13'];
  const head = ['helm_ssh68', 'helm_alt'];
  for (const id of chest.concat(head)) {
    const it = CONTENT.loot[id];
    assert.ok(it, id + ' 缺失');
    assert.equal(typeof it.armorClass, 'number', id + ' 缺 armorClass');
    assert.ok(it.dur > 0, id + ' 缺 dur');
    assert.deepEqual(it.cover, [chest.indexOf(id) >= 0 ? 'chest' : 'head'], id + ' cover 错误');
    assert.ok(!/防护系统待做/.test(it.desc || ''), id + ' desc 未更新为已实现');
  }
});
test('配置锁: tuning.json combat 暴露契约 3.5 全部字段 + sim 读到的 CFG 一致', () => {
  const keys = ['headMul', 'armorPenPerClass', 'penetratedMul', 'blockedMulBase', 'blockedMulPerClass', 'blockedMulMin', 'durLossPen', 'durLossBlock'];
  for (const k of keys) {
    assert.equal(typeof TUNING.combat[k], 'number', 'tuning.combat.' + k + ' 缺失');
    assert.equal(typeof ConfigLib.CFG.combat[k], 'number', 'CFG.combat.' + k + ' 未生效');
  }
  assert.ok(TUNING.combat.hitboxTop > 0 && TUNING.combat.headZone > 0, 'hitboxTop/headZone 配置缺失');
});

test('兼容红线（真实武器实例）: 五种武器无甲命中 dmg === inst.dmg（RVP A5c 隐性依赖）', () => {
  const ITEMS = require('../shared/items');
  for (const wid of ['ak74', 'pm', 'akm', 'mp5', 'sv98']) {
    const def = CONTENT.weapons[wid];
    const inst = ITEMS.makeWeaponInstance({ weaponId: wid, mods: {}, ammo: { ammoId: def.ammoType, count: 30, reserve: 0 } });
    const { sim, a, b } = duel({ dmg: def.dmg, cal: def.ammoType });
    a.weapon = inst; // 真实武器实例（来自 shared/items 的 WEAPONS 表）
    const hit = hitOf(shoot(sim, a));
    assert.equal(hit.dmg, inst.dmg, `${wid} 无甲伤害必须等于 inst.dmg`);
    assert.equal(b.hp, 100 - inst.dmg, `${wid} 血量扣减应与 inst.dmg 一致`);
    assert.equal(hit.part, 'chest');
  }
});
