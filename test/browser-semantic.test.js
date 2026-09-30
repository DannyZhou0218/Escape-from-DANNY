/*
 * EXFIL ZONE · 浏览器语义测试（E010/E011 教训固化）
 * Node require 测试测不到浏览器差异（全局作用域/无 module），必须用 vm 沙箱模拟。
 * 任何 shared/ 或 public/ 改动后，npm test 会自动执行本文件。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 加载顺序即 index.html 的 script 顺序：tuning(下发) → config → map → core → bt → sim → items → storage
const SHARED = ['config', 'map', 'core', 'bt', 'sim', 'items', 'storage', 'grid', 'containers', 'loadout', 'raidinv'];

// 创建"真实浏览器语义"沙箱：无 module、无 require、共享全局、有 window
// 并模拟服务器 /shared/tuning.js 下发 window.EXFIL_TUNING（config.js 的外部配置来源）
function browserSandbox() {
  const sandbox = { window: {}, console };
  sandbox.window = sandbox;
  sandbox.window.EXFIL_TUNING = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tuning.json'), 'utf-8'));
  sandbox.window.EXFIL_CONTENT = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content.json'), 'utf-8'));
  vm.createContext(sandbox);
  return sandbox;
}
function loadSharedInBrowser(sandbox) {
  for (const m of SHARED) {
    const code = fs.readFileSync(path.join(ROOT, 'shared', `${m}.js`), 'utf-8');
    vm.runInContext(code, sandbox, { filename: `${m}.js` });
  }
}

test('E011 回归：shared 全部模块在浏览器语义（无 module）下可执行且挂载', () => {
  const sb = browserSandbox();
  loadSharedInBrowser(sb);
  assert.ok(sb.window.EXFIL_MAP, 'EXFIL_MAP 未挂载');
  assert.ok(sb.window.EXFIL_CORE, 'EXFIL_CORE 未挂载');
  assert.ok(sb.window.EXFIL_SIM, 'EXFIL_SIM 未挂载');
  assert.ok(sb.window.EXFIL_ITEMS, 'EXFIL_ITEMS 未挂载');
  assert.ok(sb.window.EXFIL_GRID, 'EXFIL_GRID 未挂载');
  // P1：浏览器语义下 grid 必须能读到物品尺寸（依赖 items 已挂载）
  // 注意：vm 沙箱与宿主 realm 不同，跨 realm 数组不能用 deepStrictEqual（原型不同会误报）→ 逐个标量比对
  assert.ok(sb.window.EXFIL_LOADOUT, 'EXFIL_LOADOUT 未挂载');
  const sz = sb.window.EXFIL_GRID.itemSize('w_ak74');
  assert.equal(sz[0], 5, '浏览器语义下 grid 尺寸查表失效（宽）');
  assert.equal(sz[1], 2, '浏览器语义下 grid 尺寸查表失效（高）');
  assert.ok(sb.window.EXFIL_STORAGE, 'EXFIL_STORAGE 未挂载');
  assert.ok(sb.window.EXFIL_CONFIG_LIB, 'EXFIL_CONFIG_LIB 未挂载');
  assert.ok(sb.window.EXFIL_CONFIG_LIB.CFG.physics.speed > 0, '配置层未生效（physics.speed 缺失）');
  // 三件套挂载对象应指向同一地图数据
  assert.equal(sb.window.EXFIL_CORE.MAP.length, sb.window.EXFIL_MAP.MAP_RAW.length);
});

test('E011 回归：同一全局作用域重复加载不冲突（IIFE 幂等）', () => {
  const sb = browserSandbox();
  loadSharedInBrowser(sb);
  loadSharedInBrowser(sb); // 二次加载（模拟页面重载同一全局）不应抛 SyntaxError
  assert.ok(sb.window.EXFIL_CORE && sb.window.EXFIL_SIM, '二次加载后挂载仍存在');
});

test('E011 回归：浏览器语义下 GameSim 可跑完整 tick', () => {
  const sb = browserSandbox();
  loadSharedInBrowser(sb);
  const sim = new sb.window.EXFIL_SIM.GameSim({ testMode: false });
  sim.addPlayer('solo', 'T');
  sim.applyInput('solo', { keys: { f: 1, b: 0, l: 0, r: 0 }, yaw: 0, pitch: 0 });
  for (let i = 0; i < 60; i++) sim.tick(1 / 60);
  const p = sim.players.get('solo');
  assert.ok(Math.hypot(p.x, p.z) > 1, '浏览器语义下移动正常');
});

test('E010 回归：index.html 资源依赖图完整（每个 script src 可解析）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');
  const srcs = [...html.matchAll(/src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(srcs.length >= 3, `shared 三件套应为 3 个 src 资源（实际 ${srcs.length}）`);
  // game.js 通过 ES module import 引用（非 src 属性），单独验证
  assert.ok(html.includes("from './game.js'"), '缺少 game.js module import');
  for (const src of srcs) {
    if (src === '/shared/tuning.js' || src === '/shared/content.js') continue; // 服务器动态路由（读 config/*.json 生成），非静态文件
    if (src.startsWith('/shared/')) {
      const file = path.join(ROOT, 'shared', src.replace('/shared/', ''));
      assert.ok(fs.existsSync(file), `shared 资源缺失: ${src}`);
    } else if (src.startsWith('/vendor/')) {
      const file = path.join(ROOT, 'node_modules', src.replace('/vendor/', ''));
      assert.ok(fs.existsSync(file), `vendor 资源缺失: ${src}`);
    } else if (src.startsWith('./')) {
      const file = path.join(ROOT, 'public', src.replace('./', ''));
      assert.ok(fs.existsSync(file), `本地资源缺失: ${src}`);
    }
  }
});

test('E010 回归：index.html 必须引用全部 shared 模块（单机依赖）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');
  for (const m of SHARED) {
    assert.ok(html.includes(`/shared/${m}.js`), `index.html 缺少 /shared/${m}.js`);
  }
  assert.ok(html.includes('enter-solo'), '缺少单机入口按钮');
});

// ---------- E012 回归：第一人称持枪模型渲染依赖 ----------
test('E012 回归：相机必须挂进场景图（持枪模型才可见）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  assert.ok(src.includes('scene.add(camera)'), 'game.js 必须 scene.add(camera)——相机子对象（枪模型）依赖场景图渲染');
  assert.ok(src.includes('camera.add(gunMesh)'), 'attachGun 必须 camera.add(gunMesh)');
  assert.ok(src.includes("(weaponDef.id || weaponDef.weaponId)"), 'buildGunMesh 必须兼容 weaponId 字段（PM 判断）');
});

// ---------- v0.5.3 回归：开火反馈 = 后坐力（非全屏闪） ----------
test('v0.5.3 回归：开火反馈走后坐力，无全屏闪', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');
  assert.ok(src.includes('applyRecoil()'), 'fireFeedback 必须触发后坐力');
  assert.ok(!src.includes('shotflash'), 'game.js 不得残留闪屏引用');
  assert.ok(!html.includes('shotflash'), 'index.html 不得残留闪屏元素');
  assert.ok(src.includes('recoilPitch'), '必须有视角后坐状态');
  assert.ok(src.includes('gunKick'), '必须有枪模型后坐状态');
});

// ---------- E017 回归：卖枪不用 confirm（iframe 沙箱禁用）+ 尸体武器不被弹药逻辑吞 ----------
test('E017 回归：卖枪双态确认（禁 confirm/必需 sell-weapon-btn）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  assert.ok(!src.includes('confirm('), 'game.js 不得使用 confirm()（iframe 沙箱禁用会静默失败）');
  assert.ok(src.includes('_exfilSellWeapon'), '卖枪函数必须存在');
  assert.ok(src.includes('sell-weapon-btn'), '卖枪按钮必须有 id（双态确认锚点）');
  assert.ok(src.includes('__sellArmed'), '必须双态确认');
});
test('E017 回归：interactContainer 弹药自动补备弹必须排除武器条目', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared', 'sim.js'), 'utf-8');
  assert.ok(src.includes('item.isWeapon || !item.ammo'), '弹药拆包判断必须排除 isWeapon（尸体武器含 ammo 字段）——E045 后收敛到 _unwrapAmmo');
});

// ---------- E018 回归：跳跃上升不被吸附（闪回） + 射速按武器 ----------
test('E018 回归：垂直吸附必须限 vy<=0（三处）', () => {
  const simSrc = fs.readFileSync(path.join(ROOT, 'shared', 'sim.js'), 'utf-8');
  const gameSrc = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  assert.ok(simSrc.includes('p.y < gy && p.vy <= 0'), 'sim 玩家吸附必须限 vy<=0');
  assert.ok(simSrc.includes('e.y < gy && e.vy <= 0'), 'sim moveEntity 吸附必须限 vy<=0');
  const predSrc = fs.readFileSync(path.join(ROOT, 'shared', 'predict.js'), 'utf-8');
  assert.ok(predSrc.includes('state.y < gy && state.vy <= 0'), 'predict.js 预测吸附必须限 vy<=0（联机预测已迁至该模块）');
});
test('v0.6.16 回归：射击冷却必须用武器 fireRate', () => {
  const simSrc = fs.readFileSync(path.join(ROOT, 'shared', 'sim.js'), 'utf-8');
  assert.ok(simSrc.includes('60000 / inst.fireRate'), '冷却必须按武器射速换算（60000/fireRate）');
});

// ---------- v0.6.17 回归：SCAV 名字 hp 数字必须随血量刷新（命中不扣血错觉根因） ----------
test('v0.6.17 回归：SCAV 名字标签 hp 随血量刷新（_shownHp）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  assert.ok(src.includes('_shownHp !== s.hp'), '名字标签必须跟踪 _shownHp（血量变化时重建）');
  assert.ok(src.includes('_shownHp = s.hp'), '必须记录 _shownHp');
  // 阶段一③（用户批准方案 A）：单机/联机同步已合并为单一 syncScavs 实现，
  // 故旧「两处各 2 次 → >= 4」锁定的是实现形态而非行为；修订为断言行文本意：同步逻辑必须跟踪 _shownHp。
  const occurrences = (src.match(/_shownHp/g) || []).length;
  assert.ok(occurrences >= 2, `SCAV 同步逻辑必须跟踪 _shownHp（血量变化时重建标签；实际 ${occurrences} 处）`);
});
test('v0.6.17 回归：命中提示必须节流（连发不刷屏）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  assert.ok(src.includes('__lastHitToast'), '命中 toast 必须节流（__lastHitToast）');
});

// ---------- v0.6.19 回归：准星=射线（后坐必须参与上报，压枪有效） ----------
test('v0.6.19 回归：射线上报必须含后坐量（准星=射线）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  assert.ok(src.includes('pitch: local.pitch + recoilPitch'), '单机上报 pitch 必须含后坐');
  assert.ok(src.includes('yaw: local.yaw + recoilYaw'), '上报 yaw 必须含水平后坐');
  const cnt = (src.match(/recoilPitch/g) || []).length;
  assert.ok(cnt >= 4, `后坐参与上报（出现 ${cnt} 处）`);
});

// ---------- v0.6.20 回归：弹药显示 = 弹匣/备弹（两个独立概念，开枪备弹不减） ----------
test('v0.6.21 回归：弹药 HUD 显示 弹匣/统一弹药库（E020）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  assert.ok(src.includes('p.ammoLib[weapon.ammo.ammoId]'), 'HUD 备弹必须读统一弹药库 ammoLib');
  assert.ok(src.includes('localAmmoLib[weapon.ammo.ammoId]'), '联机 HUD 备弹必须读 localAmmoLib');
});

// ---------- E019/E020 回归：弹药口径语义（E020 升级后断言同步修订） ----------
test('E019/E020 回归：弹药箱一律可用（统一库收所有口径，不按武器口径禁用）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf-8');
  // E020（ERROR.md E020「E019 语义升级」）：弹药箱不再拒收异口径 → UI 不得再按当前武器口径禁用
  assert.ok(!src.includes('口径不符'), '不得再按当前武器口径禁用弹药箱（E019 门禁已随 E020 废除）');
  assert.ok(!src.includes('def.ammo.ammoId === p.weapon.ammo.ammoId'), '弹药箱按钮不得再依赖当前武器口径');
  const simSrc = fs.readFileSync(path.join(ROOT, 'shared', 'sim.js'), 'utf-8');
  assert.ok(simSrc.includes('itemId: ammoRefill.ammoId'), '弹药箱按自身口径拆包成实体弹药堆叠入背包（E045 实体化）');
});
test('E020→E045 回归：弹药实体化（ammoLib 派生 / 换弹读背包堆叠 / 弹药箱拆包）', () => {
  const simSrc = fs.readFileSync(path.join(ROOT, 'shared', 'sim.js'), 'utf-8');
  assert.ok(simSrc.includes('ammoLib'), '玩家（派生）弹药库字段必须存在（协议字段名不变）');
  assert.ok(simSrc.includes('this.invAmmoOf(p, ammo.ammoId)'), '换弹备弹来源必须读背包实体弹药堆叠');
  assert.ok(simSrc.includes('this.takeInvAmmo(p, ammo.ammoId, need)'), '换弹完成必须从背包实体堆叠扣弹');
  assert.ok(simSrc.includes('this._unwrapAmmo(item)'), '拾取弹药箱必须拆包成实体堆叠');
  assert.ok(simSrc.includes('refreshAmmoLib'), '派生弹药库必须随状态刷新');
});
