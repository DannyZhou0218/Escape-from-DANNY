'use strict';
// E016 碰撞修复防回归：空中不穿模 / 防卡死推出 / 站立容差 / 跳上箱子保留
const { test } = require('node:test');
const assert = require('node:assert');
const Core = require('../shared/core');
const { GameSim } = require('../shared/sim');

const { MAP, slideMove, pushOutOfBlock, groundYAt, collidesXZ } = Core;
const R = 0.45;

// 找地图中的小型掩体方块（w<=3，非地面层，防卡死推出距离可控）
function findBlock() {
  for (const b of MAP) {
    if (b.y + b.h / 2 > 0.01 && b.w <= 3 && b.d <= 3 && b.h >= 1) return b;
  }
  return null;
}

test('E016: slideMove 空中朝方块移动不穿进（跳跃穿模修复）', () => {
  const b = findBlock();
  assert.ok(b, '地图应有掩体方块');
  const hw = b.w / 2;
  // 玩家在方块 -X 侧，脚底与方块重叠（跳起高度不足），朝 +X 推进
  const e = { x: b.x - hw - R - 0.3, y: b.y, z: b.z };
  slideMove(MAP, e, 0.2, 0, R); // 朝方块推进
  // 不应穿进：玩家中心不得越过方块边界（含半径间距）
  assert.ok(e.x <= b.x - hw - R + 0.01, `玩家不应穿进方块（x=${e.x.toFixed(2)}，边界=${(b.x - hw - R).toFixed(2)}）`);
});

test('E016: 玩家跳起高于方块顶时可跨越（跳上箱子保留）', () => {
  const b = findBlock();
  const hw = b.w / 2;
  // 玩家脚底在方块顶之上（跳起跨越），朝方块上方移动
  const e = { x: b.x - hw - R - 0.3, y: b.y + b.h / 2 + 0.3, z: b.z };
  const x0 = e.x;
  slideMove(MAP, e, 0.4, 0, R); // 朝方块上方移动
  assert.ok(e.x > x0, '跳起高于方块顶时应可跨越（不被挡）');
});

test('E016: pushOutOfBlock 把卡在方块内的实体推出', () => {
  const b = findBlock();
  // 把玩家位置直接放进方块中心（模拟卡进方块）
  const e = { x: b.x, y: b.y, z: b.z };
  assert.ok(collidesXZ(MAP, e.x, e.y, e.z, R), '前置：确实在方块内');
  const ok = pushOutOfBlock(MAP, e, R);
  assert.ok(ok, '应成功推出');
  assert.ok(!collidesXZ(MAP, e.x, e.y, e.z, R), `推出后不再碰撞（x=${e.x.toFixed(2)} z=${e.z.toFixed(2)}）`);
});

test('E016: groundYAt 站立容差（脚在方块顶下 0.1m 视为站立在顶）', () => {
  const b = findBlock();
  const top = b.y + b.h / 2;
  // 玩家水平在方块范围内，脚在顶下 0.1m
  const gy = groundYAt(MAP, b.x, top - 0.1, b.z);
  assert.equal(gy, top, '容差 0.15 内应返回方块顶');
});

test('E016: GameSim tick 玩家卡进方块后自动推出（端到端）', () => {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('aaaaaa', 'A');
  const p = sim.players.get('aaaaaa');
  const b = findBlock();
  // 把玩家塞进方块内部（模拟服务器校正/穿模）
  p.x = b.x; p.y = b.y; p.z = b.z;
  // tick 几帧（移动逻辑内 pushOut 应推出）
  for (let i = 0; i < 5; i++) sim.tick(1 / 60);
  assert.ok(!collidesXZ(MAP, p.x, p.y, p.z, R), `tick 后玩家应被推出方块（x=${p.x.toFixed(2)} z=${p.z.toFixed(2)}）`);
});
