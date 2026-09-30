/*
 * EXFIL ZONE · core.js 单元测试（Node test runner）
 * 运行: npm test（node --test）
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PHYSICS, MAP, collidesXZ, groundYAt, rayHitsBlock, raycastPlayers,
  directionFromAngles, spawnPoint
} = require('../shared/core');

const R = PHYSICS.playerR;

// ---------- 方向向量 ----------
test('directionFromAngles: yaw=0 面向 -Z', () => {
  const d = directionFromAngles(0, 0);
  assert.ok(Math.abs(d.x) < 1e-9 && Math.abs(d.z + 1) < 1e-9, `got ${JSON.stringify(d)}`);
});
test('directionFromAngles: yaw=+PI/2 面向 -X（左转）', () => {
  const d = directionFromAngles(Math.PI / 2, 0);
  assert.ok(Math.abs(d.x + 1) < 1e-9 && Math.abs(d.z) < 1e-9, `got ${JSON.stringify(d)}`);
});
test('directionFromAngles: 方向向量单位长度', () => {
  const d = directionFromAngles(0.7, 0.3);
  assert.ok(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-9);
});

// ---------- 地面高度（py=脚底，只算脚下的支撑面） ----------
test('groundYAt: 开阔地站立（py=0）地面 = 0', () => {
  assert.equal(groundYAt(MAP, 0, 0, 0), 0);
});
test('groundYAt: 头顶有掩体不算支撑（py=0 在掩体下）', () => {
  assert.equal(groundYAt(MAP, -6, 0, -4), 0); // 掩体顶 2 高于脚底，不算地面
});
test('groundYAt: 站在掩体顶（py=2.1）支撑 = 2', () => {
  assert.equal(groundYAt(MAP, -6, 2.1, -4), 2);
});

// ---------- 水平碰撞（含垂直重叠） ----------
test('collidesXZ: 掩体阻挡（身体与掩体重叠）', () => {
  assert.ok(collidesXZ(MAP, -6, 0, -4, R), '掩体应阻挡');
});
test('collidesXZ: 屋顶下方不阻挡（回归：屋顶在头顶不算障碍）', () => {
  assert.equal(collidesXZ(MAP, 0, 0, 0, R), null, '屋顶 y∈[5,6] 与身体 [0,1.8] 不重叠');
});
test('collidesXZ: 开阔地不阻挡', () => {
  assert.equal(collidesXZ(MAP, 50, 0, 50, R), null);
});
test('collidesXZ: 地面大平板不阻挡（顶面=0，跳过）', () => {
  assert.equal(collidesXZ(MAP, 0, 0, 30, R), null);
});
test('collidesXZ: 厂房门洞墙阻挡', () => {
  assert.ok(collidesXZ(MAP, -9, 0, -9.5, R));
});

// ---------- 射线遮挡 ----------
test('rayHitsBlock: 厂房北墙（x=-9 段）可被击中', () => {
  const t = rayHitsBlock(MAP, -9, 1.6, -20, 0, 0, 1, 100); // 朝 +Z
  assert.ok(t !== null && Math.abs(t - 10) < 0.2, `t=${t}`);
});
test('rayHitsBlock: 门洞缺口通道不遮挡（x=-3 朝 -Z）', () => {
  assert.equal(rayHitsBlock(MAP, -3, 1.6, 30, 0, 0, -1, 100), null);
});

// ---------- 射线 vs 玩家 + 遮挡 ----------
function fakePlayer(id, x, z, alive = true) {
  return { id, name: 'T', x, y: 0, z, hp: 100, alive };
}
test('raycastPlayers: 直线可见命中', () => {
  // 射手在 (0,-20) 朝 +Z（yaw=PI），目标在 (0,0)，无遮挡
  const shooter = fakePlayer('A', 0, -20);
  const target = fakePlayer('B', 0, 0);
  const d = directionFromAngles(Math.PI, 0);
  const hit = raycastPlayers(MAP, [shooter, target], 0, 1.6, -20, d.x, d.y, d.z, 100, 'A');
  assert.ok(hit && hit.id === 'B', `hit=${hit && hit.id}`);
});
test('raycastPlayers: 隔墙不命中（墙在射手与目标之间）', () => {
  // 射手在厂房外 (-9,-20) 朝 +Z，目标在厂房内 (-9,0)，北门洞墙 x=-9 段挡在中间
  const shooter = fakePlayer('A', -9, -20);
  const target = fakePlayer('B', -9, 0);
  const d = directionFromAngles(Math.PI, 0);
  const hit = raycastPlayers(MAP, [shooter, target], -9, 1.6, -20, d.x, d.y, d.z, 100, 'A');
  assert.equal(hit, null, '隔墙不应命中');
});
test('raycastPlayers: 排除自身与死亡玩家', () => {
  const shooter = fakePlayer('A', 0, -20);
  const dead = fakePlayer('D', 0, 0, false);
  const d = directionFromAngles(Math.PI, 0);
  const hit = raycastPlayers(MAP, [shooter, dead], 0, 1.6, -20, d.x, d.y, d.z, 100, 'A');
  assert.equal(hit, null, '死亡玩家不可被命中');
});

// ---------- 出生点 ----------
test('spawnPoint: 测试模式按序号确定性（同序号同点、不同序号异点）', () => {
  process.env.EXFIL_TEST = '1';
  const a1 = spawnPoint('abc123', 0), a2 = spawnPoint('abc123', 0);
  const b1 = spawnPoint('abc123', 1);
  assert.deepEqual(a1, a2);
  assert.ok(a1.x !== b1.x, '不同序号出生点应不同');
  assert.ok(Math.hypot(a1.x - b1.x, a1.z - b1.z) === 10, '测试出生点间距应恰为 10m');
  delete process.env.EXFIL_TEST;
});
test('spawnPoint: 正常模式出生点在场地内（|x|,|z| <= 40）', () => {
  for (const id of ['aa', 'bb', 'cc', 'dd', 'ee', 'ff']) {
    const s = spawnPoint(id);
    assert.ok(Math.abs(s.x) <= 40 && Math.abs(s.z) <= 40, `${id} -> ${JSON.stringify(s)}`);
  }
});
