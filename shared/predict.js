'use strict';
(function () {
  /*
   * EXFIL ZONE · shared/predict.js — 客户端预测-和解核心（Node 与浏览器共用，纯逻辑）
   *
   * 设计（E021，根治联机"闪回"）：
   *   1) 客户端每 1/60s 生成一个输入 → 立即本地预测一步 + 发送服务器，并存进 pending 队列
   *   2) 服务器按输入队列逐步消费（每个输入 = 一步），快照回传 lastSeq（已消费到哪个输入）
   *   3) 客户端收到快照：丢弃已确认输入 → 回滚到服务器权威状态 → 重放未确认输入
   *   4) 结果：预测位置与服务器权威位置的差异 = 仅"未确认输入的本地预测"，趋近 0 → 无回退/无闪回
   *
   * 与服务器 sim.stepPlayer 保持同款语义（物理/碰撞/台阶/吸附），否则重放不对称会产生偏差
   */
  const ConfigLib = (typeof module !== 'undefined' && module.exports)
    ? require('./config')
    : (typeof window !== 'undefined' && window.EXFIL_CONFIG_LIB ? window.EXFIL_CONFIG_LIB : null);
  if (!ConfigLib) throw new Error('EXFIL_CONFIG_LIB 未加载');
  const CFG = ConfigLib.CFG;

  const Core = (typeof module !== 'undefined' && module.exports)
    ? require('./core')
    : (typeof window !== 'undefined' ? window.EXFIL_CORE : null);
  if (!Core) throw new Error('EXFIL_CORE 未加载');
  const { PHYSICS, MAP, slideMove, pushOutOfBlock, groundYAt, directionFromAngles } = Core;

  const MAX_PENDING = 120; // 待确认输入上限（防长时间断线队列无界）

  // 单步预测（与服务器 sim.stepPlayer 同款语义）
  // state: {x,y,z,vy}（原地更新）；input: {keys,jump,yaw}；yaw 仅用于计算移动方向，不覆盖 state.yaw
  function step(state, input, dt) {
    const keys = (input && input.keys) || { f: 0, b: 0, l: 0, r: 0 };
    const yaw = (input && typeof input.yaw === 'number') ? input.yaw : state.yaw;
    const fwd = directionFromAngles(yaw, 0);
    const right = { x: -fwd.z, y: 0, z: fwd.x };
    let mx = 0, mz = 0;
    if (keys.f) { mx += fwd.x; mz += fwd.z; }
    if (keys.b) { mx -= fwd.x; mz -= fwd.z; }
    if (keys.l) { mx -= right.x; mz -= right.z; }
    if (keys.r) { mx += right.x; mz += right.z; }
    const len = Math.hypot(mx, mz);
    const speedMul = (input && input.overweight) ? CFG.player.overweightSpeedMul : 1;
    if (len > 0) { mx = mx / len * PHYSICS.speed * speedMul * dt; mz = mz / len * PHYSICS.speed * speedMul * dt; }
    slideMove(MAP, state, mx, mz, PHYSICS.playerR);
    pushOutOfBlock(MAP, state, PHYSICS.playerR);
    if (input && input.jump && state.y <= groundYAt(MAP, state.x, state.y, state.z) + 0.01) state.vy = PHYSICS.jumpV;
    state.vy = (state.vy || 0) + PHYSICS.gravity * dt;
    state.y += state.vy * dt;
    const gy = groundYAt(MAP, state.x, state.y, state.z);
    if (state.y < gy && state.vy <= 0) { state.y = gy; state.vy = 0; }
    if (state.y > CFG.physics.maxY) { state.y = CFG.physics.maxY; state.vy = 0; }
    return state;
  }

  // ---------- 待确认输入队列 ----------
  function createQueue() { return []; }
  function push(queue, input) {
    queue.push(input);
    while (queue.length > MAX_PENDING) queue.shift();
    return queue;
  }
  function ack(queue, seq) {
    let dropped = 0;
    while (queue.length && queue[0].seq <= seq) { queue.shift(); dropped++; }
    return dropped;
  }

  /**
   * 和解：丢弃已确认输入 → 回滚到服务器权威状态 → 重放未确认输入
   * @param state 本地预测状态 {x,y,z,vy}（原地更新）
   * @param server 服务器权威状态快照 {x,y,z,vy,lastSeq}
   * @param queue 待确认输入队列（原地裁剪）
   * @param dt 单步步长（应等于服务器 tick 步长，默认 1/60）
   * @returns {{dropped:number, replayed:number, correction:number}} correction=回滚距离（诊断用，正常应≈1 帧位移以内）
   */
  function reconcile(state, server, queue, dt) {
    const step_dt = dt || 1 / 60;
    const dropped = ack(queue, server.lastSeq || 0);
    const correction = Math.hypot(server.x - state.x, server.z - state.z);
    // 回滚到服务器权威
    state.x = server.x;
    state.y = server.y;
    state.z = server.z;
    state.vy = server.vy !== undefined ? server.vy : 0;
    // 重放未确认输入
    for (const inp of queue) step(state, inp, step_dt);
    return { dropped, replayed: queue.length, correction };
  }

  const Predict = { step, createQueue, push, ack, reconcile, MAX_PENDING };
  if (typeof module !== 'undefined' && module.exports) module.exports = Predict;
  if (typeof window !== 'undefined') window.EXFIL_PREDICT = Predict;
})();
