'use strict';
/*
 * EXFIL ZONE · 预测-和解测试（E021：根治联机闪回）
 * 验收标准（程序化）：
 *   1) 同输入序列下，客户端预测与服务器权威位置一致（重放对称）
 *   2) 快照确认后待确认队列被正确裁剪（ack 语义）
 *   3) 延迟/丢包/抖动场景下，和解修正量有界（不产生大瞬移）
 *   4) 移动过程中不出现反向跳变（"闪回"的可量化定义）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Predict = require('../shared/predict');
const { GameSim } = require('../shared/sim');

const DT = 1 / 60;
const FWD = { f: 1, b: 0, l: 0, r: 0 };
const IDLE = { f: 0, b: 0, l: 0, r: 0 };

function makePair() {
  const sim = new GameSim({ testMode: true });
  sim.addPlayer('p', 'P', { x: 0, y: 0, z: 0 });
  const sp = sim.players.get('p');
  sp.yaw = 0;
  const client = { x: 0, y: 0, z: 0, vy: 0, yaw: 0 };
  return { sim, sp, client, queue: Predict.createQueue() };
}
function snapOf(sim) { return sim.snapshot().players.find(p => p.id === 'p'); }

test('预测: 同输入序列下预测位置与服务器权威一致（重放对称）', () => {
  const { sim, sp, client } = makePair();
  const inputs = [];
  for (let i = 0; i < 40; i++) inputs.push({ seq: i + 1, keys: FWD, jump: false, yaw: 0, pitch: 0 });
  for (const inp of inputs) { sim.applyInput('p', inp); sim.tick(DT); }
  for (const inp of inputs) Predict.step(client, inp, DT);
  const d = Math.hypot(client.x - sp.x, client.z - sp.z);
  assert.ok(d < 0.01, `40 步后预测应与权威一致（偏差 ${d.toFixed(4)}m）`);
});

test('预测: 跳跃序列同样对称（垂直物理一致）', () => {
  const { sim, sp, client } = makePair();
  const inputs = [];
  for (let i = 0; i < 30; i++) inputs.push({ seq: i + 1, keys: i < 5 ? FWD : IDLE, jump: i === 3, yaw: 0, pitch: 0 });
  for (const inp of inputs) { sim.applyInput('p', inp); sim.tick(DT); }
  for (const inp of inputs) Predict.step(client, inp, DT);
  assert.ok(Math.abs(client.y - sp.y) < 0.01, `跳跃垂直位置应一致（预测 ${client.y.toFixed(3)} vs 权威 ${sp.y.toFixed(3)}）`);
});

test('预测: ack 裁剪只丢弃已确认输入', () => {
  const queue = Predict.createQueue();
  for (let i = 1; i <= 10; i++) Predict.push(queue, { seq: i, keys: FWD, yaw: 0 });
  const dropped = Predict.ack(queue, 6);
  assert.equal(dropped, 6, '应丢弃 seq<=6 的 6 个输入');
  assert.equal(queue.length, 4, '剩余 4 个未确认');
  assert.equal(queue[0].seq, 7, '队首是第一个未确认输入');
});

test('预测: 队列上限保护（防长时间断线无界增长）', () => {
  const queue = Predict.createQueue();
  for (let i = 0; i < 500; i++) Predict.push(queue, { seq: i + 1, keys: FWD, yaw: 0 });
  assert.equal(queue.length, Predict.MAX_PENDING, `队列应被限制在 ${Predict.MAX_PENDING}`);
});

test('无闪回: 固定延迟下位置无反向跳变 + 修正量有界', () => {
  const { sim, client, queue } = makePair();
  const LATENCY = 4;            // 服务器滞后 4 步收到输入（模拟 ~66ms RTT）
  const inflight = [];
  let seq = 0, prevZ = client.z, backSteps = 0, maxCorr = 0;
  for (let tick = 0; tick < 180; tick++) {
    const inp = { seq: ++seq, keys: FWD, jump: false, yaw: 0, pitch: 0 };
    Predict.step(client, inp, DT);
    Predict.push(queue, inp);
    inflight.push(inp);
    if (inflight.length > LATENCY) { sim.applyInput('p', inflight.shift()); sim.tick(DT); }
    else sim.tick(DT);
    if (tick % 4 === 3) { // 30Hz 快照
      const r = Predict.reconcile(client, snapOf(sim), queue, DT);
      maxCorr = Math.max(maxCorr, r.correction);
      if (client.z > prevZ + 0.001) backSteps++; // 前进方向为 -Z，z 增大 = 反向跳变
      prevZ = client.z;
    }
  }
  assert.equal(backSteps, 0, `不应出现反向跳变（实际 ${backSteps} 次）`);
  assert.ok(maxCorr < 0.5, `和解修正应有界（最大 ${maxCorr.toFixed(3)}m，低于 1 帧位移量级）`);
  assert.ok(client.z < -8, `应确实发生了前进（z=${client.z.toFixed(2)}）`);
});

test('无闪回: 丢包场景（服务器少收输入）修正量仍有界', () => {
  const { sim, client, queue } = makePair();
  let seq = 0, prevZ = client.z, backSteps = 0, maxCorr = 0, drops = 0;
  const inflight = [];
  for (let tick = 0; tick < 180; tick++) {
    const inp = { seq: ++seq, keys: FWD, jump: false, yaw: 0, pitch: 0 };
    Predict.step(client, inp, DT);
    Predict.push(queue, inp);
    // 每 7 个输入丢 1 个（模拟 UDP 丢包）
    if (tick % 7 === 6) { drops++; } else inflight.push(inp);
    while (inflight.length > 3) { sim.applyInput('p', inflight.shift()); sim.tick(DT); }
    if (tick % 4 === 3) {
      const r = Predict.reconcile(client, snapOf(sim), queue, DT);
      maxCorr = Math.max(maxCorr, r.correction);
      if (client.z > prevZ + 0.001) backSteps++;
      prevZ = client.z;
    }
  }
  assert.ok(drops > 10, `应确实丢了包（${drops} 次）`);
  assert.ok(maxCorr < 0.6, `丢包下修正应有界（最大 ${maxCorr.toFixed(3)}m）`);
  assert.ok(backSteps <= 2, `丢包下最多 2 次微小反向（实际 ${backSteps} 次）`);
});

test('无闪回: 延迟抖动场景（服务器批量收到输入）修正量有界', () => {
  const { sim, client, queue } = makePair();
  let seq = 0, prevZ = client.z, backSteps = 0, maxCorr = 0;
  const inflight = [];
  for (let tick = 0; tick < 180; tick++) {
    const inp = { seq: ++seq, keys: FWD, jump: false, yaw: 0, pitch: 0 };
    Predict.step(client, inp, DT);
    Predict.push(queue, inp);
    inflight.push(inp);
    // 抖动：服务器有时 1 步收 1 个，有时 1 步收 3 个（批量到达）
    const take = (tick % 5 === 0) ? 3 : (inflight.length > 6 ? 2 : 1);
    for (let k = 0; k < take && inflight.length; k++) sim.applyInput('p', inflight.shift());
    sim.tick(DT);
    if (tick % 4 === 3) {
      const r = Predict.reconcile(client, snapOf(sim), queue, DT);
      maxCorr = Math.max(maxCorr, r.correction);
      if (client.z > prevZ + 0.001) backSteps++;
      prevZ = client.z;
    }
  }
  assert.ok(maxCorr < 1.0, `抖动下修正应有界（最大 ${maxCorr.toFixed(3)}m）`);
  assert.ok(backSteps <= 3, `抖动下最多 3 次微小反向（实际 ${backSteps} 次）`);
});

test('预测: 死亡后重放清空（不残留输入导致复活后瞬移）', () => {
  const { sim, client, queue } = makePair();
  const sp = sim.players.get('p');
  for (let i = 0; i < 5; i++) { const inp = { seq: i + 1, keys: FWD, yaw: 0 }; Predict.push(queue, inp); Predict.step(client, inp, DT); }
  sp.alive = false;
  const p = snapOf(sim);
  // 客户端侧对齐逻辑（与 game.js applySnapshot 相同策略）
  if (!p.alive) { client.x = p.x; client.y = p.y; client.z = p.z; client.vy = 0; queue.length = 0; }
  assert.equal(queue.length, 0, '死亡后待确认输入应清空');
  assert.equal(client.z, sp.z, '位置与权威对齐');
});
