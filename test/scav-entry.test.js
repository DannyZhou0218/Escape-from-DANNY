// E039 回归防线：SCAV 出征装备抽取 + SCAV 结算语义（不消耗仓库 / 撤离归仓 / 阵亡无损失）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ITEMS = require('../shared/items');
const CFG = require('../shared/config').CFG;

test('E039: randomScavWeapon 按武器池权重抽取（确定性 randFn）', () => {
  const pool = CFG.scav.weaponPool;
  const ids = Object.keys(pool);
  assert.ok(ids.length >= 2, '武器池至少两种');
  const low = ITEMS.randomScavWeapon(() => 0.01);   // 落在第一个权重区间
  const high = ITEMS.randomScavWeapon(() => 0.999); // 落在最后一个
  assert.ok(ids.indexOf(low.weaponId) >= 0, '抽取结果必须来自武器池，实际 ' + low.weaponId);
  assert.ok(ids.indexOf(high.weaponId) >= 0, '抽取结果必须来自武器池，实际 ' + high.weaponId);
  assert.notEqual(low.weaponId, high.weaponId, '两端概率区间应命中不同武器（权重生效）');
});

test('E039: SCAV 武器弹药取该武器默认口径与弹匣容量', () => {
  const w = ITEMS.randomScavWeapon(() => 0.01);
  const def = ITEMS.WEAPONS[w.weaponId];
  assert.equal(w.ammo.ammoId, def.ammoType, '口径必须与内容表一致（' + w.weaponId + '）');
  assert.equal(w.ammo.count, def.magSize, '弹匣容量必须与内容表一致（' + w.weaponId + '）');
  assert.equal(w.ammo.reserve, 0, 'SCAV 不带备弹');
  assert.ok(ITEMS.canFire(w), 'SCAV 出征武器必须能开火（有弹药）');
});

test('E039: 多次抽取始终落在池内（加权随机不越界）', () => {
  const ids = Object.keys(CFG.scav.weaponPool);
  for (let i = 0; i < 300; i++) {
    const w = ITEMS.randomScavWeapon();
    assert.ok(w && ids.indexOf(w.weaponId) >= 0, '第 ' + i + ' 次抽取越界: ' + (w && w.weaponId));
  }
});

test('E039: 旧实现兼容（ak74 走 5.45x39、pm 走 9x18）', () => {
  // 保证下沉到 items.js 后行为与服务器原硬编码一致
  const seen = {};
  for (let i = 0; i < 400; i++) { const w = ITEMS.randomScavWeapon(); seen[w.weaponId] = w.ammo.ammoId; }
  if (seen.ak74) assert.equal(seen.ak74, '545x39', 'AK-74 必须吃 5.45x39');
  if (seen.pm) assert.equal(seen.pm, '9x18', 'PM 必须吃 9x18');
});

test('E039: SCAV 阵亡 → 仓库完全不受损（weaponIdx=-1 语义）', () => {
  const profile = { name: 'A', stash: [{ weaponId: 'ak74', mods: {}, ammo: { ammoId: '545x39', count: 30 } }], ammoLib: { '545x39': 60 } };
  const before = JSON.stringify(profile.stash);
  const after = ITEMS.settleRaid(profile, { extracted: false, weaponIdx: -1, inventory: [] });
  assert.equal(JSON.stringify(after.stash), before, '阵亡时仓库必须原地不动');
});

test('E039: SCAV 撤离成功 → 手持随机装备归仓（+1 把）', () => {
  const profile = { name: 'A', stash: [{ weaponId: 'pm', mods: {}, ammo: { ammoId: '9x18', count: 8 } }], ammoLib: {} };
  const gunsBefore = profile.stash.filter(s => s.weaponId).length;
  const after = ITEMS.settleRaid(profile, {
    extracted: true, weaponIdx: -1,
    inventory: [{ itemId: 'w_ak74', count: 1, isWeapon: true, weaponId: 'ak74', ammoType: '545x39', ammo: { ammoId: '545x39', count: 30 }, mods: {} }]
  });
  const gunsAfter = after.stash.filter(s => s.weaponId).length;
  assert.equal(gunsAfter, gunsBefore + 1, '撤离应把 SCAV 手持枪并入仓库');
  assert.ok(after.stash.some(s => s.weaponId === 'ak74'), '并入的必须是那把 AK-74');
});

test('E039: 危险场景——SCAV 拿 AK 且仓库也有 AK，阵亡不得误删', () => {
  // 修复前 computeRaidOutcome 按「型号相同」判定会返回 weaponIdx=selIdx → 阵亡删掉仓库那把枪
  const profile = { name: 'A', stash: [{ weaponId: 'ak74', mods: {}, ammo: { ammoId: '545x39', count: 30 } }], ammoLib: {} };
  const after = ITEMS.settleRaid(profile, { extracted: false, weaponIdx: -1, inventory: [] });
  assert.equal(after.stash.filter(s => s.weaponId).length, 1, '仓库里那把 AK 必须还在');
});

