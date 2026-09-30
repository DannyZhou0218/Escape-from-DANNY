'use strict';
(function () {
  /*
   * EXFIL ZONE · shared/containers.js — 装备容器空间（纯逻辑，Node 与浏览器共用）
   * ---------------------------------------------------------------------------
   * 任务 B 批次 B1（2026-09-26，用户决策：Q1 胸挂/背包分开 · Q2 先矩形起步）
   *
   * 语义（塔科夫原版）：
   *   装备（胸挂 rig / 背包 backpack）本身是一个**容器**，有内部格子空间。
   *   穿不同胸挂 → 中间携带区的格子尺寸不同。
   *   胸挂内物品可快捷使用，背包内不可（快捷使用的**执行**在 B4，本库只管空间）。
   *
   * 与 grid.js 的分工（重要）：
   *   grid.js       仓库（profile.grid）与装备槽（profile.equipment）——**档案权威**
   *   containers.js 容器内部空间（profile.containers）——**同一套格子系统，平行结构**
   *
   * 为什么平行而不嵌套进 equipment.rig：
   *   槽位条目（equipment.rig）是**物品本身**（{uid,itemId}），
   *   容器空间是**它的内部**（{w,h,items[]}）。
   *   平行结构让 grid.js 的纯函数可直接复用，无需为「嵌套容器」另写算法。
   *
   * 数据模型：
   *   profile.containers = {
   *     rig:      { w, h, items: [ {uid,itemId,x,y,rot,count,ammo?,mods?} ] },
   *     backpack: { w, h, items: [...] }
   *   }
   *   物品侧规格（content.json）：装备物品带 container: { w, h }
   *
   * 硬边界：
   *   ① 全部纯函数：不修改入参，一律返回新对象
   *   ② 容错优先：脏数据不抛错；放不下则**保留原处**，绝不丢件
   *   ③ 迁移幂等：重复调用不翻倍（参照 grid.ammoLibToGrid 的差额设计）
   *   ④ 不改联机协议字段名（E045 教训）
   */

  const Grid = (typeof module !== 'undefined' && module.exports)
    ? require('./grid')
    : (typeof window !== 'undefined' && window.EXFIL_GRID ? window.EXFIL_GRID : null);

  const ConfigLib = (typeof module !== 'undefined' && module.exports)
    ? require('./config')
    : (typeof window !== 'undefined' && window.EXFIL_CONFIG_LIB ? window.EXFIL_CONFIG_LIB : null);
  const CFG = (ConfigLib && ConfigLib.CFG) || {};

  // ---------- 配置（使用点直读，热重载安全；禁止拷进模块级常量） ----------
  function containersCfg() {
    const g = CFG.grid || {};
    const c = g.containers || {};
    const num = function (v, d) { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : d; };
    return {
      maxDim: num(c.maxDim, 20),          // 单边上限（防脏数据把容器撑到无限大）
      fallbackRig: { w: num(c.fallbackRigW, 4), h: num(c.fallbackRigH, 1) },
      fallbackBackpack: { w: num(c.fallbackBackpackW, 5), h: num(c.fallbackBackpackH, 3) }
    };
  }

  // 哪些槽位是「容器槽」（装备后产生内部空间）
  const CONTAINER_SLOTS = ['rig', 'backpack'];

  function isContainerSlot(slot) { return CONTAINER_SLOTS.indexOf(slot) >= 0; }

  // ---------- 规格查询 ----------
  // 物品的容器规格（content.json 的 container 字段）；无则返回 null（非容器物品）
  function specOfItem(itemId) {
    if (!itemId || !Grid) return null;
    const d = Grid.defOf(itemId);
    const c = d && d.container;
    if (!c) return null;
    const cap = containersCfg();
    const w = Math.min(cap.maxDim, Math.max(1, Math.floor(Number(c.w) || 1)));
    const h = Math.min(cap.maxDim, Math.max(1, Math.floor(Number(c.h) || 1)));
    return { w: w, h: h };
  }

  // 槽位对应的容器规格：取该槽已装备物品的 container；**未装备则无空间（null）**
  //
  // 语义决策（塔科夫原版）：没穿胸挂 = 没有携带空间，不能给默认空间。
  // 因此 fallback 只用于「已装备但物品未定义 container 规格」的兜底，
  // 不用于「未装备」——未装备一律返回 null（无空间）。
  function specOfSlot(equipment, slot) {
    if (!isContainerSlot(slot)) return null;
    const e = equipment && equipment[slot];
    if (!e || !e.itemId) return null;          // 未装备 → 无携带空间
    const spec = specOfItem(e.itemId);
    if (spec) return spec;
    // 已装备但规格缺失（内容表未定义 container）→ 用 fallback 兜底，避免装备了却完全无空间
    const cap = containersCfg();
    return slot === 'rig' ? { ...cap.fallbackRig } : { ...cap.fallbackBackpack };
  }

  // ---------- 容器构造与克隆（纯函数基础） ----------
  function makeContainer(w, h) {
    const cap = containersCfg();
    return {
      w: Math.min(cap.maxDim, Math.max(1, Math.floor(Number(w) || 1))),
      h: Math.min(cap.maxDim, Math.max(1, Math.floor(Number(h) || 1))),
      items: []
    };
  }
  function cloneContainer(c) {
    if (!Grid) return { w: 0, h: 0, items: [] };
    return Grid.cloneGrid(c);
  }
  // 空容器集合（两个槽都为 null —— 未装备时无携带空间）
  function emptyContainers() {
    // 注意：这里用 null 表示「该槽未装备 → 无空间」，与「空容器 {w,h,items:[]}」语义不同
    return { rig: null, backpack: null };
  }

  // ---------- 档案侧读取 ----------
  function containersOf(profile) {
    const c = (profile && profile.containers && typeof profile.containers === 'object') ? profile.containers : null;
    if (!c) return emptyContainers();
    const out = emptyContainers();
    for (const slot of CONTAINER_SLOTS) {
      const v = c[slot];
      // 只接受形态正确的容器（有 items 数组）；否则视为未装备
      if (v && typeof v === 'object' && Array.isArray(v.items) && v.w > 0 && v.h > 0) {
        out[slot] = Grid ? Grid.cloneGrid(v) : v;
      }
    }
    return out;
  }

  function containerOf(profile, slot) {
    if (!isContainerSlot(slot)) return null;
    const all = containersOf(profile);
    return all[slot] || null;
  }

  // ---------- 统计（供 UI 显示容量） ----------
  function containerStats(profile) {
    const all = containersOf(profile);
    const out = {};
    for (const slot of CONTAINER_SLOTS) {
      const g = all[slot];
      if (!g) { out[slot] = { equipped: false, used: 0, total: 0, free: 0 }; continue; }
      out[slot] = {
        equipped: true,
        used: Grid ? Grid.usedCells(g) : 0,
        total: Grid ? Grid.totalCells(g) : 0,
        free: Grid ? Grid.freeCells(g) : 0
      };
    }
    return out;
  }

  // 容器内条目总重量（供负重显示；当前 sim 负重不含容器，B3 起可接）
  function containerWeight(profile) {
    let sum = 0;
    const all = containersOf(profile);
    for (const slot of CONTAINER_SLOTS) {
      const g = all[slot];
      if (!g || !Grid) continue;
      for (const e of g.items) {
        const d = Grid.defOf(e.itemId);
        const w = (d && Number(d.weight)) || 0;
        sum += w * (e.count || 1);
      }
    }
    return sum;
  }

  // ---------- 按装备重建容器（纯函数） ----------
  // 换装时调用：把容器规格对齐到当前装备。
  // 语义（塔科夫）：换小容器 → 原有物品放不下 → **退回仓库**（绝不销毁）。
  // 返回 { containers, overflow:[{itemId,count}] } —— overflow 由调用方放回仓库
  function rebuildForSlot(profile, slot) {
    if (!isContainerSlot(slot)) {
      return { containers: containersOf(profile), overflow: [], changed: false };
    }
    const all = containersOf(profile);
    const eq = (profile && profile.equipment) || {};
    const spec = specOfSlot(eq, slot);
    const old = all[slot];
    const overflow = [];

    // 未装备 → 容器消失，内部物品全部退出（overflow）
    if (!spec) {
      if (old) for (const e of old.items) overflow.push({ itemId: e.itemId, count: e.count || 1, ammo: e.ammo, mods: e.mods });
      all[slot] = null;
      return { containers: all, overflow: overflow, changed: !!old };
    }

    // 规格未变 → 原样保留（**幂等**：重复调用不动任何物品）
    if (old && old.w === spec.w && old.h === spec.h) {
      return { containers: all, overflow: [], changed: false };
    }

    // 规格变化 → 逐个重新放入新容器；放不下的 exit（overflow）
    let fresh = makeContainer(spec.w, spec.h);
    if (old) {
      for (const e of old.items) {
        const put = Grid ? Grid.addItem(fresh, {
          itemId: e.itemId, count: e.count || 1, ammo: e.ammo, mods: e.mods, uid: e.uid
        }) : { ok: false };
        if (put.ok) fresh = put.grid;
        else overflow.push({ itemId: e.itemId, count: e.count || 1, ammo: e.ammo, mods: e.mods });
      }
    }
    all[slot] = fresh;
    return { containers: all, overflow: overflow, changed: true };
  }

  // 按当前装备重建**全部**容器槽（进图/整备界面刷新时调用）
  // 返回 { containers, overflow:[{slot,itemId,count}] }
  function rebuildAll(profile) {
    const eq = (profile && profile.equipment) || {};
    let cur = containersOf(profile);
    const overflow = [];
    for (const slot of CONTAINER_SLOTS) {
      const r = rebuildForSlot({ ...(profile || {}), containers: cur }, slot);
      cur = r.containers;
      for (const o of r.overflow) overflow.push({ slot: slot, itemId: o.itemId, count: o.count, ammo: o.ammo, mods: o.mods });
    }
    return { containers: cur, overflow: overflow };
  }

  // ---------- 老档案迁移：carry（数值清单）→ containers（幂等，绝不丢资产） ----------
  // 旧格式：profile.carry = { ammo: { 口径: 发数 }, items: [{ itemId, count }] }
  // 迁移策略：
  //   ① 弹药（ammo）→ 优先放入 rig（胸挂），放不下再放 backpack
  //   ② 物资（items）→ 优先放入 backpack，放不下再放 rig
  //   ③ 仍放不下 → **原样保留在 carry 字段**（调用方不得清除），下次腾空后再补
  //   ④ **幂等**：只补「carry 记录的量 − 容器内已有的量」的差额
  // 返回 { containers, carry, moved, leftover }
  function migrateCarry(profile) {
    const all = containersOf(profile);
    const oldCarry = (profile && profile.carry && typeof profile.carry === 'object') ? profile.carry : null;
    if (!oldCarry || !Grid) return { containers: all, carry: oldCarry, moved: false, leftover: null };

    const moved = { ammo: {}, items: [] };
    const leftAmmo = {};
    const leftItems = [];

    // 当前容器内已有量（用于幂等差额）
    function countIn(slot, itemId) {
      const g = all[slot];
      if (!g) return 0;
      let n = 0;
      for (const e of g.items) if (e.itemId === itemId) n += (e.count || 1);
      return n;
    }
    function totalIn(itemId) { return countIn('rig', itemId) + countIn('backpack', itemId); }
    function tryPut(order, itemId, need) {
      let left = need;
      for (const slot of order) {
        if (left <= 0) break;
        const g = all[slot];
        if (!g) continue;
        const cap = Math.max(1, Grid.stackOf(itemId));
        while (left > 0) {
          const put = Math.min(cap, left);
          const r = Grid.addItem(g, { itemId: itemId, count: put });
          if (!r.ok) break;
          all[slot] = r.grid;
          left -= put;
        }
      }
      return left;
    }

    // ① 弹药 → 优先 rig，其次 backpack
    const ammoOrder = ['rig', 'backpack'];
    for (const cal of Object.keys(oldCarry.ammo || {})) {
      const want = Math.max(0, Math.floor(Number((oldCarry.ammo || {})[cal]) || 0));
      if (want <= 0) continue;
      const already = totalIn(cal);
      const need = want - already;      // 幂等差额
      if (need <= 0) continue;
      const left = tryPut(ammoOrder, cal, need);
      if (left < need) moved.ammo[cal] = (moved.ammo[cal] || 0) + (need - left);
      if (left > 0) leftAmmo[cal] = (leftAmmo[cal] || 0) + left;
    }

    // ② 物资 → 优先 backpack，其次 rig
    const itemOrder = ['backpack', 'rig'];
    for (const it of (oldCarry.items || [])) {
      if (!it || !it.itemId) continue;
      const want = Math.max(0, Math.floor(Number(it.count) || 0));
      if (want <= 0) continue;
      const already = totalIn(it.itemId);
      const need = want - already;      // 幂等差额
      if (need <= 0) continue;
      const left = tryPut(itemOrder, it.itemId, need);
      const done = need - left;
      if (done > 0) moved.items.push({ itemId: it.itemId, count: done });
      if (left > 0) leftItems.push({ itemId: it.itemId, count: left });
    }

    const leftover = (Object.keys(leftAmmo).length || leftItems.length)
      ? { ammo: leftAmmo, items: leftItems }
      : null;

    return { containers: all, carry: leftover, moved: (Object.keys(moved.ammo).length > 0 || moved.items.length > 0), leftover: leftover };
  }

  // ---------- B2：容器内物品操作（纯函数，返回新 containers） ----------
  // 统一返回 { ok, containers, reason? }；失败时 containers 原样返回（原子）
  // 全部 **uid 锚定**（项目铁律 6：禁止裸下标）

  function _setSlot(all, slot, g) {
    const out = { ...all };
    out[slot] = g;
    return out;
  }

  // 放入容器（优先填已有堆叠；放不下 → 原子拒绝）
  // item = { itemId, count, ammo?, mods?, uid? } | itemId 字符串
  function putInto(profile, slot, item) {
    const all = containersOf(profile);
    if (!isContainerSlot(slot)) return { ok: false, containers: all, reason: 'not-container-slot' };
    const g = all[slot];
    if (!g) return { ok: false, containers: all, reason: 'no-container' };   // 未装备 → 无空间
    const r = Grid ? Grid.addItem(g, item) : { ok: false };
    if (!r.ok) return { ok: false, containers: all, reason: r.reason || 'no-space' };
    return { ok: true, containers: _setSlot(all, slot, r.grid), uid: r.uid };
  }

  // 从容器取出（整条移除，返回被移除条目）
  function takeFrom(profile, slot, uid) {
    const all = containersOf(profile);
    if (!isContainerSlot(slot)) return { ok: false, containers: all, reason: 'not-container-slot' };
    const g = all[slot];
    if (!g) return { ok: false, containers: all, reason: 'no-container' };
    const r = Grid ? Grid.removeAt(g, uid) : { ok: false };
    if (!r.ok) return { ok: false, containers: all, reason: 'no-such-uid' };
    return { ok: true, containers: _setSlot(all, slot, r.grid), removed: r.removed };
  }

  // 从容器取出一部分（拆分；take >= 全部时等价 takeFrom）
  function takeFromPartial(profile, slot, uid, take) {
    const all = containersOf(profile);
    if (!isContainerSlot(slot)) return { ok: false, containers: all, reason: 'not-container-slot' };
    const g = all[slot];
    if (!g) return { ok: false, containers: all, reason: 'no-container' };
    const e = Grid ? Grid.findByUid(g, uid) : null;
    if (!e) return { ok: false, containers: all, reason: 'no-such-uid' };
    const have = e.count || 1;
    const n = Math.max(0, Math.floor(Number(take) || 0));
    if (n <= 0) return { ok: false, containers: all, reason: 'bad-arg' };
    if (n >= have) {
      const r = Grid.removeAt(g, uid);
      if (!r.ok) return { ok: false, containers: all, reason: 'no-such-uid' };
      return { ok: true, containers: _setSlot(all, slot, r.grid), removed: r.removed, whole: true };
    }
    // 拆一半：改原条目数量 + 返回拆出部分
    const g2 = Grid.cloneGrid(g);
    const e2 = Grid.findByUid(g2, uid);
    e2.count = have - n;
    return {
      ok: true,
      containers: _setSlot(all, slot, g2),
      removed: { uid: Grid.makeUid(), itemId: e2.itemId, count: n, ammo: e2.ammo, mods: e2.mods },
      whole: false
    };
  }

  // 容器内移动/旋转（uid 锚定）
  function moveIn(profile, slot, uid, x, y, rot) {
    const all = containersOf(profile);
    if (!isContainerSlot(slot)) return { ok: false, containers: all, reason: 'not-container-slot' };
    const g = all[slot];
    if (!g) return { ok: false, containers: all, reason: 'no-container' };
    const r = Grid ? Grid.moveItem(g, uid, x, y, rot) : { ok: false };
    if (!r.ok) return { ok: false, containers: all, reason: r.reason || 'no-such-uid' };
    return { ok: true, containers: _setSlot(all, slot, r.grid) };
  }
  function rotateIn(profile, slot, uid) {
    const all = containersOf(profile);
    if (!isContainerSlot(slot)) return { ok: false, containers: all, reason: 'not-container-slot' };
    const g = all[slot];
    if (!g) return { ok: false, containers: all, reason: 'no-container' };
    const r = Grid ? Grid.rotateItem(g, uid) : { ok: false };
    if (!r.ok) return { ok: false, containers: all, reason: r.reason || 'no-such-uid' };
    return { ok: true, containers: _setSlot(all, slot, r.grid) };
  }

  // ---------- B2：跨容器 / 容器↔仓库 转移 ----------
  // 三个方向：仓库↔胸挂 / 仓库↔背包 / 胸挂↔背包
  // 语义：源取不到 或 目标放不下 → 整体原子失败（物品留在原处，绝不丢）
  //
  // 返回 { ok, profile, reason? } —— 直接产出**新档案**（含 grid 与 containers），
  // 由调用方经 syncProfile/_finalize 收敛（保证 stash/ammoLib 派生一致）
  function transferFromGrid(profile, gridUid, toSlot) {
    const all = containersOf(profile);
    if (!isContainerSlot(toSlot)) return { ok: false, reason: 'not-container-slot' };
    if (!all[toSlot]) return { ok: false, reason: 'no-container' };
    const grid = (profile && profile.grid) || null;
    if (!grid) return { ok: false, reason: 'no-grid' };
    const e = Grid.findByUid(grid, gridUid);
    if (!e) return { ok: false, reason: 'no-such-uid' };
    // 先尝试放入（失败则整体不动）
    const put = putInto({ containers: all }, toSlot, {
      itemId: e.itemId, count: e.count || 1, ammo: e.ammo, mods: e.mods
    });
    if (!put.ok) return { ok: false, reason: put.reason };
    // 放入成功 → 从仓库移除原条目
    const rm = Grid.removeAt(grid, gridUid);
    if (!rm.ok) return { ok: false, reason: 'no-such-uid' };
    return { ok: true, profile: { ...profile, grid: rm.grid, containers: put.containers } };
  }

  function transferToGrid(profile, slot, uid) {
    const all = containersOf(profile);
    if (!isContainerSlot(slot)) return { ok: false, reason: 'not-container-slot' };
    const g = all[slot];
    if (!g) return { ok: false, reason: 'no-container' };
    const e = Grid.findByUid(g, uid);
    if (!e) return { ok: false, reason: 'no-such-uid' };
    const grid = (profile && profile.grid) || null;
    if (!grid) return { ok: false, reason: 'no-grid' };
    // 先尝试放入仓库（失败则整体不动）
    const add = Grid.addItem(grid, { itemId: e.itemId, count: e.count || 1, ammo: e.ammo, mods: e.mods });
    if (!add.ok) return { ok: false, reason: add.reason || 'no-space' };
    const rm = Grid.removeAt(g, uid);
    if (!rm.ok) return { ok: false, reason: 'no-such-uid' };
    return { ok: true, profile: { ...profile, grid: add.grid, containers: _setSlot(all, slot, rm.grid) } };
  }

  // 容器 ↔ 容器（胸挂 ↔ 背包）
  function transferBetween(profile, fromSlot, uid, toSlot) {
    const all = containersOf(profile);
    if (!isContainerSlot(fromSlot) || !isContainerSlot(toSlot)) return { ok: false, reason: 'not-container-slot' };
    if (fromSlot === toSlot) return { ok: false, reason: 'same-container' };
    const src = all[fromSlot], dst = all[toSlot];
    if (!src) return { ok: false, reason: 'no-container' };
    if (!dst) return { ok: false, reason: 'no-container' };   // 目标未装备 → 拒绝
    const e = Grid.findByUid(src, uid);
    if (!e) return { ok: false, reason: 'no-such-uid' };
    const put = putInto({ containers: all }, toSlot, {
      itemId: e.itemId, count: e.count || 1, ammo: e.ammo, mods: e.mods
    });
    if (!put.ok) return { ok: false, reason: put.reason };
    const rm = Grid.removeAt(src, uid);
    if (!rm.ok) return { ok: false, reason: 'no-such-uid' };
    const next = _setSlot(put.containers, fromSlot, rm.grid);
    return { ok: true, profile: { ...profile, containers: next } };
  }

  // 容器 → 指定容器（快捷使用的 B4 会用到：胸挂可用、背包不可）
  function canQuickUse(slot) { return slot === 'rig'; }

  // ---------- 进图携带（B2-3）：容器 → 局内载荷 ----------
  // 语义（替代旧的数值 carry）：
  //   把 rig + backpack 内的**实体条目**作为进图载荷取出，并从档案中扣除。
  //   输出格式与旧 takeCarry **完全一致**（raidAmmo / raidItems）→ sim 层零改动。
  //   弹药（口径类 itemId）归入 raidAmmo（口径→发数）；其余归 raidItems。
  // 返回 { profile, raidAmmo, raidItems, taken }
  //
  // B4 增补（2026-09-26，**纯增量、向后兼容**）：每个 raidItems 条目带 `src`（来源槽位），
  //   并新增 raidAmmoRig / raidAmmoBag 两个明细对象。目的：让「胸挂内可快捷使用、背包内不可」
  //   的信息**一路带到局内**（E045 教训：来源信息一旦在进图时丢失就无法在 sim 侧恢复）。
  //   旧字段（raidAmmo / raidItems）**原样保留**，既有读取方零改动。
  function takeAll(profile) {
    const all = containersOf(profile);
    const raidAmmo = {};
    const raidAmmoRig = {};      // B4：胸挂内弹药（口径→发数）
    const raidAmmoBag = {};      // B4：背包内弹药（口径→发数）
    const raidItems = [];
    const taken = { rig: [], backpack: [] };
    const emptied = { ...all };

    // 顺序：先胸挂后背包（与塔科夫「优先取外层口袋」直觉一致；对结果无实质影响）
    for (const slot of CONTAINER_SLOTS) {
      const g = all[slot];
      if (!g) continue;
      for (const e of g.items) {
        const def = Grid ? Grid.defOf(e.itemId) : null;
        const n = e.count || 1;
        // 弹药类（口径）→ 口径:发数；与旧 ammoLib 语义一致。
        // 判定依据：物品定义 type === 'ammo'（口径物品的本质标识）；
        // 兼容 ammoType 字段（部分武器/口径表用该字段），避免单一依据失配。
        const isCal = !!(def && (def.type === 'ammo' || def.ammoType));
        if (isCal) {
          raidAmmo[e.itemId] = (raidAmmo[e.itemId] || 0) + n;
          if (slot === 'rig') raidAmmoRig[e.itemId] = (raidAmmoRig[e.itemId] || 0) + n;
          else raidAmmoBag[e.itemId] = (raidAmmoBag[e.itemId] || 0) + n;
        } else {
          raidItems.push({
            itemId: e.itemId,
            count: n,
            weight: (def && Number(def.weight)) || 0,
            ammo: e.ammo, mods: e.mods, uid: e.uid,
            src: slot                        // B4：来源槽位（'rig' | 'backpack'）
          });
        }
        taken[slot].push({ itemId: e.itemId, count: n });
      }
      emptied[slot] = { w: g.w, h: g.h, items: [] };   // 清空（保留空间规格）
    }
    return {
      profile: { ...profile, containers: emptied },
      raidAmmo: raidAmmo,
      raidAmmoRig: raidAmmoRig,      // B4 新增
      raidAmmoBag: raidAmmoBag,      // B4 新增
      raidItems: raidItems,
      taken: taken
    };
  }

  const Containers = {
    CONTAINER_SLOTS: CONTAINER_SLOTS,
    isContainerSlot: isContainerSlot,
    specOfItem: specOfItem,
    specOfSlot: specOfSlot,
    makeContainer: makeContainer,
    cloneContainer: cloneContainer,
    emptyContainers: emptyContainers,
    containersOf: containersOf,
    containerOf: containerOf,
    containerStats: containerStats,
    containerWeight: containerWeight,
    rebuildForSlot: rebuildForSlot,
    rebuildAll: rebuildAll,
    migrateCarry: migrateCarry,
    putInto: putInto,
    takeFrom: takeFrom,
    takeFromPartial: takeFromPartial,
    moveIn: moveIn,
    rotateIn: rotateIn,
    transferFromGrid: transferFromGrid,
    transferToGrid: transferToGrid,
    transferBetween: transferBetween,
    canQuickUse: canQuickUse,
    takeAll: takeAll
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Containers;
  if (typeof window !== 'undefined') window.EXFIL_CONTAINERS = Containers;
})();
