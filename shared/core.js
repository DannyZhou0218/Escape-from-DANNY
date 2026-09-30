'use strict';
(function () {
  /*
   * EXFIL ZONE · shared/core.js — 纯游戏逻辑（Node 与浏览器共用，双兼容导出）
   * IIFE 隔离作用域：浏览器普通 script 共享全局，顶层 const 会互相冲突（E011）
   */
  const { MAP_RAW } = (typeof module !== 'undefined' && module.exports)
    ? require('./map')
    : (typeof window !== 'undefined' && window.EXFIL_MAP ? window.EXFIL_MAP : { MAP_RAW: [] });

  // ---------- 配置（config/tuning.json → shared/config.js；缺字段走默认值） ----------
  const ConfigLib = (typeof module !== 'undefined' && module.exports)
    ? require('./config')
    : (typeof window !== 'undefined' && window.EXFIL_CONFIG_LIB ? window.EXFIL_CONFIG_LIB : null);
  if (!ConfigLib) throw new Error('EXFIL_CONFIG_LIB 未加载');
  const CFG = ConfigLib.CFG;

  // ---------- 物理参数（客户端预测的单一数据源） ----------
  // PHYSICS 直接引用 CFG.physics：热重载改 JSON 后无需重启即生效（不拷贝值）
  const PHYSICS = CFG.physics;
  const PLAYER_H = CFG.physics.playerH;  // 供射线垂直区间等内部使用（新局生效）
  const PLAYER_R = CFG.physics.playerR;
  const HITBOX_PAD = 0.15; // 命中盒水平外扩（贴合渲染体积）

  // ---------- 地图（颜色字符串 → 数字） ----------
  const MAP = MAP_RAW.map(b => ({ ...b, c: parseInt(b.c, 16) }));

  // ---------- 水平碰撞：圆 vs 方块（跳过地面层；垂直需与玩家身体重叠） ----------
  function collidesXZ(blocks, px, py, pz, r) {
    for (const b of blocks) {
      if (b.y + b.h / 2 <= 0.01) continue;
      const hw = b.w / 2, hd = b.d / 2;
      const bTop = b.y + b.h / 2, bBot = b.y - b.h / 2;
      if (px > b.x - hw - r && px < b.x + hw + r && pz > b.z - hd - r && pz < b.z + hd + r
        && py < bTop && py + PLAYER_H > bBot) return b;
    }
    return null;
  }

  // ---------- 站立高度：玩家脚底下方（<=py+0.15 容差，防浮点误差卡进方块）的最高方块顶面 ----------
  function groundYAt(blocks, px, py, pz) {
    let gy = 0;
    for (const b of blocks) {
      const hw = b.w / 2, hd = b.d / 2;
      const top = b.y + b.h / 2;
      if (top <= py + CFG.physics.groundTolerance && px > b.x - hw && px < b.x + hw && pz > b.z - hd && pz < b.z + hd) {
        gy = Math.max(gy, top);
      }
    }
    return gy;
  }

  // ---------- 射线 vs AABB（slab 法） ----------
  function rayHitsBlock(blocks, ox, oy, oz, dx, dy, dz, maxT) {
    let nearest = null;
    for (const b of blocks) {
      if (b.y + b.h / 2 <= 0.01) continue;
      const mn = [b.x - b.w / 2, b.y - b.h / 2, b.z - b.d / 2];
      const mx = [b.x + b.w / 2, b.y + b.h / 2, b.z + b.d / 2];
      const o = [ox, oy, oz], d = [dx, dy, dz];
      let t0 = 0, t1 = maxT, ok = true;
      for (let i = 0; i < 3; i++) {
        if (Math.abs(d[i]) < 1e-9) {
          if (o[i] < mn[i] || o[i] > mx[i]) { ok = false; break; }
        } else {
          let a = (mn[i] - o[i]) / d[i], b2 = (mx[i] - o[i]) / d[i];
          if (a > b2) { const t = a; a = b2; b2 = t; }
          t0 = Math.max(t0, a); t1 = Math.min(t1, b2);
          if (t0 > t1) { ok = false; break; }
        }
      }
      if (ok && t0 > 0 && (nearest === null || t0 < nearest)) nearest = t0;
    }
    return nearest;
  }

  // ---------- 射线 vs 目标（全高命中：水平距离 + 垂直区间脚到头顶）+ 方块遮挡 ----------
  // E013b 教训：原"圆柱中心 ±0.75"只覆盖 0.15–1.65m，头部在碰撞外——改为全高（-0.2 ~ +2.1）
  function raycastPlayers(blocks, players, ox, oy, oz, dx, dy, dz, maxDist, excludeId) {
    let best = null, bestT = maxDist;
    for (const p of players) {
      if (p.id === excludeId || !p.alive) continue;
      const cx = p.x, cz = p.z, cr = PLAYER_R;
      // 水平最近点（忽略垂直，水平距离判定）
      const t = ((cx - ox) * dx + (cz - oz) * dz) / ((dx * dx + dz * dz) || 0.0001);
      if (t <= 0 || t >= bestT) continue;
      const px2 = ox + dx * t, pz2 = oz + dz * t;
      const hDist = Math.hypot(cx - px2, cz - pz2);
      if (hDist >= cr + HITBOX_PAD) continue; // 命中盒贴合渲染体积
      // 垂直区间：射线在该高度经过目标身体（脚底 -0.2 ~ 头顶 +2.1）
      const py2 = oy + dy * t;
      if (py2 < p.y - 0.2 || py2 > p.y + 2.1) continue;
      best = p; bestT = t;
    }
    if (!best) return null;
    const blockDist = rayHitsBlock(blocks, ox, oy, oz, dx, dy, dz, bestT);
    if (blockDist !== null && blockDist < bestT) return null;
    return best;
  }

  // ---------- 视角方向向量 ----------
  function directionFromAngles(yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    return { x: -sy * cp, y: -sp, z: -cy * cp };
  }

  // ---------- 出生点 ----------
  function spawnPoint(id, testIndex) {
    const test = typeof testIndex === 'number' || (typeof process !== 'undefined' && process.env && process.env.EXFIL_TEST === '1');
    if (test) {
      const idx = typeof testIndex === 'number' ? testIndex : [...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % 2;
      return idx === 0 ? { x: -5, y: 0, z: 20 } : { x: 5, y: 0, z: 20 };
    }
    const spots = [
      { x: -16, y: 0, z: 12 }, { x: 16, y: 0, z: 12 },
      { x: -16, y: 0, z: -12 }, { x: 16, y: 0, z: -12 },
      { x: 0, y: 0, z: -28 }, { x: 0, y: 0, z: 28 },
      { x: -28, y: 0, z: 0 }, { x: 28, y: 0, z: 0 }
    ];
    const h = [...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0);
    const s = spots[h % spots.length];
    return { x: s.x + (Math.random() - 0.5) * 2, y: s.y, z: s.z + (Math.random() - 0.5) * 2 };
  }

  // ---------- A* 网格寻路（M2c：体素地图天然网格化） ----------
  // 网格化：1m 粒度，格子中心被实体方块占据（含玩家半径间距）→ 障碍
  function buildNavGrid(blocks, range = 40, cell = 1) {
    const n = Math.round(range * 2 / cell);
    const grid = [];
    for (let gz = 0; gz < n; gz++) {
      const row = [];
      for (let gx = 0; gx < n; gx++) {
        const wx = -range + (gx + 0.5) * cell;
        const wz = -range + (gz + 0.5) * cell;
        row.push(collidesXZ(blocks, wx, 0, wz, CFG.scav.navClearance) ? 1 : 0); // E023：膨胀须 ≥ 玩家半径，否则路径贴墙卡死
      }
      grid.push(row);
    }
    return { grid, cell, range, n };
  }
  // A*：返回世界坐标路径点数组（不含起点）；无路径返回 null
  function findPath(nav, sx, sz, gx, gz) {
    const { grid, cell, range, n } = nav;
    const toCell = (wx, wz) => [Math.floor((wx + range) / cell), Math.floor((wz + range) / cell)];
    const [scx, scz] = toCell(sx, sz);
    const [gcx, gcz] = toCell(gx, gz);
    if (scx < 0 || scx >= n || scz < 0 || scz >= n || gcx < 0 || gcx >= n || gcz < 0 || gcz >= n) return null;
    if (grid[scz][scx] || grid[gcz][gcx]) return null;
    const key = (x, z) => x + ',' + z;
    const h = (x, z) => Math.hypot(gcx - x, gcz - z);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const dirCost = [1, 1, 1, 1, 1.414, 1.414, 1.414, 1.414];
    const open = new Map(); // key -> {g, f, px, pz}
    const closed = new Map();
    open.set(key(scx, scz), { g: 0, f: h(scx, scz), px: -1, pz: -1 });
    let iter = 0;
    while (open.size && iter < 30000) {
      iter++;
      let best = null, bestK = null;
      for (const [k, v] of open) { if (!best || v.f < best.f) { best = v; bestK = k; } }
      if (bestK === key(gcx, gcz)) {
        // 回溯（跳过终点格，返回路径点序列）
        const path = [];
        let ck = bestK, cur = best;
        while (cur && cur.px >= 0) {
          const [x, z] = ck.split(',').map(Number);
          path.unshift({ x: -range + (x + 0.5) * cell, z: -range + (z + 0.5) * cell });
          ck = key(cur.px, cur.pz);
          cur = open.get(ck) || closed.get(ck);
        }
        return path;
      }
      open.delete(bestK);
      closed.set(bestK, best);
      const [cx, cz] = bestK.split(',').map(Number);
      for (let d = 0; d < dirs.length; d++) {
        const nx = cx + dirs[d][0], nz = cz + dirs[d][1];
        if (nx < 0 || nx >= n || nz < 0 || nz >= n) continue;
        if (grid[nz][nx]) continue;
        const nk = key(nx, nz);
        if (closed.has(nk)) continue;
        const ng = best.g + dirCost[d];
        const ex = open.get(nk);
        if (!ex || ng < ex.g) open.set(nk, { g: ng, f: ng + h(nx, nz), px: cx, pz: cz });
      }
    }
    return null;
  }

  // ---------- 水平移动：逐轴滑动碰撞（空中也检测——防跳跃穿进方块）+ 地面台阶限制 ----------
  // E016：原逻辑"空中不做碰撞"导致跳上箱子边缘时穿进方块内部卡死
  function slideMove(blocks, e, mx, mz, r) {
    const gy0 = groundYAt(blocks, e.x, e.y, e.z);
    const onGround = e.y <= gy0 + 0.01 && e.y >= gy0 - 0.6;
    let moved = true;
    if (mx !== 0) {
      if (!collidesXZ(blocks, e.x + mx, e.y, e.z, r) && (!onGround || groundYAt(blocks, e.x + mx, e.y, e.z) <= gy0 + CFG.physics.stepHeight)) {
        e.x += mx;
      } else moved = false;
    }
    if (mz !== 0) {
      if (!collidesXZ(blocks, e.x, e.y, e.z + mz, r) && (!onGround || groundYAt(blocks, e.x, e.y, e.z + mz) <= gy0 + CFG.physics.stepHeight)) {
        e.z += mz;
      } else moved = false;
    }
    return moved;
  }

  // ---------- 防卡死：实体位置在方块内 → 沿 8 方向连续走出到最近非碰撞位置 ----------
  function pushOutOfBlock(blocks, e, r) {
    if (!collidesXZ(blocks, e.x, e.y, e.z, r)) return true; // 未卡住：直接返回，不移动
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    for (const [dx, dz] of dirs) {
      for (let step = 0.25; step <= 4; step += 0.25) {
        const nx = e.x + dx * step, nz = e.z + dz * step;
        if (!collidesXZ(blocks, nx, e.y, nz, r)) { e.x = nx; e.z = nz; return true; }
      }
    }
    return false;
  }

  const Core = {
    PHYSICS, MAP, collidesXZ, groundYAt, rayHitsBlock, raycastPlayers,
    directionFromAngles, spawnPoint, buildNavGrid, findPath, slideMove, pushOutOfBlock
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window !== 'undefined') window.EXFIL_CORE = Core;
})();
