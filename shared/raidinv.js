'use strict';
(function () {
  /*
   * EXFIL ZONE · shared/raidinv.js — 局内背包「视图网格」（纯逻辑，Node 与浏览器共用）
   * ---------------------------------------------------------------------------
   * P4（2026-09-20，用户需求：「搜刮要能看到、要能拖」）
   *
   * 与 grid.js 的分工（重要）：
   *   grid.js    整备界面 —— **档案权威**（profile.grid / profile.equipment，会落盘）
   *   raidinv.js 局内背包 —— **仅视图**（客户端布局表 uid → {x,y,rot}）
   *
   * 硬边界（见 .workbuddy/配装系统构想_v2.md · D3 风险缓解五条）：
   *   ① sim 的 inventory **仍是数组**（下标语义 / useItem / dropItem 全不变）
   *   ② 不改联机协议载荷（state/invChanged/search/useItem/dropItem 一个字不动）
   *   ③ 不触碰物理语义（predict.js / sim.js 的 step 无关）
   *   ④ 全部纯函数：不修改入参，一律返回新对象
   *   ⑤ 容错优先：脏数据不抛错；放不下则自动扩容，绝不丢件
   *
   * 数据模型：
   *   layout = { w, h, items: [ { uid, itemId, x, y, rot, count, ammo? } ] }
   *   entry  = sim/服务器 inventory 里的一条（数组元素，形如 { itemId, count } 或武器实例）
   */

  const Grid = (typeof module !== 'undefined' && module.exports)
    ? require('./grid')
    : (typeof window !== 'undefined' && window.EXFIL_GRID ? window.EXFIL_GRID : null);

  const ConfigLib = (typeof module !== 'undefined' && module.exports)
    ? require('./config')
    : (typeof window !== 'undefined' && window.EXFIL_CONFIG_LIB ? window.EXFIL_CONFIG_LIB : null);
  const CFG = (ConfigLib && ConfigLib.CFG) || {};

  const DEFAULT_COLS = 10;
  const DEFAULT_ROWS = 10;
  const MAX_ROWS = 60; // 扩容上限（防脏数据把网格撑到无限大）

  // ---------- 配置（使用点直读，热重载安全） ----------
  function raidCfg() {
    const g = CFG.grid || {};
    const num = (v, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : d; };
    return { cols: num(g.raidCols, DEFAULT_COLS), rows: num(g.raidRows, DEFAULT_ROWS) };
  }

  // ---------- uid 派生（布局持久化的锚点） ----------
  // 优先用条目自带的 uid（未来 sim 若提供则自动生效）；
  // 否则：武器按对象身份分配（同对象稳定），可堆叠物按 itemId（同种合并 → 位置随种类走）。
  let weakIds = null; // WeakMap<entry, string>
  let weakSeq = 0;
  function uidOf(entry) {
    if (!entry || typeof entry !== 'object') return 'i:?';
    if (typeof entry.uid === 'string' && entry.uid) return entry.uid;
    const itemId = entry.itemId || (entry.weaponId ? 'w_' + entry.weaponId : '?');
    if (Grid && Grid.isWeaponId(itemId)) {
      if (!weakIds) weakIds = new WeakMap();
      let id = weakIds.get(entry);
      if (!id) { weakSeq += 1; id = 'iw#' + weakSeq; weakIds.set(entry, id); }
      return id;
    }
    return 'is:' + itemId;
  }

  // uid → inventory 数组下标（用于 useItem / dropItem / 装备）
  function indexByUid(entries) {
    const map = {};
    const list = Array.isArray(entries) ? entries : [];
    for (let i = 0; i < list.length; i++) { const u = uidOf(list[i]); if (!(u in map)) map[u] = i; }
    return map;
  }

  function makeLayout(cols, rows) {
    return { w: Math.max(1, Math.floor(cols || DEFAULT_COLS)), h: Math.max(1, Math.floor(rows || DEFAULT_ROWS)), items: [] };
  }

  function _rander(entries) {
    const map = {};
    for (const e of (Array.isArray(entries) ? entries : [])) {
      const u = uidOf(e);
      if (!(u in map)) map[u] = e;
    }
    return map;
  }

  // 把一条 inventory 条目转成网格 entry（不改原对象）
  function toGridEntry(entry, pos) {
    const itemId = entry.itemId || (entry.weaponId ? 'w_' + entry.weaponId : null);
    const e = {
      uid: uidOf(entry), itemId: itemId,
      x: pos ? pos.x : 0, y: pos ? pos.y : 0, rot: pos ? Grid.normRot(pos.rot) : 0,
      count: entry.count || 1
    };
    if (entry.ammo) e.ammo = { ...entry.ammo };
    if (entry.mods) e.mods = { ...entry.mods };
    return e;
  }

  /*
   * reconcile(layout, entries, opts) —— 核心：把「数组背包」映射到「视图网格」
   *  - 已有的 uid 保留原位置（拖动结果不丢）
   *  - 新条目（刚搜到的）自动找空位，uid 记入 added（供高亮）
   *  - 条目消失（使用/丢弃/被装备）自动移除
   *  - 放不下 → 自动加行（资产不丢）
   * 返回 { grid, added:[uid], removed:[uid], resized:bool }
   */
  function reconcile(layout, entries, opts) {
    const c = raidCfg();
    const o = opts || {};
    const cols = Math.max(1, Math.floor(o.cols || (layout && layout.w) || c.cols));
    let rows = Math.max(1, Math.floor(o.rows || (layout && layout.h) || c.rows));
    const byUid = _rander(entries);            // 现存条目（按 uid 去重）
    const prevItems = (layout && Array.isArray(layout.items)) ? layout.items : [];

    // 位置复用池（在线快照会重建对象 → uid 变化，此时按 itemId 认领旧位置，保证拖动结果稳定）
    const claimedPos = new Set();
    const posFor = (uid, itemId) => {
      const exact = prevItems.find((x) => x.uid === uid);
      if (exact && !claimedPos.has(exact.uid)) { claimedPos.add(exact.uid); return exact; }
      const byItem = prevItems.find((x) => x.itemId === itemId && !claimedPos.has(x.uid));
      if (byItem) { claimedPos.add(byItem.uid); return byItem; }
      return null;
    };

    let g = { w: cols, h: rows, items: [] };
    const added = [];
    const removed = [];
    let resized = false;

    for (const uid of Object.keys(byUid)) {
      const entry = byUid[uid];
      const itemId = entry.itemId || (entry.weaponId ? 'w_' + entry.weaponId : null);
      if (!itemId) continue;
      const pos = posFor(uid, itemId);
      let ge = toGridEntry(entry, pos);
      if (pos) {
        const want = Grid.normRot(pos.rot);
        ge.rot = want;
        ge.x = Math.max(0, Math.floor(pos.x || 0));
        ge.y = Math.max(0, Math.floor(pos.y || 0));
        if (!Grid.canPlace(g, ge, ge.x, ge.y, { skipUid: ge.uid })) {
          ge.x = 0; ge.y = 0; ge.rot = 0;
        }
      } else {
        ge.x = 0; ge.y = 0; ge.rot = 0;
      }
      // 首次放置 / 位置失效 → 自动寻空位（放不下则加行）
      if (!Grid.canPlace(g, ge, ge.x, ge.y, { skipUid: ge.uid })) {
        let spot = null;
        while (!spot && g.h <= MAX_ROWS) {
          spot = Grid.findFreeSpot(g, itemId, ge.rot, ge.uid);
          if (!spot) {
            const order = Grid.normRot(ge.rot) === 0 ? [0, 1] : [1, 0];
            for (const r of order) { spot = Grid.findFreeSpot(g, itemId, r, ge.uid); if (spot) { ge.rot = r; break; } }
          }
          if (!spot) { g = { ...g, h: g.h + 1, items: g.items.map((x) => ({ ...x })) }; resized = true; }
        }
        if (!spot) continue; // 极端兜底（不该发生）：跳过而非崩溃
        ge.x = spot.x; ge.y = spot.y;
      }
      if (!pos) added.push(ge.uid);
      g.items.push(ge);
    }

    // 已消失的条目
    for (const p of prevItems) {
      const u = p.uid;
      if (!byUid[u] && !g.items.some((x) => x.uid === u)) {
        const stillUsed = g.items.some((x) => x.itemId === p.itemId);
        if (!stillUsed) removed.push(u);
      }
    }
    return { grid: g, added, removed, resized };
  }

  function move(layout, uid, x, y, rot) {
    return Grid.moveItem(layout, uid, x, y, rot);
  }
  function rotate(layout, uid) {
    return Grid.rotateItem(layout, uid);
  }
  function findByUid(layout, uid) {
    return Grid.findByUid(layout, uid);
  }
  function footprint(itemId, rot) {
    return Grid.footprint(itemId, rot);
  }
  function usedCells(layout) { return Grid.usedCells(layout); }
  function totalCells(layout) { return Grid.totalCells(layout); }

  // 视图层不落盘：仅供调试/自检（可注入假数据跑纯逻辑测试）
  function __resetUidMemo() { weakIds = null; weakSeq = 0; }

  const RaidInv = {
    uidOf, indexByUid, makeLayout, reconcile, toGridEntry,
    move, rotate, findByUid, footprint, usedCells, totalCells,
    raidCfg, __resetUidMemo
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = RaidInv;
  if (typeof window !== 'undefined') window.EXFIL_RAIDINV = RaidInv;
})();
