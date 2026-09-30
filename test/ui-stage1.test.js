/*
 * EXFIL ZONE · 第三线程（前端 UI）阶段一新增防线 · 2026-09-13
 * ---------------------------------------------------------------
 * 背景：原有 test/browser-semantic.test.js 只锁「源码字面文本」，锁不住行为
 *       （BUG-1 因此长期未被捕获）。本文件补充**行为断言**：
 *         ① DOM 注册表完整性（id 真实存在 + 无散落裸查询）
 *         ② 局内事件分发表覆盖度（防将来新增 sim 事件漏接）
 *         ③ SCAV 同步单一实现（单机/联机合并后防再度分叉）
 *         ④ computeRaidOutcome 纯函数行为（可独立求值 = 真的是纯函数）
 * 说明：本文件为**新增**防线。③ 落地时按用户批准方案 A，修订了
 *       browser-semantic.test.js 中「锁定实现形态」的 `_shownHp >= 4` 断言（→ >= 2），
 *       该断言原意是「同步逻辑须跟踪 _shownHp」，与本文件 ③ 两条断言共同守护。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const gameSrc = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');

// ================= ① DOM 注册表 =================
test('阶段一①: DOM 注册表引用的 id 必须真实存在（index.html 静态 或 动态白名单）', () => {
  const htmlIds = new Set([...htmlSrc.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // 运行时动态创建（renderLobby 模板字符串 / innerHTML），非 index.html 静态 id
  const DYN = new Set(['sell-weapon-btn', 'inv-empty']);
  const used = [...new Set([...gameSrc.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))];
  const missing = used.filter((id) => !htmlIds.has(id) && !DYN.has(id));
  assert.deepEqual(missing, [], `DOM 注册表引用了不存在的 id: ${missing.join(', ')}`);
});

test('阶段一①: 动态元素必须走 dyn() 统一入口（dom 块之外不得散落裸 getElementById）', () => {
  const lines = gameSrc.split(/\r?\n/);
  const domStart = lines.findIndex((l) => l.startsWith('const dom = {'));
  const domEnd = lines.findIndex((l) => l.includes('function dyn(id)'));
  assert.ok(domStart >= 0 && domEnd > domStart, '未能定位 dom 注册表块');
  const outside = [];
  for (let i = 0; i < lines.length; i++) {
    if (i >= domStart && i <= domEnd) continue; // 注册表自身与 dyn() 定义
    if (lines[i].includes('document.getElementById')) outside.push(`L${i + 1}: ${lines[i].trim()}`);
  }
  assert.deepEqual(outside, [], `dom 块之外仍有裸 getElementById:\n${outside.join('\n')}`);
});

// ================= ② 事件分发表 =================
test('阶段一②: 局内事件分发表必须覆盖全部 20 类 sim 事件', () => {
  // P4 起新增 equipped：sim.useItem 会 emit('equipped')，此前只在 consumePendingUI 里散落处理，
  // 已收进统一分发表（覆盖增强，非放宽防线）
  // E043 新增 containerOpened / containerLootChanged：塔科夫式逐件搜刮（sim 新增对应 emit）
  const EXPECTED = [
    'hit', 'scavDead', 'reloadStart', 'reloadDone', 'sound', 'scavAlert',
    'ammo', 'ammoRefilled', 'empty', 'invChanged', 'containerLooted', 'invFull',
    'usedItem', 'equipped', 'containerOpened', 'containerLootChanged',
    'extractStart', 'extractProgress', 'extractCancel', 'extractSuccess'
  ];
  const m = gameSrc.match(/const SIM_EVENT_HANDLERS = \{([\s\S]*?)\r?\n\};/);
  assert.ok(m, '未找到 SIM_EVENT_HANDLERS 分发表');
  const keys = [...m[1].matchAll(/^  (\w+):/gm)].map((x) => x[1]);
  const missing = EXPECTED.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !EXPECTED.includes(k));
  assert.deepEqual(missing, [], `分发表缺少事件: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `分发表多了未预期事件: ${extra.join(', ')}`);
  assert.equal(keys.length, EXPECTED.length, `事件数应为 ${EXPECTED.length}，实际 ${keys.length}`);
});

test('阶段一②: soloStep 必须经 dispatchSimEvent 统一分发（不再内联 if/else 链）', () => {
  assert.ok(
    gameSrc.includes('for (const ev of sim.drainEvents()) dispatchSimEvent(ev);'),
    'soloStep 事件消费应改为 dispatchSimEvent 统一分发'
  );
});

// ================= ④ 结算纯函数 =================
const FN = (() => {
  // E039 注：签名随功能扩展（新增 isScav）；此处**不锁参数列表**——断言意图是「能独立求值」，
  // 每加一个参数就断会把防线变成绊脚石。若函数不再可抽取，本断言仍会失败。
  const m = gameSrc.match(/function computeRaidOutcome\([^)]*\) \{[\s\S]*?\r?\n\}/);
  if (!m) return null;
  // 从源码中单独取出函数体求值：能跑通即证明它不依赖模块状态 / DOM
  // 用 new Function（同 realm）而非 vm 沙箱——跨 realm 会让对象原型不同，deepStrictEqual 会误判
  return new Function('return (' + m[0] + ')')();
})();

test('阶段一④: computeRaidOutcome 可独立求值（真纯函数，不依赖模块状态/DOM）', () => {
  assert.ok(FN, '未找到 computeRaidOutcome');
  assert.equal(typeof FN, 'function');
  const out = FN('success', { inventory: [] }, { weaponId: 'pm', ammo: { ammoId: '9x18', count: 8 } },
                 { stash: [{ weaponId: 'pm' }] }, 0);
  assert.equal(out.extracted, true);
  assert.equal(out.weaponIdx, 0, '同枪撤离应写回原槽位');
  assert.deepEqual(out.weaponAmmo, { ammoId: '9x18', count: 8 });
});

test('阶段一④: 局内换枪 → weaponIdx=-1（原仓库武器不写回）', () => {
  const out = FN('success', { inventory: [] }, { weaponId: 'ak74', ammo: { ammoId: '545x39', count: 30 } },
                 { stash: [{ weaponId: 'pm' }] }, 0);
  assert.equal(out.weaponIdx, -1, '换枪后不得写回原槽位');
  assert.deepEqual(out.weaponAmmo, { ammoId: '545x39', count: 30 }, '弹药应记录当前持有枪');
});

test('阶段一④: 阵亡 → extracted=false，且武器数据仍如实记录', () => {
  const out = FN('death', { inventory: [] }, { weaponId: 'pm', ammo: { ammoId: '9x18', count: 3 } },
                 { stash: [{ weaponId: 'pm' }] }, 0);
  assert.equal(out.extracted, false);
  assert.deepEqual(out.weaponAmmo, { ammoId: '9x18', count: 3 });
});

test('阶段一④: 背包条目映射（武器保留完整字段 / 普通物品仅 itemId+count）', () => {
  const inv = [
    { itemId: 'w_ak74', count: 1, isWeapon: true, weaponId: 'ak74', ammoType: '545x39', ammo: { ammoId: '545x39', count: 12 }, mods: { sight: 'pso' } },
    { itemId: 'bandage', count: 3 },
    { itemId: 'gold_chain', count: 1 }
  ];
  const out = FN('success', { inventory: inv }, null, { stash: [] }, -1);
  const w = out.inventory[0];
  assert.equal(w.isWeapon, true);
  assert.equal(w.weaponId, 'ak74');
  assert.deepEqual(w.ammo, { ammoId: '545x39', count: 12 }, '武器弹药字段应完整保留');
  assert.deepEqual(w.mods, { sight: 'pso' }, '改装件应保留');
  assert.deepEqual(out.inventory[1], { itemId: 'bandage', count: 3 }, '普通物品仅留 itemId/count');
  assert.deepEqual(out.inventory[2], { itemId: 'gold_chain', count: 1 });
  assert.equal(out.inventory.length, 3);
  // 无武器时 weaponAmmo 应为 null
  assert.equal(out.weaponAmmo, null);
});

test('阶段一④: 不修改任何入参（无副作用）', () => {
  const inv = [{ itemId: 'bandage', count: 2 }];
  const weapon = { weaponId: 'pm', ammo: { ammoId: '9x18', count: 8 }, mods: { sight: 'none' } };
  const prof = { stash: [{ weaponId: 'pm' }] };
  const snap = JSON.stringify([inv, weapon, prof]);
  FN('success', { inventory: inv }, weapon, prof, 0);
  assert.equal(JSON.stringify([inv, weapon, prof]), snap, '纯函数不得修改入参');
});

// ================= ③ SCAV 同步单一实现（防再度分叉） =================
test('阶段一③: SCAV 同步必须为单一实现（禁止再分叉为两份）', () => {
  assert.ok(!gameSrc.includes('syncScavsFromSnapshot'), '联机同步不得再单独实现（应已合并进 syncScavs）');
  assert.ok(/function syncScavs\(list, trackState\)/.test(gameSrc), '必须存在统一的 syncScavs(list, trackState)');
  const defs = gameSrc.match(/function syncScavs\w*\(/g) || [];
  assert.ok(defs.length <= 2, `同步实现不得超过 2 个（主函数 + 单机薄封装），实际 ${defs.length}: ${defs.join(', ')}`);
});

test('阶段一③: 单机/联机两条路径必须调用同一函数（数据源与 trackState 参数化）', () => {
  assert.ok(gameSrc.includes('syncScavs(sim.scavs.values(), true)'), '单机路径必须走 syncScavs(..., true)');
  const online = (gameSrc.match(/syncScavs\(m\.scavs, false\)/g) || []).length;
  assert.equal(online, 2, `联机路径应有 2 处调用 syncScavs(..., false)，实际 ${online}`);
});
