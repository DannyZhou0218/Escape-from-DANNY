'use strict';
/*
 * EXFIL ZONE · 配置层测试（调参引擎的防线）
 * 目的：保证"改 JSON 即调参"这条链路可靠 —— 默认值兜底、覆盖生效、深合并语义、加载顺序。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ConfigLib = require('../shared/config');
const { CFG, DEFAULTS, deepMerge, applyTuning } = ConfigLib;

test('配置: tuning.json 可解析且关键分组齐全', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tuning.json'), 'utf-8'));
  for (const g of ['physics', 'player', 'combat', 'scav', 'items', 'client']) {
    assert.ok(raw[g], `tuning.json 缺少分组 ${g}`);
  }
  assert.ok(raw.scav.weaponPool, 'scav.weaponPool 缺失');
  assert.ok(Array.isArray(raw.client.renderRatioTiers), 'client.renderRatioTiers 缺失');
});

test('配置: content.json 可解析且内容表齐全', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  for (const g of ['weapons', 'ammo', 'mods', 'loot', 'lootPool', 'containers', 'extracts', 'traderGoods']) {
    assert.ok(raw[g], `content.json 缺少 ${g}`);
  }
  assert.ok(Object.keys(raw.weapons).length >= 2, '至少两把武器');
  assert.ok(raw.containers.length >= 1 && raw.extracts.length >= 1);
});

test('配置: 生效值与 JSON 一致（改 JSON 即改生效值）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tuning.json'), 'utf-8'));
  assert.equal(CFG.physics.speed, raw.physics.speed, 'physics.speed 未从 JSON 生效');
  assert.equal(CFG.scav.hp, raw.scav.hp, 'scav.hp 未从 JSON 生效');
  assert.equal(CFG.combat.reloadMs, raw.combat.reloadMs);
  const rawContent = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  assert.ok(CFG.content, 'CFG.content 未加载');
  assert.equal(CFG.content.weapons.ak74.fireRate, rawContent.weapons.ak74.fireRate, '武器表未从 content.json 生效');
});

test('配置: 内容表武器与战利品条目数值一致（防数据不一致复发）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  for (const [wid, w] of Object.entries(raw.weapons)) {
    const lootEntry = raw.loot['w_' + wid];
    if (!lootEntry) continue;
    assert.equal(lootEntry.fireRate, w.fireRate, `${wid} 战利品条目 fireRate 与武器表不一致`);
    assert.equal(lootEntry.dmg, w.dmg, `${wid} 战利品条目 dmg 与武器表不一致`);
    assert.equal(lootEntry.magSize, w.magSize, `${wid} 战利品条目 magSize 与武器表不一致`);
  }
});

test('配置: deepMerge 语义（对象递归/数组替换/注释字段跳过）', () => {
  const base = { a: { x: 1, y: 2 }, arr: [1, 2, 3], s: 'base' };
  const over = { a: { y: 9 }, arr: [7], s: 'over', _注释: 'ignored' };
  const m = deepMerge(base, over);
  assert.equal(m.a.x, 1, '未覆盖的字段保留默认');
  assert.equal(m.a.y, 9, '已覆盖字段生效');
  assert.deepEqual(m.arr, [7], '数组整体替换');
  assert.equal(m.s, 'over');
  assert.equal(m._注释, undefined, '注释字段被跳过');
});

test('配置: 缺字段容错（部分配置不导致崩溃）', () => {
  const partial = { physics: { speed: 9 } };
  const m = deepMerge(DEFAULTS, partial);
  assert.equal(m.physics.speed, 9, '覆盖值生效');
  assert.equal(m.physics.gravity, DEFAULTS.physics.gravity, '缺失字段回退默认');
  assert.ok(m.scav.hp > 0, '其他分组完整');
});

test('配置: applyTuning 热更新（引用不变，模块读取即时生效）', () => {
  const ref = CFG.physics;
  const before = CFG.scav.speed;
  applyTuning({ scav: { speed: 42 } });
  assert.equal(CFG.scav.speed, 42, '热更新生效');
  assert.notEqual(CFG.physics, undefined, 'physics 分组仍存在');
  applyTuning({}); // 复位为默认
  assert.ok(CFG.scav.speed !== 42 || before === 42, '复位后不残留测试值');
});

test('配置: 浏览器语义（无 module）下 config.js 可用且读取下发值', () => {
  const sb = { window: {}, console };
  sb.window = sb;
  sb.window.EXFIL_TUNING = { physics: { speed: 11 }, scav: { hp: 77 } };
  sb.window.EXFIL_CONTENT = { weapons: { ak74: { id: 'ak74', dmg: 99 } } };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf-8'), sb, { filename: 'config.js' });
  const lib = sb.window.EXFIL_CONFIG_LIB;
  assert.ok(lib, 'EXFIL_CONFIG_LIB 未挂载');
  assert.equal(lib.CFG.physics.speed, 11, '下发的 tuning 生效');
  assert.equal(lib.CFG.physics.gravity, DEFAULTS.physics.gravity, '未下发字段用默认');
  assert.equal(lib.CFG.content.weapons.ak74.dmg, 99, '下发的内容表生效');
});

test('配置: index.html 脚本顺序（tuning → content → config → map → core → items）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');
  const order = ['/shared/tuning.js', '/shared/content.js', '/shared/config.js', '/shared/map.js', '/shared/core.js', '/shared/items.js'];
  let last = -1;
  for (const src of order) {
    const idx = html.indexOf(src);
    assert.ok(idx >= 0, `index.html 缺少 ${src}`);
    assert.ok(idx > last, `${src} 顺序错误（必须在上一项之后）`);
    last = idx;
  }
});

test('配置: server.js 提供配置下发与热重载端点', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf-8');
  assert.ok(src.includes("'/shared/tuning.js'"), '缺 tuning 下发路由');
  assert.ok(src.includes("'/shared/content.js'"), '缺 content 下发路由');
  assert.ok(src.includes("'/api/reload-config'"), '缺热重载端点');
  assert.ok(src.includes("'/api/config'"), '缺配置查询端点');
});

test('配置: 热重载必须 fs 直读（require JSON 会命中模块缓存读到旧值）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf-8');
  assert.ok(src.includes('fs.readFileSync'), '必须 fs 直读配置文件');
  assert.ok(!src.includes("require('../config/tuning.json')"), '不得 require tuning.json（模块缓存导致热重载失效）');
  assert.ok(!src.includes("require('../config/content.json')"), '不得 require content.json');
});

test('配置: applyTuning 必须原地更新（保持分组引用，模块即时可见）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf-8');
  assert.ok(src.includes('Object.assign(cur, next)'), 'applyTuning 必须原地合并分组对象');
});

test('配置: 业务代码不得拷贝配置值到模块级常量（热重载失效源）', () => {
  const coreSrc = fs.readFileSync(path.join(ROOT, 'shared', 'core.js'), 'utf-8');
  const simSrc = fs.readFileSync(path.join(ROOT, 'shared', 'sim.js'), 'utf-8');
  assert.ok(coreSrc.includes('const PHYSICS = CFG.physics'), 'core 的 PHYSICS 必须直接引用 CFG.physics');
  assert.ok(!simSrc.includes('const SHOT_COOLDOWN = CFG'), 'sim 不得拷贝战斗常量为模块级常量');
  assert.ok(!simSrc.includes('const RELOAD_MS = CFG'), 'sim 不得拷贝换弹时长为模块级常量');
});

// ---------- M4 内容扩展防线（批次 A：纯数据内容包）----------
test('配置: lootPool 引用的物品必须在 loot 表中存在（防池写错 id）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  for (const [poolName, pool] of Object.entries(raw.lootPool)) {
    assert.ok(Array.isArray(pool), `掉落池 ${poolName} 必须是数组`);
    for (const e of pool) {
      assert.ok(raw.loot[e.item], `掉落池 ${poolName} 引用了不存在的物品 ${e.item}`);
      assert.ok(typeof e.w === 'number' && e.w > 0, `掉落池 ${poolName} 的 ${e.item} 权重非法`);
    }
  }
});

test('配置: 容器 pools 引用的池必须存在于 lootPool（防容器写错池名）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  for (const c of raw.containers) {
    assert.ok(c.id && typeof c.x === 'number' && typeof c.z === 'number', `容器 ${c.id || '?'} 缺坐标`);
    for (const p of (c.pools || [])) {
      assert.ok(raw.lootPool[p], `容器 ${c.id} 引用了不存在的掉落池 ${p}`);
    }
  }
});

test('配置: 商人物资引用的物品必须在 loot 表中存在（防货表写错 id）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  for (const g of raw.traderGoods) {
    assert.ok(raw.loot[g.id], `商人货表引用了不存在的物品 ${g.id}`);
    assert.ok(typeof g.price === 'number' && g.price >= 0, `商人货表 ${g.id} 缺价格`);
  }
});

test('配置: 战利品条目字段完整（price 可卖 / weight 占包 / med 必须有 heal）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  for (const [id, it] of Object.entries(raw.loot)) {
    assert.ok(typeof it.price === 'number' && it.price >= 0, `${id} 缺 price`);
    assert.ok(typeof it.weight === 'number' && it.weight > 0, `${id} 缺 weight`);
    // med 必须有 heal，否则背包「使用」按钮不出现（game.js 按 def.heal 判定）
    if (it.type === 'med') assert.ok(typeof it.heal === 'number' && it.heal > 0, `${id} 是 med 但缺 heal`);
  }
});

test('配置: 撤离点字段完整（坐标/半径/时长）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  for (const e of raw.extracts) {
    assert.ok(e.id && typeof e.x === 'number' && typeof e.z === 'number', `撤离点 ${e.id || '?'} 缺坐标`);
    assert.ok(typeof e.radius === 'number' && e.radius > 0, `撤离点 ${e.id} 缺 radius`);
    assert.ok(typeof e.duration === 'number' && e.duration > 0, `撤离点 ${e.id} 缺 duration`);
  }
});

// ---------- M4 内容扩展防线（批次 B：武器扩展）----------
test('配置: 武器 ammoType 必须在 ammo 表存在（防口径写错）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  for (const [wid, w] of Object.entries(raw.weapons)) {
    assert.ok(raw.ammo[w.ammoType], `武器 ${wid} 引用了不存在的口径 ${w.ammoType}`);
  }
});

test('配置: 弹药箱的 ammoId 必须在 ammo 表存在', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  for (const [id, it] of Object.entries(raw.loot)) {
    if (it.type === 'ammo') assert.ok(raw.ammo[it.ammo.ammoId], `弹药箱 ${id} 引用了不存在的口径 ${it.ammo.ammoId}`);
  }
});

test('配置: 可搜刮武器条目的 weaponId 必须在 weapons 表存在', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  for (const [id, it] of Object.entries(raw.loot)) {
    if (it.type === 'weapon') assert.ok(raw.weapons[it.weaponId], `战利品 ${id} 的 weaponId「${it.weaponId}」不在武器表`);
  }
});

// ---------- 配装系统 P1 防线（D1/D5：尺寸与槽位数据完整、且同名武器一致）----------
test('配装: 全部物品必须有合法 size（D1 真实塔克夫尺寸）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  const tables = ['weapons', 'ammo', 'mods', 'loot'];
  let n = 0;
  for (const t of tables) {
    for (const [id, it] of Object.entries(raw[t] || {})) {
      assert.ok(Array.isArray(it.size) && it.size.length === 2, `${t}.${id} 缺少 size`);
      assert.ok(Number.isInteger(it.size[0]) && it.size[0] >= 1, `${t}.${id} size 宽非法`);
      assert.ok(Number.isInteger(it.size[1]) && it.size[1] >= 1, `${t}.${id} size 高非法`);
      n++;
    }
  }
  assert.ok(n >= 33, `应覆盖全部物品（实际 ${n}）`);
});

test('配装: 同名武器尺寸一致（weapons.<id> ↔ loot.w_<id>）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  for (const [wid, w] of Object.entries(raw.weapons)) {
    const loot = raw.loot['w_' + wid];
    if (!loot) continue;
    assert.deepEqual(loot.size, w.size, `${wid} 与 w_${wid} 尺寸不一致（配装格子会错位）`);
  }
});

test('配装: slot 必须是数组且取值在装备槽集合内（D5：支持复合装备）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  const tuning = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tuning.json'), 'utf-8'));
  const allowed = new Set(tuning.grid.slots);
  for (const t of ['weapons', 'ammo', 'mods', 'loot']) {
    for (const [id, it] of Object.entries(raw[t] || {})) {
      assert.ok(Array.isArray(it.slot), `${t}.${id} 的 slot 必须是数组（D5）`);
      for (const s of it.slot) assert.ok(allowed.has(s), `${t}.${id} 的槽位「${s}」不在允许集合`);
    }
  }
});

test('配装: 武器允许装备槽（至少可进 primary 或 secondary）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  for (const [wid, w] of Object.entries(raw.weapons)) {
    assert.ok(w.slot.includes('primary') || w.slot.includes('secondary'), `武器 ${wid} 无法装备`);
  }
  assert.ok(raw.weapons.pm.slot.includes('secondary') && !raw.weapons.pm.slot.includes('primary'),
    'PM 是手枪，只应进 secondary');
});

test('配装: tuning.json 的 grid 分组齐全（仓库尺寸与装备槽）', () => {
  const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tuning.json'), 'utf-8'));
  assert.ok(t.grid, '缺 grid 分组');
  assert.equal(t.grid.stashW, 10);
  assert.equal(t.grid.stashH, 30);
  assert.equal(t.grid.slots.length, 7, '七个装备槽');
});