test('E039: 客户端 SCAV 结算已接入护栏（源码断言）', () => {
  const g = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  assert.ok(g.includes('const sameGun = !isScav &&'), 'computeRaidOutcome 必须用 !isScav 关闭「同型号写回」');
  assert.ok(g.includes('computeRaidOutcome(kind, p, raidWeapon, profile, selectedIdx, raidIsScav)'), 'showSummary 必须把 SCAV 标志传给结算');
  assert.ok(g.includes('if (!raidIsScav) {'), 'SCAV 必须跳过携带归仓（进图未扣除）');
  assert.ok(g.includes('raidIsScav = false;'), '出局必须复位标志');
  assert.ok(/if \(mode === 'online'\) \{\s*if \(roomSnap\) roomScavToggle\(\)/.test(g.replace(/\r\n/g, '\n')), '联机点 SCAV 应走房间内切换');
});

test('E039: 联机 SCAV 入口（房间按钮）接线完整（源码断言）', () => {
  const g = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  const h = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');
  const sv = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf-8');
  assert.ok(h.includes('id="room-scav"'), '房间页必须有 SCAV 开关按钮');
  assert.ok(h.includes('window._exfilRoomScav()'), '按钮必须绑定处理函数');
  assert.ok(g.includes('window._exfilRoomScav = roomScavToggle'), '函数必须暴露到 window');
  assert.ok(g.includes("wsSend({ type: 'setScav'"), '客户端必须发送 setScav 指令');
  assert.ok(sv.includes("msg.type === 'setScav'"), '服务器必须处理 setScav');
  assert.ok(sv.includes('rec.joinMsg.isScav = !!msg.isScav'), '服务器必须写入 SCAV 形态');
});

test('E039: 服务器与客户端共用同一 SCAV 装备抽取实现', () => {
  const sv = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf-8');
  assert.ok(sv.includes('Items.randomScavWeapon()'), '服务器必须委托共享实现（避免双份逻辑漂移）');
  assert.ok(!sv.includes("weaponId: 'ak74', mods: {}, ammo: { ammoId: '545x39'"), '不应再有硬编码武器构造');
});

test('E039: 整备界面 SCAV 按钮不再标注「联机可用」且不按模式禁用', () => {
  const g = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  assert.ok(!g.includes('以 SCAV 身份进入（联机可用）'), 'SCAV 单机已可用，不得再标注「联机可用」（历史误导文案）');
  assert.ok(!g.includes('dom.lobbyEnterScav.disabled = !isOnline'), '不得按模式禁用 SCAV 按钮（E039 缺陷根因）');
  assert.ok(g.includes('dom.lobbyEnterScav.disabled = false'), 'SCAV 按钮必须始终可点');
});

test('E039: 单机 SCAV 结算语义接入完整（源码断言）', () => {
  const g = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  assert.ok(g.includes('startSoloRaid({ weapon: inst, ammo: {}, items: [] })'), '单机 SCAV 必须空弹药库 + 空背包进图（不消耗仓库）');
  assert.ok(!/enterRaidAsScav[\s\S]{0,400}takeCarry\(/.test(g), 'SCAV 进图不得调用 takeCarry（不扣除仓库携带）');
});

// ================= E040：进图流程统一 + 失败兜底 + 真渲染自检 =================
test('E040: SCAV 与 PMC 必须共用同一条进图流程（startSoloRaid）', () => {
  const g = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  const calls = (g.match(/setupSolo\(/g) || []).length - 1; // 减去函数声明本身
  assert.equal(calls, 1, 'setupSolo 只允许在 startSoloRaid 内被调用一次（两条路径不得各写一套），实际 ' + calls);
  assert.ok(/enterRaidSafe\('PMC 进图'/.test(g), 'PMC 必须走统一进图入口');
  assert.ok(/enterRaidSafe\('SCAV 进图'/.test(g), 'SCAV 必须走统一进图入口');
  assert.ok(g.includes('function startSoloRaid'), '必须有统一的单机进图函数');
});

test('E040: 进图异常必须兜底（恢复界面 + 留痕），不得留下白屏', () => {
  const g = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  assert.ok(g.includes('function enterRaidSafe'), '必须有进图兜底函数');
  assert.ok(g.includes('__lastRaidError'), '异常必须留痕，供用户一键反馈');
  assert.ok(/catch[\s\S]{0,320}renderLobby\(\)/.test(g), '兜底必须恢复整备界面（这正是"白屏"的防线）');
});

test('E040: 必须提供真渲染计数（__frames 只证明 rAF 在跑）', () => {
  const g = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  assert.ok(g.includes('window.__renders'), '必须有真渲染计数 __renders');
  assert.ok(/renderer\.render\(scene, camera\);\s*\r?\n\s*window\.__renders/.test(g), '__renders 必须在 renderer.render 之后累加');
  assert.ok(g.includes('renders: window.__renders'), '__exfilState 必须暴露 renders（F12 自检用）');
});
