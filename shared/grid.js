'use strict';
(function () {
  /*
   * EXFIL ZONE · shared/grid.js — 配装网格（纯逻辑，Node 与浏览器共用）
   * ---------------------------------------------------------------------------
   * P1（2026-09-20）：为「塔克夫式可拖拽格子」提供**冻结接口**。
   * 设计约束（见 .workbuddy/配装系统构想_v2.md）：
   *   ① 全部纯函数：**不修改入参**，一律返回新对象（可单测、服务器与客户端共用）
   *   ② 不触碰 sim.js / predict.js 的物理语义
   *   ③ 与既有档案（profile.stash 数组）双向适配：fromLegacyStash / toLegacyStash
   *   ④ 容错优先：任何脏数据都不得抛错 —— 越界/重叠自动修复，装不下放 overflow（资产不丢）
   *
   * 数据模型：
   *   grid      = { w, h, items: [entry] }
   *   entry     = { uid, itemId, x, y, rot, count, ammo?, mods? }   // x,y 为左上角格
   *   equipment = { head, armor, rig, backpack, primary, secondary, melee }  // 每槽 entry 或 null
   *   size      = content.json 的 item.size（D1：真实塔克夫尺寸，如 AK-74 = [5,2]）
   *   slot      = content.json 的 item.slot（**数组**，D5：支持复合装备如带弹挂的防弹衣）
   */
  const ConfigLib = (typeof module !== 'undefined' && module.exports)
    ? require('./config')
    : (typeof window !== 'undefined' && window.EXFIL_CONFIG_LIB ? window.EXFIL_CONFIG_LIB : null);
  const CFG = (ConfigLib && ConfigLib.CFG) || {};

  const ItemsLib = (typeof module !== 'undefined' && module.exports)
    ? require('./items')
    : (typeof window !== 'undefined' && window.EXFIL_ITEMS ? window.EXFIL_ITEMS : null);
  const ITEMS = ItemsLib || {};

  const DEFAULT_SIZE = [1, 1];
  const SLOT_ORDER = ['head', 'armor', 'rig', 'backpack', 'primary', 'secondary', 'melee'];

  // ---------- 配置（使用点直读，热重载安全：绝不拷贝到模块级常量） ----------
  function gridCfg() {
    const g = CFG.grid || {};
    const num = (v, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : d; };
    return {
      w: num(g.stashW, 10),
      h: num(g.stashH, 30),
      stackMax: num(g.stackMax, 9999),
      slots: Array.isArray(g.slots) && g.slots.length ? g.slots.slice() : SLOT_ORDER.slice()
    };
  }
  function equipSlots() { return gridCfg().slots; }

  // ---------- 物品查表与属性 ----------
  function defOf(itemId) {
    if (!itemId) return null;
    return (ITEMS.LOOT && ITEMS.LOOT[itemId])
      || (ITEMS.WEAPONS && ITEMS.WEAPONS[itemId])
      || (ITEMS.MODS && ITEMS.MODS[itemId])
      || (ITEMS.AMMO && ITEMS.AMMO[itemId]) || null;
  }
  // 武器判定：loot 表武器条目带 weaponId；weapons 表条目带 ammoType/magSize
  function isWeaponId(itemId) {
    const d = defOf(itemId);
    return !!(d && (d.weaponId || d.ammoType));
  }
  function itemSize(itemId) {
    const d = defOf(itemId);
    const s = d && d.size;
    if (!Array.isArray(s) || s.length < 2) return DEFAULT_SIZE.slice();
    const w = Math.max(1, Math.floor(Number(s[0]) || 1));
    const h = Math.max(1, Math.floor(Number(s[1]) || 1));
    return [w, h];
  }
  function slotsFor(itemId) {
    const d = defOf(itemId);
    return (d && Array.isArray(d.slot)) ? d.slot.slice() : [];
  }
  // 可堆叠 = 非武器（武器每把独立：各有弹药/改装）
  function isStackable(itemId) { return !isWeaponId(itemId); }
  // 堆叠上限：物品级 stackMax 优先，缺省回落调参表（用户 2026-09-26 决策：统一上限）
  function stackOf(itemId) {
    const d = defOf(itemId);
    const v = d && Number(d.stackMax);
    return (Number.isFinite(v) && v > 0) ? Math.floor(v) : gridCfg().stackMax;
  }

  // ---------- 旋转与占格 ----------
  function normRot(rot) { return (Number(rot) === 1 || Number(rot) === 90) ? 1 : 0; }
  function footprint(itemId, rot) {
    const s = itemSize(itemId);
    return normRot(rot) === 1 ? [s[1], s[0]] : [s[0], s[1]];
  }
  let uidSeq = 0;
  function makeUid(prefix) {
    uidSeq = (uidSeq + 1) % 1000000;
    return (prefix || 'u') + Date.now().toString(36) + uidSeq.toString(36);
  }

  // ---------- 网格构造与克隆（纯函数基础） ----------
  function makeGrid(w, h) {
    const c = gridCfg();
    return { w: Math.max(1, Math.floor(w || c.w)), h: Math.max(1, Math.floor(h || c.h)), items: [] };
  }
  function cloneEntry(e) {
    const o = { ...e };
    if (e.ammo) o.ammo = { ...e.ammo };
    if (e.mods) o.mods = { ...e.mods };
    return o;
  }
  function cloneGrid(g) {
    return {
      w: (g && g.w) || 0,
      h: (g && g.h) || 0,
      items: ((g && g.items) || []).map(cloneEntry)
    };
  }
  function cellsOf(entry) {
    const [w, h] = footprint(entry.itemId, entry.rot);
    const out = [];
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) out.push([entry.x + dx, entry.y + dy]);
    }
    return out;
  }
  function occupancy(grid, skipUid) {
    const m = new Map();
    for (const e of ((grid && grid.items) || [])) {
      if (skipUid && e.uid === skipUid) continue;
      for (const [x, y] of cellsOf(e)) m.set(x + ',' + y, e.uid);
    }
    return m;
  }
  function totalCells(grid) { return Math.max(0, Math.floor((grid && grid.w) || 0) * Math.floor((grid && grid.h) || 0)); }
  function usedCells(grid) { return occupancy(grid).size; }
  function freeCells(grid) { return Math.max(0, totalCells(grid) - usedCells(grid)); }
  function findByUid(grid, uid) {
    if (!uid) return null;
    return ((grid && grid.items) || []).find(e => e.uid === uid) || null;
  }
  function countOf(grid, itemId) {
    return ((grid && grid.items) || []).filter(e => e.itemId === itemId).reduce((s, e) => s + (e.count || 1), 0);
  }

  // ---------- 放置判定 ----------
  // item 可为 itemId 字符串或 entry（entry 时用其 rot 与 uid 参与自身豁免）
  function canPlace(grid, item, x, y, opts) {
    if (!grid) return false;
    const o = opts || {};
    const isStr = typeof item === 'string';
    const itemId = isStr ? item : (item && item.itemId);
    const rot = isStr ? normRot(o.rot) : normRot(item && item.rot);
    const [w, h] = footprint(itemId, rot);
    const gx = Math.floor(Number(x)), gy = Math.floor(Number(y));
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return false;
    if (gx < 0 || gy < 0 || gx + w > grid.w || gy + h > grid.h) return false;
    const skip = o.skipUid || (!isStr && item && item.uid) || null;
    const occ = occupancy(grid, skip);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) if (occ.has((gx + dx) + ',' + (gy + dy))) return false;
    }
    return true;
  }
  // 首次适配扫描（先行后列）；itemIdOrSize 可为 itemId 或 [w,h]；skipUid 用于"移动/旋转自身"时豁免自己
  function findFreeSpot(grid, itemIdOrSize, rot, skipUid) {
    if (!grid) return null;
    let w, h;
    if (Array.isArray(itemIdOrSize)) {
      w = Math.max(1, Math.floor(Number(itemIdOrSize[0]) || 1));
      h = Math.max(1, Math.floor(Number(itemIdOrSize[1]) || 1));
      if (normRot(rot) === 1) { const t = w; w = h; h = t; }
    } else {
      const fp = footprint(itemIdOrSize, rot);
      w = fp[0]; h = fp[1];
    }
    const occ = occupancy(grid, skipUid);
    for (let y = 0; y + h <= grid.h; y++) {
      for (let x = 0; x + w <= grid.w; x++) {
        let ok = true;
        for (let dy = 0; dy < h && ok; dy++) {
          for (let dx = 0; dx < w; dx++) {
            if (occ.has((x + dx) + ',' + (y + dy))) { ok = false; break; }
          }
        }
        if (ok) return { x, y };
      }
    }
    return null;
  }

  function makeEntry(itemId, opts) {
    const o = opts || {};
    const e = {
      uid: o.uid || makeUid(),
      itemId: itemId,
      x: Math.floor(Number(o.x) || 0),
      y: Math.floor(Number(o.y) || 0),
      rot: normRot(o.rot),
      count: Math.max(1, Math.floor(Number(o.count) || 1))
    };
    if (o.ammo) e.ammo = { ...o.ammo };
    if (o.mods) e.mods = { ...o.mods };
    return e;
  }

  // 放入指定格（纯函数）：失败原样返回 grid 引用
  function place(grid, entry, x, y, opts) {
    const e = cloneEntry(entry);
    if (opts && opts.rot !== undefined) e.rot = normRot(opts.rot);
    if (!canPlace(grid, e, x, y, { skipUid: e.uid })) return { ok: false, grid, reason: 'occupied-or-out-of-bounds' };
    e.x = Math.floor(Number(x)); e.y = Math.floor(Number(y));
    const g = cloneGrid(grid);
    g.items.push(e);
    return { ok: true, grid: g, entry: e, x: e.x, y: e.y };
  }

  // 自动寻位放入：① 先填满已有同物品堆叠（遵守 stackOf 上限）② 剩余开新叠
  // 原子性（2026-09-26 弹药实体化）：任一叠放不下 → 整体失败并返回原 grid，**绝不丢数量**
  // （旧实现用 Math.min(stackMax, ...) 截断，超出部分被静默丢弃 —— 弹药实体化后后果严重）
  function addItem(grid, item, opts) {
    const o = opts || {};
    const itemId = typeof item === 'string' ? item : (item && item.itemId);
    if (!itemId) return { ok: false, grid, reason: 'no-item' };
    const count = Math.max(1, Math.floor(Number(typeof item === 'object' && item.count) || 1));
    const ammo = (typeof item === 'object' && item.ammo) || null;
    const mods = (typeof item === 'object' && item.mods) || null;
    const rot = o.rot !== undefined ? o.rot : (typeof item === 'object' ? item.rot : undefined);
    const stackable = isStackable(itemId) && o.stack !== false;
    const cap = stackable ? stackOf(itemId) : 1;
    const g = cloneGrid(grid);
    let left = count;
    let firstUid = null;
    let stackedAny = false;
    // ① 填入已有堆叠
    if (stackable) {
      for (const e of g.items) {
        if (left <= 0) break;
        if (e.itemId !== itemId) continue;
        const room = cap - (e.count || 1);
        if (room <= 0) continue;
        const put = Math.min(room, left);
        e.count = (e.count || 1) + put;
        left -= put;
        stackedAny = true;
        if (!firstUid) firstUid = e.uid;
      }
    }
    // ② 剩余开新叠（每叠 ≤ cap；不可堆叠物品每件独立占位）
    while (left > 0) {
      const put = stackable ? Math.min(cap, left) : 1;
      const e = makeEntry(itemId, {
        uid: (firstUid === null && o.uid) ? o.uid : undefined,
        count: put,
        ammo,
        mods
      });
      let spot = null;
      for (const r of (normRot(rot) === 1 ? [1, 0] : [0, 1])) {
        const s = findFreeSpot(g, itemId, r);
        if (s) { spot = { x: s.x, y: s.y, rot: r }; break; }
      }
      if (!spot) return { ok: false, grid, reason: 'no-space' }; // 原子回滚：原 grid 不变
      e.x = spot.x; e.y = spot.y; e.rot = spot.rot;
      g.items.push(e);
      if (!firstUid) firstUid = e.uid;
      left -= put;
    }
    return { ok: true, grid: g, stacked: stackedAny ? true : undefined, uid: firstUid, entry: findByUid(g, firstUid) };
  }

  // 拆分堆叠（供 Ctrl 拆分与整备界面）：把 uid 条目中的 take 个拆成新叠，自动寻空位
  // 失败（无空位/参数非法）→ 原样返回，原条目数量不变
  function splitStack(grid, uid, take) {
    const e0 = findByUid(grid, uid);
    const n = Math.floor(Number(take) || 0);
    if (!e0 || n <= 0) return { ok: false, grid, reason: 'bad-arg' };
    const have = e0.count || 1;
    if (n >= have) return { ok: false, grid, reason: 'nothing-to-split' };
    const g = cloneGrid(grid);
    const src = g.items.find(x => x.uid === uid);
    const ne = makeEntry(e0.itemId, { count: n, ammo: e0.ammo || null, mods: e0.mods || null });
    let spot = null;
    for (const r of (normRot(e0.rot) === 1 ? [1, 0] : [0, 1])) {
      const s = findFreeSpot(g, e0.itemId, r);
      if (s) { spot = { x: s.x, y: s.y, rot: r }; break; }
    }
    if (!spot) return { ok: false, grid, reason: 'no-space' };
    ne.x = spot.x; ne.y = spot.y; ne.rot = spot.rot;
    g.items.push(ne);
    src.count = have - n;
    return { ok: true, grid: g, entry: ne };
  }

  function removeAt(grid, uid) {
    const idx = ((grid && grid.items) || []).findIndex(e => e.uid === uid);
    if (idx < 0) return { ok: false, grid, removed: null };
    const g = cloneGrid(grid);
    const removed = g.items.splice(idx, 1)[0];
    return { ok: true, grid: g, removed };
  }
  function moveItem(grid, uid, x, y, rot) {
    const e = findByUid(grid, uid);
    if (!e) return { ok: false, grid, reason: 'no-such-uid' };
    const probe = cloneEntry(e);
    probe.rot = (rot === undefined ? e.rot : normRot(rot));
    if (!canPlace(grid, probe, x, y, { skipUid: uid })) return { ok: false, grid, reason: 'occupied-or-out-of-bounds' };
    const g = cloneGrid(grid);
    const t = g.items.find(i => i.uid === uid);
    t.x = Math.floor(Number(x)); t.y = Math.floor(Number(y)); t.rot = probe.rot;
    return { ok: true, grid: g, entry: t };
  }
  // 旋转：优先原地，空间不足则自动换位（供拖拽中按 R 旋转）
  function rotateItem(grid, uid, opts) {
    const e = findByUid(grid, uid);
    if (!e) return { ok: false, grid, reason: 'no-such-uid' };
    const o = opts || {};
    const rot = normRot(e.rot) === 1 ? 0 : 1;
    const x = o.x === undefined ? e.x : o.x;
    const y = o.y === undefined ? e.y : o.y;
    const probe = cloneEntry(e); probe.rot = rot;
    if (canPlace(grid, probe, x, y, { skipUid: uid })) return moveItem(grid, uid, x, y, rot);
    const spot = findFreeSpot(grid, e.itemId, rot, uid);
    if (!spot) return { ok: false, grid, reason: 'no-space' };
    return moveItem(grid, uid, spot.x, spot.y, rot);
  }
  function resize(grid, w, h) {
    const gw = Math.max(1, Math.floor(Number(w) || 1));
    const gh = Math.max(1, Math.floor(Number(h) || 1));
    for (const e of ((grid && grid.items) || [])) {
      const [ww, hh] = footprint(e.itemId, e.rot);
      if (e.x < 0 || e.y < 0 || e.x + ww > gw || e.y + hh > gh) return { ok: false, grid, reason: 'items-out-of-bounds' };
    }
    const g = cloneGrid(grid);
    g.w = gw; g.h = gh;
    return { ok: true, grid: g };
  }

  // ---------- 容错修复 ----------
  function _autoPlaceInto(g, e) {
    const order = e.rot === 0 ? [0, 1] : [1, 0];
    for (const rot of order) {
      const spot = findFreeSpot(g, e.itemId, rot, e.uid);
      if (spot) { e.rot = rot; e.x = spot.x; e.y = spot.y; return true; }
    }
    return false;
  }
  // 规范化网格：补 uid/rot/count，越界重定位，重叠解冲突，装不下 → overflow（绝不丢）
  // 返回 { grid, repaired:[{uid,itemId,action}], overflow:[entry] }
  function normalizeGrid(input, opts) {
    const o = opts || {};
    const c = gridCfg();
    const src = (input && typeof input === 'object') ? input : {};
    const g = {
      w: Math.max(1, Math.floor(Number(src.w) || Number(o.w) || c.w)),
      h: Math.max(1, Math.floor(Number(src.h) || Number(o.h) || c.h)),
      items: []
    };
    const repaired = [], overflow = [], seen = new Set();
    const list = Array.isArray(src.items) ? src.items : [];
    for (const raw of list) {
      if (!raw || !raw.itemId) continue;
      const e = makeEntry(raw.itemId, raw);
      if (raw.uid) e.uid = String(raw.uid);
      if (seen.has(e.uid)) { e.uid = makeUid(); repaired.push({ uid: e.uid, itemId: e.itemId, action: 'uid-fixed' }); }
      seen.add(e.uid);
      const [w, h] = footprint(e.itemId, e.rot);
      const outOfBounds = e.x < 0 || e.y < 0 || e.x + w > g.w || e.y + h > g.h;
      const overlapping = !outOfBounds && !canPlace(g, e, e.x, e.y);
      if (outOfBounds || overlapping) {
        if (_autoPlaceInto(g, e)) repaired.push({ uid: e.uid, itemId: e.itemId, action: outOfBounds ? 'repositioned' : 'deduped' });
        else { overflow.push(e); repaired.push({ uid: e.uid, itemId: e.itemId, action: 'overflow' }); continue; }
      }
      g.items.push(e);
    }
    // 自动扩容（迁移老档案用）：逐行加高直到装下或达到上限
    const maxGrow = o.maxGrow === undefined ? 60 : Math.max(0, Math.floor(o.maxGrow));
    if (overflow.length && o.autoGrow !== false) {
      const cap = g.h + maxGrow;
      while (overflow.length && g.h < cap) {
        g.h += 1;
        for (let i = overflow.length - 1; i >= 0; i--) {
          const e = overflow[i];
          if (_autoPlaceInto(g, e)) { overflow.splice(i, 1); g.items.push(e); }
        }
      }
    }
    return { grid: g, repaired, overflow };
  }

  // ---------- 迁移适配器（P3 用；P1 先冻结接口） ----------
  // 旧档案数组 → 网格。旧武器条目 {weaponId, mods, ammo} 映射到 loot 表的 w_<id>（尺寸来源）
  function legacyItemIdOf(stashItem) {
    if (!stashItem) return null;
    if (stashItem.weaponId) {
      const lid = 'w_' + stashItem.weaponId;
      return (ITEMS.LOOT && ITEMS.LOOT[lid]) ? lid : stashItem.weaponId;
    }
    return stashItem.itemId || null;
  }
  function fromLegacyStash(stash, opts) {
    const c = gridCfg();
    const items = [];
    for (const s of (Array.isArray(stash) ? stash : [])) {
      const itemId = legacyItemIdOf(s);
      if (!itemId) continue;
      const e = { itemId, count: s.weaponId ? 1 : (s.count || 1), rot: 0 };
      if (s.mods) e.mods = { ...s.mods };
      if (s.ammo) e.ammo = { ...s.ammo };
      items.push(e);
    }
    return normalizeGrid({ w: (opts && opts.w) || c.w, h: (opts && opts.h) || c.h, items }, opts);
  }
  // 网格 → 旧数组（供既有纯函数 settleRaid / tradeProfile / takeCarry 复用）
  // opts.preserveUid：保留每个条目的独立 uid（**不做同 itemId 合并**）——
  //   弹药实体化后多叠同名弹药必须各自成条，否则 syncProfile 按 uid 认领时会误删多余叠（数据丢失）
  function toLegacyStash(grid, opts) {
    const preserveUid = !!(opts && opts.preserveUid);
    const out = [];
    for (const e of ((grid && grid.items) || [])) {
      const d = defOf(e.itemId);
      if (d && (d.weaponId || d.ammoType)) {
        const w = {
          weaponId: d.weaponId || e.itemId,
          mods: e.mods ? { ...e.mods } : {},
          ammo: e.ammo ? { ...e.ammo } : { ammoId: d.ammoType, count: d.magSize || 0 }
        };
        if (preserveUid && e.uid) w.uid = e.uid;
        out.push(w);
      } else if (preserveUid) {
        out.push({ uid: e.uid, itemId: e.itemId, count: e.count || 1 });
      } else {
        const hit = out.find(x => x.itemId === e.itemId);
        if (hit) hit.count = (hit.count || 1) + (e.count || 1);
        else out.push({ itemId: e.itemId, count: e.count || 1 });
      }
    }
    return out;
  }
  // 弹药实体化迁移（2026-09-26）：老档案的 ammoLib 数值 → 仓库**实体弹药堆叠**
  // **幂等设计（关键）**：只补「ammoLib 值 − 仓库已有实体弹药量」的**差额**。
  //   → 联机档案多轮往返（服务器↔客户端）不会重复计入；ammoLib 变为派生值后再调用自然无动作。
  // 容错：逐叠 addItem（原子），补不进去的差额原样留在 ammoLib —— **绝不丢资产**
  // 返回 { grid, moved, leftover }
  function ammoLibToGrid(grid, ammoLib) {
    const lib = (ammoLib && typeof ammoLib === 'object') ? ammoLib : {};
    let g = grid;
    const moved = {}, leftover = {};
    for (const cal of Object.keys(lib)) {
      const want = Math.max(0, Math.floor(Number(lib[cal]) || 0));
      if (want <= 0) continue;
      let left = want - countOf(g, cal);   // 只补差额（幂等）
      if (left <= 0) continue;
      const cap = Math.max(1, stackOf(cal));
      let done = 0;
      while (left > 0) {
        const put = Math.min(cap, left);
        const r = addItem(g, { itemId: cal, count: put });
        if (!r.ok) break;              // 原子失败：g 未变，剩余量原样保留
        g = r.grid;
        done += put;
        left -= put;
      }
      if (done > 0) moved[cal] = done;
      if (left > 0) leftover[cal] = left;
    }
    return { grid: g, moved, leftover };
  }

  // 档案迁移（容错）：无 grid 则从 stash 建；有则规范化；并双写 stash（过渡期兼容既有代码）
  // 返回 { profile, repaired, overflow, migrated }
  function migrateProfile(profile, opts) {
    const p = { ...(profile || {}) };
    const hadGrid = !!(p.grid && Array.isArray(p.grid.items));
    const res = hadGrid ? normalizeGrid(p.grid, opts) : fromLegacyStash(p.stash, opts);
    p.grid = res.grid;
    p.equipment = { ...makeEquipment(), ...(p.equipment && typeof p.equipment === 'object' ? p.equipment : {}) };
    // 弹药实体化（2026-09-26）：ammoLib 数值 → 仓库实体堆叠；迁不动的留在 ammoLib（绝不丢）
    const ammoRes = ammoLibToGrid(p.grid, p.ammoLib);
    p.grid = ammoRes.grid;
    p.ammoLib = { ...ammoRes.leftover };
    p.ammoLibMoved = ammoRes.moved;
    // preserveUid：多叠同名弹药必须各自成条，否则 syncProfile 按 uid 认领时会误删多余叠
    p.stash = toLegacyStash(p.grid, { preserveUid: true });
    // 溢出条目回填 stash：宁可不在格子中，也绝不丢玩家资产
    for (const e of res.overflow) {
      const d = defOf(e.itemId);
      if (d && (d.weaponId || d.ammoType)) {
        p.stash.push({
          weaponId: d.weaponId || e.itemId,
          mods: e.mods ? { ...e.mods } : {},
          ammo: e.ammo ? { ...e.ammo } : { ammoId: d.ammoType, count: d.magSize || 0 }
        });
      } else {
        const hit = p.stash.find(x => x.itemId === e.itemId);
        if (hit) hit.count = (hit.count || 1) + (e.count || 1);
        else p.stash.push({ itemId: e.itemId, count: e.count || 1 });
      }
    }
    return { profile: p, repaired: res.repaired, overflow: res.overflow, migrated: !hadGrid };
  }

  // ---------- 装备槽（D2：只搭框架；D5：slot 为数组） ----------
  function makeEquipment() {
    const eq = {};
    for (const s of equipSlots()) eq[s] = null;
    return eq;
  }
  function equipEntry(item, opts) {
    const o = opts || {};
    const itemId = typeof item === 'string' ? item : (item && item.itemId);
    const e = { uid: o.uid || makeUid('e'), itemId, count: Math.max(1, Math.floor(Number(o.count || (item && item.count)) || 1)) };
    const ammo = o.ammo || (typeof item === 'object' && item.ammo);
    const mods = o.mods || (typeof item === 'object' && item.mods);
    if (ammo) e.ammo = { ...ammo };
    if (mods) e.mods = { ...mods };
    return e;
  }
  function canEquip(equipment, itemId, slot) {
    if (slotsFor(itemId).indexOf(slot) < 0) return false;
    if (equipSlots().indexOf(slot) < 0) return false;
    return !(equipment && equipment[slot]);
  }
  // 放入槽位（覆盖已有 → 返回 replaced，由调用方决定归还仓库）
  function equip(equipment, item, slot) {
    const eq = { ...makeEquipment(), ...(equipment || {}) };
    const itemId = typeof item === 'string' ? item : (item && item.itemId);
    if (equipSlots().indexOf(slot) < 0) return { ok: false, equipment: eq, replaced: null, reason: 'unknown-slot' };
    if (slotsFor(itemId).indexOf(slot) < 0) return { ok: false, equipment: eq, replaced: null, reason: 'slot-not-allowed' };
    const replaced = eq[slot] || null;
    eq[slot] = equipEntry(item, typeof item === 'object' ? { uid: item.uid, count: item.count } : {});
    return { ok: true, equipment: eq, replaced };
  }
  function unequip(equipment, slot) {
    const eq = { ...makeEquipment(), ...(equipment || {}) };
    if (!eq[slot]) return { ok: false, equipment: eq, item: null };
    const item = eq[slot];
    eq[slot] = null;
    return { ok: true, equipment: eq, item };
  }
  function equippedItemIds(equipment) {
    const out = [];
    for (const s of equipSlots()) if (equipment && equipment[s]) out.push(equipment[s].itemId);
    return out;
  }
  // 拖拽语义：仓库 → 槽位（从网格移除；槽位被占或槽位不符则失败，调用方先卸下）
  function equipFromGrid(grid, equipment, uid, slot) {
    const e = findByUid(grid, uid);
    const eq0 = { ...makeEquipment(), ...(equipment || {}) };
    if (!e) return { ok: false, grid, equipment: eq0, reason: 'no-such-uid' };
    if (equipSlots().indexOf(slot) < 0) return { ok: false, grid, equipment: eq0, reason: 'unknown-slot' };
    if (slotsFor(e.itemId).indexOf(slot) < 0) return { ok: false, grid, equipment: eq0, reason: 'slot-not-allowed' };
    if (eq0[slot]) return { ok: false, grid, equipment: eq0, reason: 'slot-occupied' };
    const rm = removeAt(grid, uid);
    eq0[slot] = equipEntry({ itemId: e.itemId, count: e.count, ammo: e.ammo, mods: e.mods }, { uid: e.uid });
    return { ok: true, grid: rm.grid, equipment: eq0, replaced: null };
  }
  // 拖拽语义：槽位 → 仓库（自动寻位；无空位则拒绝，槽位保持不变）
  function unequipToGrid(grid, equipment, slot, opts) {
    const eq0 = { ...makeEquipment(), ...(equipment || {}) };
    const it = eq0[slot];
    if (!it) return { ok: false, grid, equipment: eq0, reason: 'slot-empty' };
    const res = addItem(grid, { itemId: it.itemId, count: it.count, ammo: it.ammo, mods: it.mods },
      { uid: it.uid, rot: (opts && opts.rot) || 0 });
    if (!res.ok) return { ok: false, grid, equipment: eq0, reason: res.reason };
    eq0[slot] = null;
    return { ok: true, grid: res.grid, equipment: eq0 };
  }

  const Grid = {
    DEFAULT_SIZE, SLOT_ORDER,
    gridCfg, equipSlots,
    defOf, isWeaponId, itemSize, slotsFor, isStackable,
    normRot, footprint, makeUid,
    makeGrid, cloneGrid, cloneEntry, cellsOf, occupancy, totalCells, usedCells, freeCells, countOf,
    canPlace, findFreeSpot, makeEntry, place, addItem, findByUid, removeAt, moveItem, rotateItem, resize,
    normalizeGrid, fromLegacyStash, toLegacyStash, migrateProfile, legacyItemIdOf, stackOf, splitStack, ammoLibToGrid,
    makeEquipment, equipEntry, canEquip, equip, unequip, equippedItemIds, equipFromGrid, unequipToGrid
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Grid;
  if (typeof window !== 'undefined') window.EXFIL_GRID = Grid;
})();
