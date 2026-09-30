'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Core = require('../shared/core');
const { GameSim } = require('../shared/sim');

// ---------- M2c A* 寻路 ----------
test('navGrid: 网格尺寸与门洞可通行', () => {
  const nav = Core.buildNavGrid(Core.MAP);
  assert.equal(nav.n, 80, '40m 范围 1m 粒度 → 80x80');
  // 北墙 x∈[4,14] z=-9.5 → 格子阻塞；门洞 x∈(-4,4) → 可通行
  const cell = nav.cell;
  const toCell = (wx, wz) => [Math.floor((wx + nav.range) / cell), Math.floor((wz + nav.range) / cell)];
  const [wx1, wz1] = toCell(8, -9.5); // 墙段
  const [wx2, wz2] = toCell(0, -9.5); // 门洞
  assert.equal(nav.grid[wz1][wx1], 1, '墙段应阻塞');
  assert.equal(nav.grid[wz2][wx2], 0, '门洞应可通行');
});
test('A*: 开阔地直线路径', () => {
  const nav = Core.buildNavGrid(Core.MAP);
  const path = Core.findPath(nav, 30, 30, 35, 35); // 厂房外开阔
  assert.ok(path && path.length > 0, '应找到路径');
  const last = path[path.length - 1];
  assert.ok(Math.hypot(last.x - 35, last.z - 35) < 2, '路径应到达目标附近');
});
test('A*: 绕墙路径（墙两侧经门洞）', () => {
  const nav = Core.buildNavGrid(Core.MAP);
  // 北墙 z∈[-10,-9] x∈[4,14] 实心；起点/终点在墙两侧，路径须经门洞（x∈(-4,4)）
  const path = Core.findPath(nav, 10, -3, 10, -15);
  assert.ok(path && path.length > 0, '应找到绕行路径');
  // 路径点应出现在门洞附近（|x|<5）
  const viaGate = path.some(p => Math.abs(p.x) < 5 && p.z < -8 && p.z > -12);
  assert.ok(viaGate, '路径应经过门洞（|x|<5, z≈-10）');
});
test('A*: 障碍内目标不可达返回 null', () => {
  const nav = Core.buildNavGrid(Core.MAP);
  const toCell = (wx, wz) => [Math.floor((wx + nav.range) / nav.cell), Math.floor((wz + nav.range) / nav.cell)];
  const [gx, gz] = toCell(8, -9.5); // 墙内
  // 构造目标在墙内：直接用墙中心坐标
  const path = Core.findPath(nav, 30, 30, 8, -9.5);
  assert.equal(path, null, '目标在障碍内应无路径');
});
test('GameSim: 调查时 A* 路径接入（跨墙经门洞）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A', { x: 10, y: 0, z: -15 }); // 墙北侧
  sim.spawnScavs(1);
  const s = sim.scavs.values().next().value;
  s.x = 10; s.z = -3; s.yaw = 3.14; // 墙南侧，背对
  sim.emit('sound', { kind: 'shot', x: 10, y: 0, z: -15 }); // 声源在墙北（需经门洞）
  assert.equal(s.state, 'investigate');
  sim.tick(1 / 60); // path 在 tick 时惰性计算
  assert.ok(s.path && s.path.length > 0, '应有 A* 路径');
  assert.ok(s.path.some(p => Math.abs(p.x) < 5 && p.z < -8 && p.z > -12), '路径应经过门洞（|x|<5, z≈-10）');
  // M2d：调查途中看到玩家会转 combat（战斗优先接管）——行为变化合理
});
