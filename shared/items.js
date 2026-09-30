'use strict';
(function () {
  /*
   * EXFIL ZONE · shared/items.js — 物品系统（IIFE 双兼容）
   * 武器/弹药/改装件数据表 + 武器实例模型。M1a 最小集（两把枪 + 弹药 + 瞄具演示槽位）。
   */
  // ---------- 配置接入（config/content.json → CFG.content；缺失时用下方内置默认表） ----------
  const ConfigLib = (typeof module !== 'undefined' && module.exports)
    ? require('./config')
    : (typeof window !== 'undefined' && window.EXFIL_CONFIG_LIB ? window.EXFIL_CONFIG_LIB : null);
  const CFG = (ConfigLib && ConfigLib.CFG) || {};
  const CONTENT = CFG.content || {};

  // ---------- 武器数据表（默认值；可被 config/content.json 覆盖） ----------
  const WEAPONS_DEFAULT = {
    ak74: { id: 'ak74', name: 'AK-74', dmg: 24, fireRate: 650, price: 800, slots: ['sight', 'mag'], magSize: 30, ammoType: '545x39', desc: '标准突击步枪' },
    pm: { id: 'pm', name: 'PM 马卡洛夫', dmg: 14, fireRate: 320, price: 200, slots: ['mag'], magSize: 8, ammoType: '9x18', desc: '轻便手枪' }
  };
  // ---------- 弹药 ----------
  const AMMO_DEFAULT = {
    '545x39': { id: '545x39', size: [1, 1], slot: [], name: '5.45x39', type: 'ammo', price: 1.2, weight: 0.011, caliber: '5.45', desc: '散装弹药（1×1 格，可堆叠）' },
    '9x18': { id: '9x18', size: [1, 1], slot: [], name: '9x18 PM', type: 'ammo', price: 0.8, weight: 0.010, caliber: '9x18', desc: '散装弹药（1×1 格，可堆叠）' }
  };
  // ---------- 改装件（M1a：槽位存在 + 可装卸，数值效果 M1b 后置） ----------
  const MODS_DEFAULT = {
    pso: { id: 'pso', name: 'PSO-1 瞄准镜', type: 'sight', price: 300, desc: '4x 光学瞄具（占瞄具槽）' }
  };

  // ---------- 战利品物品（M1b：医疗/弹药/杂物） ----------
  const LOOT_DEFAULT = {
    bandage: { id: 'bandage', name: '绷带', type: 'med', weight: 0.1, price: 20, heal: 20, desc: '简易止血（使用 +20 HP）' },
    ifak: { id: 'ifak', name: 'IFAK 急救包', type: 'med', weight: 0.3, price: 80, heal: 50, desc: '军用急救包（使用 +50 HP）' },
    ammo_box_545: { id: 'ammo_box_545', name: '5.45 弹药箱', type: 'ammo', weight: 0.5, price: 60, ammo: { ammoId: '545x39', count: 30 }, desc: '30 发 5.45x39' },
    ammo_box_9x18: { id: 'ammo_box_9x18', name: '9x18 弹药箱', type: 'ammo', weight: 0.4, price: 40, ammo: { ammoId: '9x18', count: 20 }, desc: '20 发 9x18 PM' },
    junk: { id: 'junk', name: '废金属', type: 'misc', weight: 0.2, price: 15, desc: '杂物，可卖给商人' },
    bolt: { id: 'bolt', name: '螺栓', type: 'misc', weight: 0.1, price: 25, desc: '零件' },
    // 武器战利品（M1b：搜刮可摸到枪，背包中「装备」；字段对齐 WEAPONS 供 sim 直接装备）
    w_pm: { id: 'w_pm', name: 'PM 马卡洛夫', type: 'weapon', weaponId: 'pm', weight: 1.2, price: 200, dmg: 14, fireRate: 320, magSize: 8, ammoType: '9x18', slots: ['mag'], desc: '手枪，背包中可装备' },
    w_ak74: { id: 'w_ak74', name: 'AK-74', type: 'weapon', weaponId: 'ak74', weight: 3.5, price: 800, dmg: 24, fireRate: 550, magSize: 30, ammoType: '545x39', slots: ['sight', 'mag'], desc: '步枪，背包中可装备' }
  };
  // ---------- 战利品生成池（容器槽位按池加权随机） ----------
  const LOOT_POOL_DEFAULT = {
    common: [{ item: 'junk', w: 45 }, { item: 'bandage', w: 25 }, { item: 'bolt', w: 15 }, { item: 'ammo_box_9x18', w: 15 }],
    med: [{ item: 'bandage', w: 45 }, { item: 'ifak', w: 30 }, { item: 'junk', w: 15 }, { item: 'ammo_box_9x18', w: 10 }],
    ammo: [{ item: 'ammo_box_545', w: 45 }, { item: 'ammo_box_9x18', w: 30 }, { item: 'junk', w: 25 }],
    rare: [{ item: 'ifak', w: 28 }, { item: 'ammo_box_545', w: 24 }, { item: 'ammo_box_9x18', w: 16 }, { item: 'w_pm', w: 12 }, { item: 'w_ak74', w: 5 }, { item: 'junk', w: 15 }]
  };
  // ---------- 地图容器（工厂图：掩体旁可搜刮点） ----------
  const CONTAINERS_DEFAULT = [
    { id: 'c1', x: -6, z: -4, label: '军用弹药箱', pools: ['ammo', 'common'], respawn: false },
    { id: 'c2', x: 7, z: 5, label: '医疗柜', pools: ['med', 'med'], respawn: false },
    { id: 'c3', x: 3, z: -7, label: '工具柜', pools: ['common', 'common', 'rare'], respawn: false },
    { id: 'c4', x: -10, z: 7, label: '铁皮箱', pools: ['common', 'rare'], respawn: false },
    { id: 'c5', x: -20, z: 0, label: '掩体弹药箱', pools: ['ammo', 'ammo'], respawn: false },
    { id: 'c6', x: 20, z: -8, label: '散落补给', pools: ['common', 'med'], respawn: false }
  ];

  // ---------- 撤离点（M1c：固定点 + 倒计时；条件撤离 M4） ----------
  const EXTRACTS_DEFAULT = [
    { id: 'e1', x: -38, z: 0, radius: 5, duration: 10, label: '西侧撤离点' },
    { id: 'e2', x: 0, z: -38, radius: 5, duration: 10, label: '北侧撤离点' }
  ];

  // ---------- 生效表：config/content.json 优先，缺失回退内置默认 ----------
  const WEAPONS = CONTENT.weapons || WEAPONS_DEFAULT;
  const AMMO = CONTENT.ammo || AMMO_DEFAULT;
  const MODS = CONTENT.mods || MODS_DEFAULT;
  // 2026-09-26 弹药实体化：散装弹药并入 LOOT 查找表（成为一等公民物品）——
  // UI 取物品名/价格/尺寸的既有路径 ITEMS.LOOT[id] 无需任何改动即可识别弹药
  const LOOT = { ...(CONTENT.ammo || AMMO_DEFAULT), ...(CONTENT.loot || LOOT_DEFAULT) };
  const LOOT_POOL = CONTENT.lootPool || LOOT_POOL_DEFAULT;
  const CONTAINERS = CONTENT.containers || CONTAINERS_DEFAULT;
  const EXTRACTS = CONTENT.extracts || EXTRACTS_DEFAULT;

  // ---------- 战利品生成：按池加权随机一件 ----------
  function rollLoot(poolName) {
    const pool = LOOT_POOL[poolName];
    if (!pool) return 'junk';
    const total = pool.reduce((s, e) => s + e.w, 0);
    let r = Math.random() * total;
    for (const e of pool) { r -= e.w; if (r <= 0) return e.item; }
    return pool[pool.length - 1].item;
  }
  // 容器初始化：按 pools 每个槽位随机生成战利品
  function rollContainerLoot(containerDef) {
    return (containerDef.pools || []).map(p => rollLoot(p));
  }
  // 背包重量计算
  function invWeight(inventory) {
    return (inventory || []).reduce((s, it) => s + (LOOT[it.itemId] ? LOOT[it.itemId].weight * (it.count || 1) : 0), 0);
  }

  // ---------- M1c 结算（纯函数，可单测） ----------
  // opts: { extracted: bool, weaponIdx: 带出的武器在 stash 的下标, weaponAmmo, weaponMods, inventory: 背包条目 }
  // 撤离成功：武器弹药/改装写回 + 背包物资并入仓库
  // 死亡：stash 移除该武器（装备丢失），背包丢弃
  function settleRaid(profile, opts) {
    const p = { ...profile, stash: profile.stash.map(s => ({ ...s, mods: s.mods ? { ...s.mods } : s.mods })) };
    if (opts.extracted) {
      if (opts.weaponIdx >= 0 && p.stash[opts.weaponIdx]) {
        if (opts.weaponAmmo) p.stash[opts.weaponIdx].ammo = { ...opts.weaponAmmo };
        if (opts.weaponMods) p.stash[opts.weaponIdx].mods = { ...opts.weaponMods };
      }
      for (const it of (opts.inventory || [])) {
        if (it.isWeapon) {
          // 局内捡的武器：撤离成功 → 并入仓库武器槽（带当前弹药/改装）
          p.stash.push({
            weaponId: it.weaponId,
            mods: it.mods ? { ...it.mods } : {},
            ammo: it.ammo ? { ...it.ammo } : { ammoId: it.ammoType, count: 0 }
          });
        } else {
          const slot = p.stash.find(s => s.itemId === it.itemId);
          if (slot) slot.count = (slot.count || 1) + (it.count || 1);
          else p.stash.push({ itemId: it.itemId, count: it.count || 1 });
        }
      }
    } else {
      if (opts.weaponIdx >= 0) p.stash.splice(opts.weaponIdx, 1);
    }
    return p;
  }

  // ---------- 弹药实体化（2026-09-26 用户决策：档 A 全链实体化） ----------
  // 仓库弹药 = stash 里的**实体堆叠条目**（itemId 即口径，如 '545x39'，1×1 格）；
  // ammoLib 降级为**派生视图**（口径 → 仓库总量），既有读取方（HUD / 携带建议 / 联机整备）零改动。
  // 老档案迁移：旧 ammoLib 数值 → 实体堆叠（见 grid.migrateProfile）。
  function ammoLibOf(profile) {
    const lib = {};
    for (const s of ((profile && profile.stash) || [])) {
      if (!s || !s.itemId || s.weaponId) continue;
      if (!AMMO[s.itemId]) continue;
      lib[s.itemId] = (lib[s.itemId] || 0) + (s.count || 1);
    }
    return lib;
  }

  // ---------- M4：携带机制（纯函数；单机/联机共用，对齐 tradeProfile 范式） ----------
  // 携带语义（用户 2026-09-14 拍板方案 A）：
  //   进图【从仓库扣除】→ 局内携带 → 撤离成功【剩余归仓】/ 死亡【丢失】（不进局的部分留在仓库，安全）
  // carry = { ammo: { 口径: 发数 }, items: [{ itemId, count }] }
  // 返回 { profile: 扣除后的档案, raidAmmo: {口径:发数}, raidItems: [局内背包条目] }
  function takeCarry(profile, carry) {
    const p = {
      ...profile,
      stash: (profile.stash || []).map(s => ({ ...s, mods: s.mods ? { ...s.mods } : s.mods })),
    };
    const want = carry || {};
    // ① 弹药（2026-09-26 实体化）：按口径从仓库**实体弹药堆叠**扣除（可跨多叠；扣空则移除条目）
    const raidAmmo = {};
    for (const [cal, n] of Object.entries(want.ammo || {})) {
      let need = Math.max(0, Math.floor(Number(n) || 0));
      if (need <= 0) continue;
      let taken = 0;
      for (let i = p.stash.length - 1; i >= 0 && need > 0; i--) {
        const s = p.stash[i];
        if (!s || s.weaponId || s.itemId !== cal) continue;
        const take = Math.min(need, s.count || 1);
        if (take <= 0) continue;
        taken += take;
        need -= take;
        s.count = (s.count || 1) - take;
        if (s.count <= 0) p.stash.splice(i, 1);
      }
      if (taken > 0) raidAmmo[cal] = taken;
    }
    // ② 物资：按条目从仓库扣除（不超量；扣空则移除条目）
    const raidItems = [];
    for (const req of (want.items || [])) {
      const idx = p.stash.findIndex(s => s.itemId === req.itemId && !s.weaponId);
      if (idx < 0) continue;
      const slot = p.stash[idx];
      const have = slot.count || 1;
      const take = Math.max(0, Math.min(Math.floor(Number(req.count) || 0), have));
      if (take <= 0) continue;
      const def = LOOT[req.itemId];
      raidItems.push({ itemId: req.itemId, count: take, weight: def ? def.weight : 0 });
      slot.count = have - take;
      if (slot.count <= 0) p.stash.splice(idx, 1);
    }
    p.ammoLib = ammoLibOf(p);
    return { profile: p, raidAmmo, raidItems };
  }

  // ---------- 进图携带（B2-3，2026-09-26）：容器式携带 ----------
  // 与 takeCarry 的区别：携带内容不再由界面「数值清单」指定，而是**读 rig / backpack 容器内的实体条目**。
  //   输出格式与 takeCarry **完全一致**（{ profile, raidAmmo, raidItems }）→ sim 层 / 协议零改动。
  //   语义：容器内有什么就带什么（塔科夫式：整包装走），容器被清空但保留空间规格。
  // 返回 { profile: 容器已清空的档案, raidAmmo: {口径:发数}, raidItems: [局内背包条目] }
  // 契约7.1（v0.15.0）：档案护具 → 局内护甲实例。
  //   entry = { itemId, durNow, durMax, armorClass, cover, name }；缺字段用 content 兜底；无护具返回 null。
  function pickNum(v, fb) {
    if (v === null || v === undefined || v === '') return fb;
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  }
  function armorInstanceOf(entry, slotKey) {
    if (!entry || !entry.itemId) return null;
    const def = LOOT[entry.itemId] || {};
    const durMax = Math.max(0, pickNum(entry.durMax, pickNum(def.dur, 0)));
    const durNow = Math.max(0, pickNum(entry.durNow, durMax));
    const armorClass = Math.max(0, pickNum(entry.armorClass, pickNum(def.armorClass, 0)));
    const cover = (Array.isArray(entry.cover) && entry.cover.length) ? entry.cover
      : ((Array.isArray(def.cover) && def.cover.length) ? def.cover : (slotKey === 'head' ? ['head'] : ['chest']));
    return {
      itemId: entry.itemId,
      durNow: durNow,
      durMax: durMax,
      armorClass: armorClass,
      cover: cover,
      name: entry.name || def.name || entry.itemId
    };
  }
  function raidArmorOf(profile) {
    const eq = (profile && profile.equipment) || {};
    return { armor: armorInstanceOf(eq.armor, 'armor'), helm: armorInstanceOf(eq.head, 'head') };
  }

  function takeCarryFromContainers(profile) {
    const C = (typeof module !== 'undefined' && module.exports)
      ? require('./containers')
      : (typeof window !== 'undefined' ? window.EXFIL_CONTAINERS : null);
    if (!C || !C.takeAll) {
      // 容器库缺失兜底：视为空携带（不扣除任何东西，避免误吞玩家资产）
      return { profile: profile, raidAmmo: {}, raidItems: [], raidAmmoRig: {}, raidAmmoBag: {}, raidArmor: raidArmorOf(profile) };
    }
    const r = C.takeAll(profile);
    const p = r.profile;
    p.ammoLib = ammoLibOf(p);
    // B4（2026-09-26，纯增量）：透传来源信息，供「胸挂快捷使用 / 背包不可」使用。
    //   旧字段（raidAmmo / raidItems）保持原样 → 既有读取方（sim/协议/HUD）零改动。
    return {
      profile: p,
      raidAmmo: r.raidAmmo,
      raidItems: r.raidItems,              // 每条含 src∈{'rig','backpack'}
      raidAmmoRig: r.raidAmmoRig || {},    // 胸挂内弹药
      raidAmmoBag: r.raidAmmoBag || {},     // 背包内弹药
      raidArmor: raidArmorOf(p)                  // 契约7.1：档案护具（armor/helm）→ 局内
    };
  }

  // 结算携带：撤离成功 → 局内剩余弹药【归仓并集】；死亡 → 不归还（已在 takeCarry 扣除）
  // opts = { extracted: bool, raidAmmo: {口径:发数} }（此 raidAmmo 为【局内剩余】）
  function settleCarry(profile, opts) {
    const p = {
      ...profile,
      stash: (profile.stash || []).map(s => ({ ...s, mods: s.mods ? { ...s.mods } : s.mods }))
    };
    if (opts && opts.extracted) {
      // 2026-09-26 实体化：撤离剩余弹药 → 实体堆叠归仓（优先并回已有同口径条目）
      for (const [cal, n] of Object.entries(opts.raidAmmo || {})) {
        const v = Math.max(0, Math.floor(Number(n) || 0));
        if (v <= 0) continue;
        const hit = p.stash.find(s => !s.weaponId && s.itemId === cal);
        if (hit) hit.count = (hit.count || 1) + v;
        else p.stash.push({ itemId: cal, count: v });
      }
    }
    p.ammoLib = ammoLibOf(p);
    return p;
  }

  // 携带建议（供整备界面初始化默认值）：每口径取 min(库量, 60) 发；物资默认不带（由玩家勾选）
  function suggestCarry(profile) {
    const ammo = {};
    for (const [cal, n] of Object.entries(ammoLibOf(profile))) {
      const v = Math.max(0, Math.floor(Number(n) || 0));
      if (v > 0) ammo[cal] = Math.min(v, 60);
    }
    return { ammo, items: [] };
  }

  // ---------- 保底可开火（单机/联机共用）：确保仓库有弹药>0 的武器 ----------
  // 无武器 → 补一把满弹 PM；有武器但弹药 0 → 补满弹匣（按武器 magSize）
  // 返回是否发生变更
  function ensureLoadable(profile) {
    const stash = profile.stash || (profile.stash = []);
    const guns = stash.filter(s => s.weaponId);
    if (guns.length === 0) {
      stash.push({ weaponId: 'pm', mods: {}, ammo: { ammoId: '9x18', count: 24 } });
      return true;
    }
    let changed = false;
    for (const g of guns) {
      const def = WEAPONS[g.weaponId];
      if (!def) continue;
      if (!g.ammo) {
        g.ammo = { ammoId: def.ammoType, count: def.magSize, reserve: def.magSize };
        changed = true;
        continue;
      }
      // 旧格式迁移：count 超过弹匣 → 拆分为弹匣+备弹
      if (g.ammo.reserve === undefined && (g.ammo.count || 0) > def.magSize) {
        g.ammo.reserve = (g.ammo.count || 0) - def.magSize;
        g.ammo.count = def.magSize;
        changed = true;
      }
      const count = g.ammo.count || 0;
      const reserve = g.ammo.reserve || 0;
      if (count <= 0 && reserve <= 0) {
        // 完全无弹 → 补满弹匣 + 一匣备弹
        g.ammo = { ammoId: def.ammoType, count: def.magSize, reserve: def.magSize };
        changed = true;
      }
    }
    return changed;
  }

  // ---------- E030：商人/改装（联机服务器权威；纯函数，不修改原档案） ----------
  // action: { type:'sellLoot', itemId } | { type:'sellWeapon', index } | { type:'buy', itemId }
  //       | { type:'buyWeapon', weaponId } | { type:'toggleSight', index }
  // 返回 { ok, profile, msg }：ok=是否成功，profile=新档案（成功时含变更），msg=客户端提示
  function tradeProfile(profile, action) {
    const p = { ...profile, stash: (profile.stash || []).map(s => ({ ...s, mods: s.mods ? { ...s.mods } : s.mods })) };
    const goods = CONTENT.traderGoods || [];
    if (!action) return { ok: false, profile: p, msg: '未知操作' };
    if (action.type === 'sellLoot') {
      const idx = p.stash.findIndex(s => s.itemId === action.itemId);
      if (idx < 0) return { ok: false, profile: p, msg: '无此物资' };
      const item = p.stash[idx];
      const gain = ((LOOT[action.itemId] || {}).price || 0) * (item.count || 1);
      p.money += gain;
      p.stash.splice(idx, 1);
      return { ok: true, profile: p, msg: `卖出 +${gain}₽` };
    }
    if (action.type === 'sellWeapon') {
      const item = p.stash[action.index];
      const def = item && WEAPONS[item.weaponId];
      if (!def) return { ok: false, profile: p, msg: '无此武器' };
      p.money += def.price;
      p.stash.splice(action.index, 1);
      return { ok: true, profile: p, msg: `卖出 ${def.name} +${def.price}₽` };
    }
    if (action.type === 'buy') {
      const g = goods.find(x => x.id === action.itemId);
      if (!g || p.money < g.price) return { ok: false, profile: p, msg: '钱不够' };
      p.money -= g.price;
      const slot = p.stash.find(s => s.itemId === action.itemId);
      if (slot) slot.count = (slot.count || 1) + 1;
      else p.stash.push({ itemId: action.itemId, count: 1 });
      return { ok: true, profile: p, msg: `购买 ${g.label || action.itemId}` };
    }
    if (action.type === 'buyWeapon') {
      const def = WEAPONS[action.weaponId];
      if (!def || p.money < def.price) return { ok: false, profile: p, msg: '钱不够' };
      p.money -= def.price;
      p.stash.push({ weaponId: action.weaponId, mods: {}, ammo: { ammoId: def.ammoType, count: def.magSize, reserve: def.magSize } });
      return { ok: true, profile: p, msg: `购买 ${def.name}` };
    }
    if (action.type === 'toggleSight') {
      const item = p.stash[action.index];
      const def = item && WEAPONS[item.weaponId];
      if (!def || !(def.slots || []).includes('sight')) return { ok: false, profile: p, msg: '无瞄具槽' };
      if (!item.mods) item.mods = {};
      item.mods.sight = item.mods.sight ? null : 'pso';
      return { ok: true, profile: p, msg: item.mods.sight ? '安装 PSO 瞄具' : '卸下瞄具' };
    }
    return { ok: false, profile: p, msg: '未知操作' };
  }

  // ---------- 选中态守卫（纯函数）：整备界面 selectedIdx 必须指向仓库中的有效武器 ----------
  // 缺陷根因（2026-09-19）：selectedIdx 是裸下标，仓库结构变化后不重算 ——
  //   阵亡结算 settleRaid 按该下标 splice 掉武器 → 数组左移 → 下标悬空/落到杂货上
  //   → renderWeaponDetail 判为「无武器可选」、按钮变「徒手进图」
  //   → 表现为「仓库里明明有枪却无法装备」
  // 优先级：① 原下标仍是有效武器 → 保留（不打断用户已选）
  //         ② 否则取第一把有效武器 ③ 无有效武器 → -1
  function pickWeaponIndex(stash, curIdx) {
    const list = Array.isArray(stash) ? stash : [];
    const valid = (s) => !!(s && s.weaponId && WEAPONS[s.weaponId]);
    if (valid(list[curIdx])) return curIdx;
    return list.findIndex(s => valid(s));
  }

  // E039：SCAV 出征装备随机抽取（单机/联机共用纯函数）
  // 按 tuning.scav.weaponPool 权重抽取；弹药取该武器在内容表中的默认口径与弹匣容量
  function randomScavWeapon(randFn) {
    const rnd = randFn || Math.random;
    const pool = (CFG.scav && CFG.scav.weaponPool) || { ak74: 0.3, pm: 0.7 };
    const ids = Object.keys(pool);
    if (!ids.length) return null;
    const weights = ids.map(k => Math.max(0, Number(pool[k]) || 0));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rnd() * (total > 0 ? total : ids.length);
    let pick = ids[ids.length - 1];
    for (let i = 0; i < ids.length; i++) {
      r -= (total > 0 ? weights[i] : 1);
      if (r <= 0) { pick = ids[i]; break; }
    }
    const def = WEAPONS[pick] || {};
    return makeWeaponInstance({
      weaponId: pick, mods: {},
      ammo: { ammoId: def.ammoType || '9x18', count: def.magSize || 8, reserve: 0 }
    });
  }

  const Items = {
    WEAPONS, AMMO, MODS, LOOT, LOOT_POOL, CONTAINERS, EXTRACTS,
    defaultStash, defaultProfile, makeWeaponInstance, canFire, consumeAmmo, modTypeForSlot,
    rollLoot, rollContainerLoot, invWeight, settleRaid, ensureLoadable, tradeProfile, takeCarry, takeCarryFromContainers, settleCarry, suggestCarry, pickWeaponIndex, randomScavWeapon,
    ammoLibOf
  };
  // 初始仓库（新手礼包：一把 AK + 两个弹匣弹药 + 一把 PM + 钱）
  function defaultStash() {
    return [
      // 弹匣 + 备弹模型：count=弹匣内（≤magSize），reserve=备弹
      { weaponId: 'ak74', mods: { sight: null }, ammo: { ammoId: '545x39', count: 30, reserve: 30 } },
      { weaponId: 'pm', mods: {}, ammo: { ammoId: '9x18', count: 8, reserve: 16 } }
    ];
  }
  function defaultProfile(name) {
    return { name: String(name || 'Player').slice(0, 16), money: 1000, stash: defaultStash(), ammoLib: {}, carry: { ammo: {}, items: [] }, created: Date.now() };
  }

  // ---------- 武器实例工具 ----------
  // 创建武器实例（从仓库条目）；弹药拆分弹匣+备弹，旧格式自动迁移
  // （旧档案 count=总弹量，如 PM 24 发 → 弹匣 8 + 备弹 16；超过弹匣的自动转备弹）
  function makeWeaponInstance(stashItem) {
    const def = WEAPONS[stashItem.weaponId];
    if (!def) return null;
    const raw = stashItem.ammo || {};
    const total = raw.count || 0;
    const count = Math.min(def.magSize, total);
    const reserve = raw.reserve !== undefined ? raw.reserve : Math.max(0, total - def.magSize);
    return {
      weaponId: def.id,
      name: def.name,
      dmg: def.dmg,
      fireRate: def.fireRate,
      slots: [...def.slots],
      mods: { ...(stashItem.mods || {}) },
      ammo: { ammoId: raw.ammoId || def.ammoType, count, reserve },
      magSize: def.magSize
    };
  }
  // 是否可开火（有弹）
  function canFire(inst) { return inst && inst.ammo.count > 0; }
  // 消耗一发弹药
  function consumeAmmo(inst) { if (inst && inst.ammo.count > 0) inst.ammo.count--; }
  // 计算武器槽位可用改装件类型
  function modTypeForSlot(slot) {
    return slot === 'sight' ? 'sight' : null;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Items;
  if (typeof window !== 'undefined') window.EXFIL_ITEMS = Items;
})();
