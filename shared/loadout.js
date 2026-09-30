'use strict';
(function () {
  /*
   * EXFIL ZONE · shared/loadout.js — 整备档案适配层（纯逻辑，Node 与浏览器共用）
   * ---------------------------------------------------------------------------
   * P2（2026-09-20）：把「格子化的装备/仓库」（grid + equipment）与**既有档案格式**
   * （profile.stash 数组）双向打通，让 settleRaid / takeCarry / tradeProfile /
   * computeRaidOutcome / join.stashIndex 等既有逻辑**零改动继续工作**。
   *
   * 核心契约（重要）：
   *   ① profile.stash 仍是「唯一对外格式」——由 legacyStash(grid, equipment) 派生，
   *      顺序固定 = [装备槽物品（武器槽在前）] + [仓库物品（row-major）]
   *   ② 派生出的 stash 条目**带 uid**（附加字段，既有代码用 {...s} 展开会自然保留），
   *      这是「位置不丢」的关键：syncProfile 按 uid 把 stash 的变化合并回 grid
   *   ③ 「出战武器」的 legacy 下标 = indexByUid(profile, uid) —— 保持 join.stashIndex
   *      与 computeRaidOutcome(..., selectedIdx, ...) 的既有语义
   *   ④ 全部纯函数（不修改入参）；容错优先（脏档案不抛错）
   */
  const ConfigLib = (typeof module !== 'undefined' && module.exports)
    ? require('./config')
    : (typeof window !== 'undefined' && window.EXFIL_CONFIG_LIB ? window.EXFIL_CONFIG_LIB : null);
  const CFG = (ConfigLib && ConfigLib.CFG) || {};

  const GridLib = (typeof module !== 'undefined' && module.exports)
    ? require('./grid')
    : (typeof window !== 'undefined' && window.EXFIL_GRID ? window.EXFIL_GRID : null);
  const Grid = GridLib || {};

  const ItemsLib = (typeof module !== 'undefined' && module.exports)
    ? require('./items')
    : (typeof window !== 'undefined' && window.EXFIL_ITEMS ? window.EXFIL_ITEMS : null);
  const Items = ItemsLib || {};

  // 任务 B · B1：装备容器内部空间（胸挂/背包）
  const ContainersLib = (typeof module !== 'undefined' && module.exports)
    ? require('./containers')
    : (typeof window !== 'undefined' && window.EXFIL_CONTAINERS ? window.EXFIL_CONTAINERS : null);
  const Containers = ContainersLib || null;

  // ---------- 基础 ----------
  // 装备槽顺序：武器槽在前（出战武器的 legacy 下标靠前，语义清晰）
  function slotOrder() {
    const all = (Grid.equipSlots ? Grid.equipSlots() : ['head', 'armor', 'rig', 'backpack', 'primary', 'secondary', 'melee']);
    const front = ['primary', 'secondary'];
    return front.concat(all.filter(s => front.indexOf(s) < 0));
  }
  function weaponSlots() { return ['primary', 'secondary']; }
  function entryDef(itemId) { return Grid.defOf ? Grid.defOf(itemId) : null; }
  function isWeaponItem(itemId) { const d = entryDef(itemId); return !!(d && (d.weaponId || d.ammoType)); }

  // 网格条目 → 旧档案条目（带 uid）
  function entryToStash(e) {
    const d = entryDef(e.itemId);
    if (d && (d.weaponId || d.ammoType)) {
      return {
        uid: e.uid,
        weaponId: d.weaponId || e.itemId,
        mods: e.mods ? { ...e.mods } : {},
        ammo: e.ammo ? { ...e.ammo } : { ammoId: d.ammoType, count: d.magSize || 0 }
      };
    }
    return { uid: e.uid, itemId: e.itemId, count: e.count || 1 };
  }
  // 旧档案条目 → 网格条目（保留 ammo/mods）
  function stashToEntry(s, itemId, uid) {
    const d = entryDef(itemId);
    const e = { uid: uid || s.uid || Grid.makeUid(), itemId, rot: 0, count: 0, x: 0, y: 0 };
    if (d && (d.weaponId || d.ammoType)) {
      e.count = 1;
      e.mods = s.mods ? { ...s.mods } : {};
      e.ammo = s.ammo ? { ...s.ammo } : { ammoId: d.ammoType, count: d.magSize || 0 };
    } else {
      e.count = Math.max(1, Math.floor(Number(s.count) || 1));
    }
    return e;
  }
  // 行列顺序（row-major）：保证 legacyStash 顺序稳定
  function gridOrder(items) {
    return items.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }

  // ---------- 档案 → 旧格式数组（派生） ----------
  function legacyStash(profile) {
    const p = profile || {};
    const out = [];
    const eq = p.equipment || {};
    for (const slot of slotOrder()) {
      const e = eq[slot];
      if (e && e.itemId) out.push(entryToStash(e));
    }
    const items = (p.grid && Array.isArray(p.grid.items)) ? p.grid.items : [];
    for (const e of gridOrder(items)) out.push(entryToStash(e));
    return out;
  }
  function indexByUid(profile, uid) {
    if (!uid) return -1;
    const stash = (profile && profile.stash) || [];
    return stash.findIndex(s => s && s.uid === uid);
  }
  function _entryOfUid(profile, uid) {
    const eq = (profile && profile.equipment) || {};
    for (const slot of slotOrder()) if (eq[slot] && eq[slot].uid === uid) return { where: 'slot', slot, entry: eq[slot] };
    const hit = Grid.findByUid(profile && profile.grid, uid);
    if (hit) return { where: 'grid', entry: hit };
    return null;
  }

  // ---------- 同步（stash 变化 → 合并回 grid/equipment；保留坐标） ----------
  // 返回 { profile, added, removed, changed, cleared, overflow }
  // ---------- 任务 B · B1：容器空间派生（syncProfile 与 _finalize 共用） ----------
  // 为什么必须共用：`syncProfile` 与 `_finalize` 是两条并行的「档案派生」路径。
  // 只在其中一条接入容器重建 → 另一条路径（装备/卸下/移动/旋转）不会更新容器，
  // 表现为「装上了胸挂但携带区没出现」。故抽成单一实现，两处调用。
  //
  // 语义：
  //   ① 按当前装备重建容器规格（换小容器/卸装备 → 放不下的物品退出）
  //   ② 老档 carry（数值清单）→ 容器实体迁移（幂等差额；仍放不下的保留在 carry）
  //   ③ 退出的物品**放回仓库**（绝不销毁）
  // 入参 profile：已含最终 grid / equipment / containers 的档案（不修改入参）
  // 返回 { profile, overflow }  —— overflow = 连仓库都放不下的（极端情况）
  function _applyContainers(profile, gridIn) {
    if (!Containers) return { profile: profile, overflow: [] };
    let grid = gridIn;
    const out = { ...profile };
    const rb = Containers.rebuildAll(out);
    out.containers = rb.containers;
    const mg = Containers.migrateCarry(out);
    out.containers = mg.containers;

    // 迁移后仍放不下的部分保留在 carry 字段（不清零）；全部迁完则清掉该字段
    if (mg.carry && ((mg.carry.ammo && Object.keys(mg.carry.ammo).length) || (mg.carry.items && mg.carry.items.length))) {
      out.carry = mg.carry;
    } else {
      delete out.carry;
    }

    // 容器退出的物品放回仓库（绝不销毁）；仓库也放不下的进入 overflow
    const overflow = [];
    for (const o of rb.overflow) {
      const r = Grid.addItem(grid, { itemId: o.itemId, count: o.count, ammo: o.ammo, mods: o.mods });
      if (r.ok) grid = r.grid; else overflow.push({ itemId: o.itemId, count: o.count });
    }
    out.grid = grid;
    return { profile: out, overflow: overflow };
  }

  function syncProfile(profile) {
    const p = { ...(profile || {}) };
    const stashIn = Array.isArray(p.stash) ? p.stash : [];
    const norm = (p.grid && Array.isArray(p.grid.items))
      ? Grid.normalizeGrid(p.grid, { maxGrow: 120 })
      : Grid.fromLegacyStash(stashIn, { maxGrow: 120 });
    let grid = norm.grid;
    const equipment = {};
    {
      const src = (p.equipment && typeof p.equipment === 'object') ? p.equipment : {};
      const slots = Grid.makeEquipment();
      for (const slot of Object.keys(slots)) slots[slot] = src[slot] ? Grid.cloneEntry(src[slot]) : null;
      Object.assign(equipment, slots);
    }
    const added = [], removed = [], changed = [], cleared = [], overflow = [];
    const claimedGrid = new Set();   // 已被 stash 认领的 grid 条目 uid
    const claimedSlot = new Set();   // 已被 stash 认领的槽位

    for (const s of stashIn) {
      if (!s) continue;
      const lid = Grid.legacyItemIdOf(s);
      if (!lid) continue;
      // ① 优先按 uid 精确认领（位置稳定）
      let target = null, where = null, key = null;
      if (s.uid) {
        const inGrid = grid.items.find(e => e.uid === s.uid && !claimedGrid.has(e.uid));
        if (inGrid) { target = inGrid; where = 'grid'; key = inGrid.uid; }
        else {
          for (const slot of slotOrder()) {
            if (claimedSlot.has(slot)) continue;
            if (equipment[slot] && equipment[slot].uid === s.uid) { target = equipment[slot]; where = 'slot'; key = slot; break; }
          }
        }
      }
      // ② 退化为按 itemId 顺序匹配（联机档案：服务器不下发 uid）
      if (!target) {
        const cand = grid.items.filter(e => !claimedGrid.has(e.uid) && e.itemId === lid);
        if (cand.length) { target = cand[0]; where = 'grid'; key = cand[0].uid; }
      }
      // ③ 新物品 → 入格
      if (!target) {
        const res = Grid.addItem(grid, stashToEntry(s, lid));
        if (res.ok) {
          grid = res.grid;
          const uid = res.uid || (res.entry && res.entry.uid) || null;
          if (uid) claimedGrid.add(uid);
          added.push({ itemId: lid, count: s.count || 1 });
        } else {
          overflow.push({ itemId: lid, count: s.count || 1 });
        }
        continue;
      }
      // ④ 字段同步（弹药/改装/数量）+ 认领
      const d = entryDef(lid);
      if (d && (d.weaponId || d.ammoType)) {
        const ammo = s.ammo ? { ...s.ammo } : target.ammo;
        const mods = s.mods ? { ...s.mods } : target.mods;
        if (JSON.stringify(ammo) !== JSON.stringify(target.ammo) || JSON.stringify(mods) !== JSON.stringify(target.mods)) {
          target.ammo = ammo; target.mods = mods;
          changed.push({ uid: key, itemId: lid, why: 'weapon' });
        }
      } else {
        const c = Math.max(1, Math.floor(Number(s.count) || 1));
        if (c !== target.count) { target.count = c; changed.push({ uid: key, itemId: lid, why: 'count' }); }
      }
      if (where === 'grid') claimedGrid.add(key); else claimedSlot.add(key);
    }

    // ⑤ 未认领的 grid 条目 → 移除（例如携带出去/卖掉的）
    const orphans = grid.items.filter(e => !claimedGrid.has(e.uid));
    if (orphans.length) {
      grid = { ...grid, items: grid.items.filter(e => claimedGrid.has(e.uid)) };
      for (const e of orphans) removed.push({ uid: e.uid, itemId: e.itemId, count: e.count || 1 });
    }
    // ⑥ 未认领的槽位 → 清空（阵亡丢失装备；撤离时被服务器改写也走这里）
    for (const slot of slotOrder()) {
      if (equipment[slot] && !claimedSlot.has(slot)) {
        cleared.push({ slot, itemId: equipment[slot].itemId });
        equipment[slot] = null;
      }
    }
    // ⑦ 2026-09-26 弹药实体化：老档案的 ammoLib 数值 → 仓库实体弹药堆叠
    // ⚠️ 位置必须在「⑤ orphan 清理」之后：迁入的条目不属于 stash 认领集，放前面会被当孤儿删掉（数量归零）
    // **幂等**（只补「ammoLib − 仓库已有」的差额）→ 联机档案多轮往返不会重复计入
    let ammoLeftover = null;
    if (Grid.ammoLibToGrid) {
      const mig = Grid.ammoLibToGrid(grid, p.ammoLib);
      grid = mig.grid;
      if (mig.leftover && Object.keys(mig.leftover).length) ammoLeftover = mig.leftover;
    }

    const out = { ...p, grid, equipment };

    // ⑧ 任务 B · B1：装备容器空间（胸挂 rig / 背包 backpack）
    //    ⚠️ 位置铁律：必须在「⑤ orphan 清理」与「⑥ 槽位清空」**之后**——
    //       容器是按当前装备重建的，装备态在 ⑥ 之后才最终确定（E045-a 同款教训）
    const applied = _applyContainers(out, grid);
    const out2 = applied.profile;
    for (const o of applied.overflow) overflow.push({ itemId: o.itemId, count: o.count });

    out2.stash = legacyStash(out2);
    // 2026-09-26 弹药实体化：ammoLib 是**派生视图**（口径 → 仓库实体弹药堆叠总量）
    out2.ammoLib = (Items.ammoLibOf ? Items.ammoLibOf(out2) : out2.ammoLib) || {};
    // 仓库装不下而滞留的弹药仍保留在派生字段（绝不丢资产；仓库腾空后自动补入实体）
    if (ammoLeftover) for (const k of Object.keys(ammoLeftover)) out2.ammoLib[k] = (out2.ammoLib[k] || 0) + ammoLeftover[k];
    return { profile: out2, added, removed, changed, cleared, overflow };
  }
  // 便捷包装：只取档案
  function ensure(profile) { return syncProfile(profile).profile; }

  // ---------- 出战武器 ----------
  function isWeaponUid(profile, uid) {
    const i = indexByUid(profile, uid);
    return i >= 0 && !!(profile.stash[i] && profile.stash[i].weaponId);
  }
  // 选出战武器 uid：优先保留当前选择 → 装备的主/副武器 → 仓库第一把 → null
  function findWeaponUid(profile, preferredUid) {
    if (preferredUid && isWeaponUid(profile, preferredUid)) return preferredUid;
    const eq = (profile && profile.equipment) || {};
    for (const slot of weaponSlots()) {
      const e = eq[slot];
      if (e && e.uid && isWeaponUid(profile, e.uid)) return e.uid;
    }
    const hit = ((profile && profile.stash) || []).find(s => s && s.weaponId && s.uid);
    return hit ? hit.uid : null;
  }
  // 出战武器实例（供进图）：{ instance, legacyIndex, entry, uid } | null
  function raidWeaponOf(profile, uid) {
    const idx = indexByUid(profile, uid);
    if (idx < 0) return null;
    const s = profile.stash[idx];
    if (!s || !s.weaponId || !Items.makeWeaponInstance) return null;
    const inst = Items.makeWeaponInstance(s);
    if (!inst) return null;
    return { instance: inst, legacyIndex: idx, entry: s, uid };
  }

  // ---------- 操作（均返回新档案，失败原样返回） ----------
  function _finalize(profile, grid, equipment, extra) {
    const out = { ...profile, grid, equipment };
    // 任务 B · B1：容器空间派生（与 syncProfile 共用同一实现）
    const applied = _applyContainers(out, grid);
    const out2 = applied.profile;
    out2.stash = legacyStash(out2);
    // 2026-09-26 弹药实体化：ammoLib 是**派生视图**（口径 → 仓库实体弹药堆叠总量）
    out2.ammoLib = (Items.ammoLibOf ? Items.ammoLibOf(out2) : out2.ammoLib) || {};
    return { ok: true, profile: out2, overflow: applied.overflow, ...(extra || {}) };
  }
  function _gridOf(profile) {
    return (profile && profile.grid && Array.isArray(profile.grid.items)) ? profile.grid : Grid.makeGrid();
  }
  function _equipOf(profile) {
    const base = { ...Grid.makeEquipment(), ...((profile && profile.equipment) || {}) };
    // 槽位条目深拷贝一层：syncProfile 会就地更新 ammo/mods，绝不能改到入参对象
    for (const slot of Object.keys(base)) if (base[slot]) base[slot] = Grid.cloneEntry(base[slot]);
    return base;
  }
  // 装备（槽位被占 → 先把占用者放回仓库腾位；放不回则失败）
  function equipUid(profile, uid, slot) {
    const grid = _gridOf(profile), equipment = _equipOf(profile);
    const direct = Grid.equipFromGrid(grid, equipment, uid, slot);
    if (direct.ok) return _finalize(profile, direct.grid, direct.equipment);
    if (direct.reason !== 'slot-occupied') return { ok: false, profile, reason: direct.reason };
    const un = Grid.unequipToGrid(grid, equipment, slot);
    if (!un.ok) return { ok: false, profile, reason: 'no-space' };
    const again = Grid.equipFromGrid(un.grid, un.equipment, uid, slot);
    if (!again.ok) return { ok: false, profile, reason: again.reason };
    return _finalize(profile, again.grid, again.equipment, { swapped: true });
  }
  function unequipSlot(profile, slot) {
    const grid = _gridOf(profile), equipment = _equipOf(profile);
    const r = Grid.unequipToGrid(grid, equipment, slot);
    if (!r.ok) return { ok: false, profile, reason: r.reason };
    return _finalize(profile, r.grid, r.equipment);
  }
  // 移动/旋转：uid 可能在仓库（移动）或装备槽（先回仓库再落位）
  function moveUid(profile, uid, x, y, rot) {
    const found = _entryOfUid(profile, uid);
    if (!found) return { ok: false, profile, reason: 'no-such-uid' };
    let grid = _gridOf(profile), equipment = _equipOf(profile);
    if (found.where === 'slot') {
      const un = Grid.unequipToGrid(grid, equipment, found.slot);
      if (!un.ok) return { ok: false, profile, reason: un.reason };
      grid = un.grid; equipment = un.equipment;
    }
    const mv = Grid.moveItem(grid, uid, x, y, rot);
    if (!mv.ok) return { ok: false, profile, reason: mv.reason };
    return _finalize(profile, mv.grid, equipment);
  }
  function rotateUid(profile, uid) {
    const found = _entryOfUid(profile, uid);
    if (!found) return { ok: false, profile, reason: 'no-such-uid' };
    const grid = _gridOf(profile);
    const r = Grid.rotateItem(grid, uid);
    if (!r.ok) return { ok: false, profile, reason: r.reason };
    return _finalize(profile, r.grid, _equipOf(profile));
  }
  // 入仓（商人购买 / 拾取归仓）
  function addToGrid(profile, itemId, count, opts) {
    const o = opts || {};
    const r = Grid.addItem(_gridOf(profile), {
      itemId, count: count || 1, ammo: o.ammo || null, mods: o.mods || null, rot: o.rot
    });
    if (!r.ok) return { ok: false, profile, reason: r.reason };
    return _finalize(profile, r.grid, _equipOf(profile), { stacked: !!r.stacked });
  }
  // 出仓（出售 / 消耗）：count 省略或 ≥ 现有量 → 整条移除
  function removeFromGrid(profile, uid, count) {
    const grid = _gridOf(profile);
    const e = Grid.findByUid(grid, uid);
    if (!e) return { ok: false, profile, reason: 'no-such-uid' };
    const have = e.count || 1;
    const take = Math.max(1, Math.floor(Number(count) || 0) || have);
    if (take >= have) {
      const r = Grid.removeAt(grid, uid);
      if (!r.ok) return { ok: false, profile, reason: r.reason };
      return _finalize(profile, r.grid, _equipOf(profile), { removed: { itemId: e.itemId, count: have } });
    }
    const g = Grid.cloneGrid(grid);
    const t = g.items.find(x => x.uid === uid);
    t.count = have - take;
    return _finalize(profile, g, _equipOf(profile), { removed: { itemId: e.itemId, count: take } });
  }
  // 按 itemId 出仓（携带控件的减量语义）
  function takeByItemId(profile, itemId, count) {
    const grid = _gridOf(profile);
    const e = grid.items.find(x => x.itemId === itemId);
    if (!e) return { ok: false, profile, reason: 'no-such-item' };
    return removeFromGrid(profile, e.uid, Math.min(count, e.count || 1));
  }
  function countOf(profile, itemId) { return Grid.countOf(_gridOf(profile), itemId); }

  const Loadout = {
    slotOrder, weaponSlots, isWeaponItem, entryToStash, stashToEntry, gridOrder,
    legacyStash, indexByUid, syncProfile, ensure,
    isWeaponUid, findWeaponUid, raidWeaponOf,
    equipUid, unequipSlot, moveUid, rotateUid, addToGrid, removeFromGrid, takeByItemId, countOf,
    // 任务 B · B1：容器空间便捷出口（都经 syncProfile 保证一致性）
    containersOf: (profile) => (Containers ? Containers.containersOf(profile) : { rig: null, backpack: null }),
    containerStats: (profile) => (Containers ? Containers.containerStats(profile) : {}),
    containerOf: (profile, slot) => (Containers ? Containers.containerOf(profile, slot) : null)
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Loadout;
  if (typeof window !== 'undefined') window.EXFIL_LOADOUT = Loadout;
})();
