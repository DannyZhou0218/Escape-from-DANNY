'use strict';
(function () {
  /*
   * EXFIL ZONE · shared/sim.js — GameSim 游戏模拟层（Node 与浏览器共用，双兼容导出）
   * IIFE 隔离作用域（E011：浏览器普通 script 全局 const 冲突）
   */
  const Core = (typeof module !== 'undefined' && module.exports)
    ? require('./core')
    : (typeof window !== 'undefined' ? window.EXFIL_CORE : null);
  if (!Core) throw new Error('EXFIL_CORE 未加载');
  const { PHYSICS, MAP, collidesXZ, groundYAt, rayHitsBlock, raycastPlayers, directionFromAngles, spawnPoint, buildNavGrid, findPath, slideMove, pushOutOfBlock } = Core;
  const BT = (typeof module !== 'undefined' && module.exports)
    ? require('./bt')
    : (typeof window !== 'undefined' ? window.EXFIL_BT : null);

  // ---------- 调参表（config/tuning.json → shared/config.js） ----------
  const ConfigLib = (typeof module !== 'undefined' && module.exports)
    ? require('./config')
    : (typeof window !== 'undefined' && window.EXFIL_CONFIG_LIB ? window.EXFIL_CONFIG_LIB : null);
  if (!ConfigLib) throw new Error('EXFIL_CONFIG_LIB 未加载');
  const CFG = ConfigLib.CFG;
  const SCAV_CFG = CFG.scav;
  // 注意：不在此处拷贝值——使用点直读 CFG，保证 /api/reload-config 热重载即时生效

  // SCAV 命中率模型（E024）：基础值 − 距离衰减 − 目标移动惩罚（跑动可有效规避）
  function computeScavHitChance(dist, targetSpeed, cfg) {
    const c = cfg || SCAV_CFG;
    const speedRatio = Math.max(0, Math.min(1, (targetSpeed || 0) / PHYSICS.speed));
    const hc = c.hitChanceBase - dist / c.hitChanceDistDiv - speedRatio * (c.moveAccuracyPenaltyMax || 0);
    return Math.max(c.hitChanceMin, Math.min(1, hc));
  }

  // === ARMOR_PURE_BEGIN ===
  // v0.15.0 护甲 / 穿透 / 命中部位纯函数（契约 3.2，公式冻结）。
  // 全部数值走 CFG + || 兜底（热重载即时生效 / 配置缺失不崩），禁止硬编码（PLAN 铁律 3）。
  function combatNum(key, dflt) {
    const c = CFG.combat || {};
    const n = Number(c[key]);
    return Number.isFinite(n) ? n : dflt;
  }
  function ammoDef(ammoId) {
    const a = (CFG.content && CFG.content.ammo) || {};
    return ammoId ? (a[ammoId] || null) : null;
  }
  function lootDef(itemId) {
    const l = (CFG.content && CFG.content.loot) || {};
    return itemId ? (l[itemId] || null) : null;
  }
  function finiteOr(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }
  // base = AMMO[ammoId].dmg || weapon.dmg（契约 3.1：dmg 缺失回落 weapon.dmg）
  function baseDamageOf(ammoId, weapon) {
    const ammo = ammoDef(ammoId);
    const ad = ammo ? Number(ammo.dmg) : NaN;
    if (Number.isFinite(ad) && ad > 0) return ad;
    const wd = weapon ? Number(weapon.dmg) : NaN;
    return Number.isFinite(wd) ? Math.max(0, wd) : 0;
  }
  // 穿深：缺失视为 0（契约 3.1）
  function penOf(ammoId) {
    const ammo = ammoDef(ammoId);
    const pen = ammo ? Number(ammo.pen) : NaN;
    return Number.isFinite(pen) ? Math.max(0, pen) : 0;
  }
  // 命中部位：头部 = 命中点 y ≥ 脚部 y + (hitboxTop − headZone)（契约 3.2）
  function hitPartOf(hitPointY, footY, cfgOverride) {
    const c = (cfgOverride && typeof cfgOverride === 'object') ? cfgOverride : (CFG.combat || {});
    const hitboxTop = finiteOr(c.hitboxTop, 2.1); // 与 core.raycastPlayers 命中盒顶一致
    const headZone = finiteOr(c.headZone, 0.30);
    return (Number(hitPointY) >= Number(footY) + (hitboxTop - headZone)) ? 'head' : 'chest';
  }
  // 护具条目归一化：缺失字段从 CFG.content.loot[itemId] 兜底（数据单一数据源）
  function normalizeArmorEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const itemId = raw.itemId || raw.id || null;
    const def = itemId ? lootDef(itemId) : null;
    const defDur = def ? Number(def.dur) : NaN;
    let durMax = finiteOr(raw.durMax !== undefined ? raw.durMax : defDur, NaN);
    let durNow = finiteOr(raw.durNow !== undefined ? raw.durNow : (raw.dur !== undefined ? raw.dur : durMax), NaN);
    if (!Number.isFinite(durMax) && Number.isFinite(durNow)) durMax = durNow;
    if (!Number.isFinite(durNow) && Number.isFinite(durMax)) durNow = durMax;
    durMax = Math.max(0, Number.isFinite(durMax) ? durMax : 0);
    durNow = Math.max(0, Math.min(durMax, Number.isFinite(durNow) ? durNow : durMax));
    const rawClass = raw.armorClass !== undefined ? raw.armorClass : (def ? def.armorClass : NaN);
    const armorClass = Math.max(0, finiteOr(rawClass, 0));
    const cover = Array.isArray(raw.cover) ? raw.cover.slice()
      : (def && Array.isArray(def.cover) ? def.cover.slice() : []);
    const name = raw.name || (def && def.name) || itemId || '护具';
    return { itemId: itemId, name: name, armorClass: armorClass, durNow: durNow, durMax: durMax, cover: cover };
  }
  function armorSlotOf(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const cover = Array.isArray(raw.cover) ? raw.cover : [];
    const slot = Array.isArray(raw.slot) ? raw.slot : (raw.slot ? [raw.slot] : []);
    const type = raw.type || '';
    if (cover.indexOf('head') >= 0 || slot.indexOf('head') >= 0 || type === 'helmet') return 'helm';
    if (cover.indexOf('chest') >= 0 || slot.indexOf('armor') >= 0 || type === 'armor') return 'armor';
    return null;
  }
  // raidArmor → { armor, helm }：兼容 {armor,helm} 对象 / 条目数组 / 单条目
  function normalizeArmorState(raw) {
    const out = { armor: null, helm: null };
    if (!raw) return out;
    const place = (e) => {
      const norm = normalizeArmorEntry(e);
      if (!norm) return;
      const key = armorSlotOf(e) || (out.armor ? 'helm' : 'armor');
      if (key === 'helm') { if (!out.helm) out.helm = norm; }
      else if (!out.armor) out.armor = norm;
      else if (!out.helm) out.helm = norm;
    };
    if (Array.isArray(raw)) { for (const e of raw) place(e); return out; }
    if (raw.armor !== undefined || raw.helm !== undefined) {
      out.armor = raw.armor ? normalizeArmorEntry(raw.armor) : null;
      out.helm = raw.helm ? normalizeArmorEntry(raw.helm) : null;
      return out;
    }
    place(raw);
    return out;
  }
  function coversPart(entry, part) {
    return !!(entry && Array.isArray(entry.cover) && entry.cover.indexOf(part) >= 0);
  }
  // 伤害结算（契约 3.2）：无护甲 / 护具不覆盖 / 耐久<=0 → 全额 base（向后兼容红线）
  function resolveDamage(ammoId, weapon, part, armorState) {
    const pos = (part === 'head') ? 'head' : 'chest';
    let base = baseDamageOf(ammoId, weapon);
    if (pos === 'head') base *= combatNum('headMul', 2.0); // 爆头倍率：无护具也吃（契约 3.2）
    const entry = armorState ? armorState[(pos === 'head') ? 'helm' : 'armor'] : null;
    if (!entry || !(entry.durNow > 0) || !coversPart(entry, pos)) {
      return { dmg: base, base: base, part: pos, armorHit: false, absorbed: 0, durNow: entry ? entry.durNow : null, armorName: null };
    }
    const penetrated = penOf(ammoId) >= entry.armorClass * combatNum('armorPenPerClass', 10);
    let mul, loss;
    if (penetrated) {
      mul = combatNum('penetratedMul', 0.85);
      loss = base * combatNum('durLossPen', 0.10);
    } else {
      mul = Math.max(combatNum('blockedMulMin', 0.10),
        combatNum('blockedMulBase', 0.30) - combatNum('blockedMulPerClass', 0.03) * entry.armorClass);
      loss = base * combatNum('durLossBlock', 0.50);
    }
    const dmg = Math.max(0, base * mul);
    entry.durNow = Math.max(0, entry.durNow - loss); // 耐久不得为负（契约 3.2）
    return { dmg: dmg, base: base, part: pos, armorHit: true, absorbed: base - dmg, durNow: entry.durNow, armorName: entry.name };
  }
  // === ARMOR_PURE_END ===

  class GameSim {
    constructor(opts = {}) {
      this.players = new Map();
      this.testMode = !!opts.testMode;
      this.events = [];
      this._shotCooldown = opts.shotCooldown !== undefined ? opts.shotCooldown : CFG.combat.shotCooldownMs;
      // M1b 容器：调用方提供已生成战利品的容器（{id,x,z,label,loot:[{itemId,weight,count}...]})
      this._lootSeq = 0;
      // E043：容器 loot 每条注入稳定 uid —— 塔科夫式逐件拿取的布局锚点（客户端按 uid 保持格位）。
      // 单机 / 联机 makeContainers / 测试统一在此覆盖；尸体 loot 在生成处同样 tag。
      this.containers = (opts.containers || []).map(c => ({ ...c, looted: false, loot: (c.loot || []).map(it => this._tagLoot(it)) }));
      // M1c 撤离点：{id, x, z, radius, duration}
      this.extracts = (opts.extracts || []).map(e => ({ ...e }));
      // M2 SCAV：实体 Map + 巡逻路由
      this.scavs = new Map();
      this.scavSpeed = SCAV_CFG.speed; // 巡逻速度（调参表 scav.speed）
      // M2c A* 寻路网格（地图静态，构造时建一次）
      this.navGrid = buildNavGrid(MAP, SCAV_CFG.navGridRange, SCAV_CFG.navGridCell);
    }

    // ---------- M2 SCAV ----------
    // 地图内随机可站立点（不卡方块、可选距玩家最小距离）
    // 注意：地面大平板顶面 y=0，groundYAt 全域返回 0——不能用 gy<0.1 排除（会全跳过）
    randomWalkablePoint(minDistFromPlayers = 0, attempts = SCAV_CFG.spawnAttempts) {
      for (let i = 0; i < attempts; i++) {
        const x = (Math.random() - 0.5) * 60, z = (Math.random() - 0.5) * 60;
        if (collidesXZ(MAP, x, 0, z, PHYSICS.playerR)) continue; // 生成点不能在墙体/掩体内
        if (minDistFromPlayers > 0) {
          let ok = true;
          for (const p of this.players.values()) {
            if (Math.hypot(p.x - x, p.z - z) < minDistFromPlayers) { ok = false; break; }
          }
          if (!ok) continue;
        }
        return { x, y: groundYAt(MAP, x, 0, z), z };
      }
      return { x: 0, y: 0, z: 0 };
    }
    // 巡逻路线：4 个随机点
    buildPatrolRoute(sp) {
      const pts = [sp];
      for (let i = 0; i < 3; i++) pts.push(this.randomWalkablePoint(0, 40));
      return pts;
    }
    // 生成 SCAV（M2a：巡逻；装备/交火 M2d）
    spawnScavs(count = 4) {
      for (let i = 0; i < count; i++) {
        const id = 'scav_' + i;
        // E025：生成点需避开已有 SCAV（防叠一起——随机点可能重合）
        let sp = null;
        for (let attempt = 0; attempt < 20 && !sp; attempt++) {
          const cand = this.randomWalkablePoint(SCAV_CFG.spawnMinDistFromPlayer, SCAV_CFG.spawnAttempts);
          const tooClose = [...this.scavs.values()].some(o => Math.hypot(o.x - cand.x, o.z - cand.z) < 2.0);
          if (!tooClose) sp = cand;
        }
        if (!sp) sp = this.randomWalkablePoint(SCAV_CFG.spawnMinDistFromPlayer, SCAV_CFG.spawnAttempts);
        const s = {
          id, name: 'SCAV', x: sp.x, y: sp.y, z: sp.z, vy: 0,
          yaw: Math.random() * Math.PI * 2, hp: SCAV_CFG.hp, maxHp: SCAV_CFG.hp, alive: true, // M2 平衡：恢复 100（用户 2026-08-22 要求）
          state: 'patrol', // M2a: patrol；M2b: investigate；M2d: combat
          waypoints: this.buildPatrolRoute(sp), wpIndex: 0, wpPause: SCAV_CFG.wpInitialPauseMin + Math.random() * (SCAV_CFG.wpInitialPauseMax - SCAV_CFG.wpInitialPauseMin),
          speed: this.scavSpeed, lastShot: 0, stepAt: 0, weapon: null, alert: 0,
          // M2b 感知
          visionRange: SCAV_CFG.visionRange, visionAngle: SCAV_CFG.visionAngle, hearingRange: SCAV_CFG.hearingRangeGunshot,
          target: null, invTimer: 0, // 调查目标 + 调查计时
          // M2c 寻路
          path: null, pathIdx: 0,
          // M2d 装备池（PM 70% / AK 30%）+ 战斗
          lastTarget: null, repathAt: 0
        };
        // M2d 随机装备：AK-74 30% / PM 70%（字段完整，尸体掉落可直接入包装备）
        if (Math.random() < (SCAV_CFG.weaponPool.ak74 || 0.3)) {
          s.weapon = { weaponId: 'ak74', name: 'AK-74', dmg: 24, fireRate: 650, magSize: 30, slots: ['sight', 'mag'], ammo: { ammoId: '545x39', count: 30 } };
        } else {
          s.weapon = { weaponId: 'pm', name: 'PM', dmg: 14, fireRate: 320, magSize: 8, slots: ['mag'], ammo: { ammoId: '9x18', count: 8 } };
        }
        this.scavs.set(id, s);
        this.emit('scavSpawn', { id, name: s.name, x: s.x, z: s.z });
      }
    }
    // 通用移动（SCAV 用；E016：统一滑动碰撞 + 防卡死，与玩家同款）
    moveEntity(e, mx, mz, dt) {
      slideMove(MAP, e, mx, mz, PHYSICS.playerR);
      pushOutOfBlock(MAP, e, PHYSICS.playerR);
      e.vy = (e.vy || 0) + PHYSICS.gravity * dt;
      e.y += e.vy * dt;
      const gy = groundYAt(MAP, e.x, e.y, e.z);
      // E018：只在下降/静止时吸附地面（vy<=0），上升不吸（防闪回）
      if (e.y < gy && e.vy <= 0) { e.y = gy; e.vy = 0; }
      if (e.y > 60) { e.y = 60; e.vy = 0; }
    }
    // M2b 视觉感知：视野内（距离+角度+无遮挡）的存活玩家
    visiblePlayer(s) {
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const dx = p.x - s.x, dz = p.z - s.z;
        const dist = Math.hypot(dx, dz);
        if (dist > s.visionRange) continue;
        const toPlayer = Math.atan2(-dx, -dz);
        let angDiff = Math.abs(((toPlayer - s.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (angDiff > (s.visionAngle * Math.PI / 180) / 2) continue;
        // 遮挡：沿"朝玩家方向"的射线检测方块（用 SCAV 朝向会误判侧方玩家）
        const nx = dx / dist, nz = dz / dist;
        const bd = rayHitsBlock(MAP, s.x, s.y + 1.6, s.z, nx, 0, nz, dist);
        if (bd !== null && bd < dist) continue;
        return p;
      }
      return null;
    }
    // M2b 声源感知：枪声 40m / 脚步 12m（由 emit('sound') 触发）
    notifyScavs(snd) {
      const now = Date.now();
      const range = snd.kind === 'shot' ? SCAV_CFG.hearingRangeGunshot : SCAV_CFG.hearingRangeStep;
      for (const s of this.scavs.values()) {
        if (!s.alive || s.state === 'combat') continue;
        if (Math.hypot(s.x - snd.x, s.z - snd.z) < range && s.state === 'patrol') {
          s.state = 'investigate';
          s.target = { x: snd.x, z: snd.z };
          s.invTimer = 0;
          this.emit('scavAlert', { id: s.id, kind: 'sound', x: s.x, z: s.z });
        }
      }
    }
    // SCAV tick（M2a 巡逻 / M2b 感知+调查 / M2d 战斗）
    tickScavs(dt) {
      for (const s of this.scavs.values()) {
        if (!s.alive) continue;
        const now = Date.now();
        // M2d：任何状态看到玩家 → 战斗
        const vis = s.state === 'combat' ? this.visiblePlayer(s) : null;
        if (s.state !== 'combat') {
          const seen = this.visiblePlayer(s);
          if (seen) {
            s.state = 'combat';
            s.lastTarget = { x: seen.x, z: seen.z };
            s.path = null;
            this.emit('scavAlert', { id: s.id, kind: 'vision', x: s.x, z: s.z });
            continue;
          }
        }
        if (s.state === 'combat') {
          // 战斗：锁定视觉目标（丢失则回最后已知位置调查）
          const tgt = this.visiblePlayer(s);
          if (!tgt) {
            s._wasSeen = false; // 丢失视野，重新可见时重置警觉计时
            if (s.lastTarget) {
              s.state = 'investigate';
              s.target = { x: s.lastTarget.x, z: s.lastTarget.z };
              s.invTimer = 0; s.path = null;
            } else { s.state = 'patrol'; }
            continue;
          }
          s.lastTarget = { x: tgt.x, z: tgt.z };
          // 警觉计时：仅首次/重新可见时重置（连续可见不刷新——否则延迟永远不满足）
          if (!s._wasSeen) s.lastSeenAt = now;
          s._wasSeen = true;
          const dist = Math.hypot(tgt.x - s.x, tgt.z - s.z);
          // 视线检测（开火与追击共用）
          const nx = (tgt.x - s.x) / (dist || 0.01), nz = (tgt.z - s.z) / (dist || 0.01);
          const bd = rayHitsBlock(MAP, s.x, s.y + 1.6, s.z, nx, 0, nz, dist);
          const los = bd === null || bd >= dist;
          // 开火条件：距离 ≤25m + 视线无遮挡 + 冷却 600ms + **警觉延迟 0.8s**（玩家反应窗口）
          // + 命中率随距离衰减（近距离 0.55，25m 仅 0.2——远距离打不中，玩家可拉开距离）
          if (dist <= SCAV_CFG.fireRange && los && now - s.lastSeenAt > SCAV_CFG.alertDelayMs) {
            if (!s.lastShot || now - s.lastShot > SCAV_CFG.fireCooldownMs) {
              s.lastShot = now;
              this.emit('sound', { kind: 'shot', x: s.x, y: s.y, z: s.z, scav: true });
              const hitChance = computeScavHitChance(dist, tgt.speedActual || 0); // E024：移动中更难命中
              if (Math.random() < hitChance) {
                const wpn = s.weapon || { dmg: 10 }; // 无武器兜底伤害保持 10（行为兼容）
                const ammoId = wpn.ammo ? wpn.ammo.ammoId : null;
                // SCAV 瞄躯干中心：头线高度的一半（走 CFG，通常判定为胸；护甲按部位生效）
                const headLine = finiteOr((CFG.combat || {}).hitboxTop, 2.1) - finiteOr((CFG.combat || {}).headZone, 0.30);
                const aimY = tgt.y + headLine / 2;
                const ax = tgt.x - s.x, ay = aimY - (s.y + 1.6), az = tgt.z - s.z;
                const al = Math.hypot(ax, ay, az) || 0.0001;
                const part = this.hitPartAt(tgt, s.x, s.y + 1.6, s.z, ax / al, ay / al, az / al);
                const res = this.resolveHit(tgt, wpn, ammoId, part);
                this.emit('hit', { shooter: s.id, target: tgt.id, dmg: res.dmg, hp: tgt.hp, alive: tgt.alive, fromScav: true, part: res.part, armorHit: res.armorHit, absorbed: res.absorbed, durNow: res.durNow });
              }
            }
          }
          // 追击：距离 >9m 或视线被遮挡（需要靠近到能看见）→ A* 动态重算（每 1s）
          if (dist > SCAV_CFG.engageMinDist || !los) {
            if (!s.path || s.path.length === 0 || now - s.repathAt > 1000) {
              s.path = findPath(this.navGrid, s.x, s.z, tgt.x, tgt.z) || null;
              s.pathIdx = 0;
              s.repathAt = now;
            }
            let moveX = tgt.x - s.x, moveZ = tgt.z - s.z;
            if (s.path && s.pathIdx < s.path.length) {
              let wp = s.path[s.pathIdx];
              if (Math.hypot(wp.x - s.x, wp.z - s.z) < 0.9) {
                s.pathIdx++;
                wp = s.path[s.pathIdx];
              }
              if (wp) { moveX = wp.x - s.x; moveZ = wp.z - s.z; }
            }
            const mlen = Math.hypot(moveX, moveZ);
            if (mlen > 0.01) {
              s.yaw = Math.atan2(-moveX, -moveZ);
              const mx = moveX / mlen * s.speed * 1.4 * dt, mz = moveZ / mlen * s.speed * 1.4 * dt;
              this.moveEntity(s, mx, mz, dt);
            }
          } else {
            s.yaw = Math.atan2(-(tgt.x - s.x), -(tgt.z - s.z)); // 原地射击瞄准
          }
          continue;
        }
        if (s.state === 'patrol') {
          const wp = s.waypoints[s.wpIndex];
          if (!wp) continue;
          const dx = wp.x - s.x, dz = wp.z - s.z;
          const dist = Math.hypot(dx, dz);
          if (dist < SCAV_CFG.waypointReachDist) {
            s.wpIndex = (s.wpIndex + 1) % s.waypoints.length;
            s.wpPause = SCAV_CFG.patrolPauseMin + Math.random() * (SCAV_CFG.patrolPauseMax - SCAV_CFG.patrolPauseMin);
          } else {
            s.yaw = Math.atan2(-dx, -dz);
            const mx = dx / dist * s.speed * dt, mz = dz / dist * s.speed * dt;
            this.moveEntity(s, mx, mz, dt);
            if (!s.stepAt || now - s.stepAt > 500) { s.stepAt = now; this.emit('sound', { kind: 'step', x: s.x, y: s.y, z: s.z, scav: true }); }
          }
        } else if (s.state === 'investigate') {
          // 走向调查目标（M2c：A* 路径绕墙；无路径 fallback 直线）
          if (!s.target) { s.state = 'patrol'; continue; }
          const dx = s.target.x - s.x, dz = s.target.z - s.z;
          const dist = Math.hypot(dx, dz);
          if (dist < SCAV_CFG.investigateReachDist) {
            s.invTimer += dt; // 到达后原地搜索
            if (s.invTimer > SCAV_CFG.investigateSearchMs / 1000) { s.state = 'patrol'; s.target = null; s.path = null; s.wpPause = 0; }
          } else {
            // 首次或路径耗尽 → 计算路径（目标固定，算一次即可）
            if (!s.path || s.path.length === 0) {
              s.path = findPath(this.navGrid, s.x, s.z, s.target.x, s.target.z) || null;
              s.pathIdx = 0;
            }
            let moveX = dx, moveZ = dz;
            if (s.path && s.pathIdx < s.path.length) {
              let wp = s.path[s.pathIdx];
              if (Math.hypot(wp.x - s.x, wp.z - s.z) < 0.9) {
                s.pathIdx++;
                wp = s.path[s.pathIdx];
              }
              if (wp) { moveX = wp.x - s.x; moveZ = wp.z - s.z; }
            }
            const mlen = Math.hypot(moveX, moveZ);
            if (mlen > 0.01) {
              s.yaw = Math.atan2(-moveX, -moveZ);
              const mx = moveX / mlen * s.speed * SCAV_CFG.speedInvestigateMul * dt, mz = moveZ / mlen * s.speed * SCAV_CFG.speedInvestigateMul * dt;
              this.moveEntity(s, mx, mz, dt);
            }
          }
        }
      }
    }

    addPlayer(id, name, opts = {}) {
      const sp = spawnPoint(id, this.testMode ? this.players.size : undefined);
      const p = {
        id, name: String(name || 'Player').slice(0, 16),
        x: opts.x !== undefined ? opts.x : sp.x, y: opts.y !== undefined ? opts.y : sp.y, z: opts.z !== undefined ? opts.z : sp.z,
        vx: 0, vy: 0, vz: 0,
        yaw: opts.yaw !== undefined ? opts.yaw : Math.random() * Math.PI * 2, pitch: 0,
        hp: opts.hp !== undefined ? opts.hp : CFG.player.hp, alive: true,
        // v0.15.0 护甲（契约 3.4）：进图适配层经 opts.raidArmor 初始化；缺省 {armor:null, helm:null}
        armor: normalizeArmorState(opts.raidArmor !== undefined ? opts.raidArmor : opts.armor),
        keys: { f: 0, b: 0, l: 0, r: 0 }, jump: false, seq: 0,
        lastShot: 0, stepAt: 0,
        weapon: opts.weapon || null, // 武器实例 {dmg, ammo:{count,ammoId}, fireRate?}，由调用方构造（sim 不依赖 items）
        // 2026-09-26 弹药实体化：局内弹药 = 背包实体堆叠；ammoLib 为派生视图（口径 → 背包总量）
        ammoLib: {},
        // B4：条目形如 {itemId, weight, count, src?}；src∈{'rig','backpack'}（来自进图载荷 raidItems 透传），
        //   缺省视为 'backpack'（保守：sim 内部入包的搜刮物/弹药一律不带 src → 不可快捷使用）
        inventory: opts.inventory || [],
        invCap: opts.invCap !== undefined ? opts.invCap : CFG.player.invCap // 背包容量 kg（调参表）
      };
      // 兼容迁移：旧武器实例的 reserve → 背包实体弹药堆叠（不再进数值库）
      if (p.weapon && p.weapon.ammo && p.weapon.ammo.reserve) {
        const aid = p.weapon.ammo.ammoId;
        this.addInvItem(p, { itemId: aid, weight: this._ammoWeight(aid), count: p.weapon.ammo.reserve });
        p.weapon.ammo.reserve = 0;
      }
      // 进图初始弹药（opts.ammoLib = 口径→发数，来自携带/联机整备）→ 背包实体堆叠
      for (const cal of Object.keys(opts.ammoLib || {})) {
        const v = Math.floor(Number(opts.ammoLib[cal]) || 0);
        if (v > 0) this.addInvItem(p, { itemId: cal, weight: this._ammoWeight(cal), count: v });
      }
      this.refreshAmmoLib(p);
      this.players.set(id, p);
      this.emit('playerJoin', { id, name: p.name });
      return p;
    }
    removePlayer(id) {
      if (this.players.delete(id)) this.emit('playerLeave', { id });
    }
    applyInput(id, input) {
      const p = this.players.get(id);
      if (!p) return;
      const k = input.keys || {};
      // E021：输入入队（每个输入 = 服务器一步）——服务器按队列逐步消费，客户端才能做"回滚+重放"严格对称的预测
      if (!p.inputQueue) p.inputQueue = [];
      p.inputQueue.push({
        seq: typeof input.seq === 'number' ? input.seq : (p.seq || 0) + 1,
        keys: { f: k.f ? 1 : 0, b: k.b ? 1 : 0, l: k.l ? 1 : 0, r: k.r ? 1 : 0 },
        jump: !!input.jump,
        yaw: typeof input.yaw === 'number' ? input.yaw : undefined,
        pitch: typeof input.pitch === 'number' ? Math.max(-1.5, Math.min(1.5, input.pitch)) : undefined,
        reload: !!input.reload,
        fire: !!input.fire
      });
      // 防延迟累积：队列积压过多（网络抖动/客户端加速）丢最旧
      while (p.inputQueue.length > 12) p.inputQueue.shift();
    }
    // 单步移动 + 物理（服务器与客户端预测共用同一套语义，保证重放对称）
    stepPlayer(p, dt) {
      const _px0 = p.x, _pz0 = p.z;
      const fwd = directionFromAngles(p.yaw, 0);
      const right = { x: -fwd.z, y: 0, z: fwd.x };
      let mx = 0, mz = 0;
      if (p.keys.f) { mx += fwd.x; mz += fwd.z; }
      if (p.keys.b) { mx -= fwd.x; mz -= fwd.z; }
      if (p.keys.l) { mx -= right.x; mz -= right.z; }
      if (p.keys.r) { mx += right.x; mz += right.z; }
      const len = Math.hypot(mx, mz);
      // M1b 超重移速惩罚（背包重量 > 容量 → 半速）
      const speedMul = this.invWeight(p) > p.invCap ? CFG.player.overweightSpeedMul : 1;
      if (len > 0) { mx = mx / len * PHYSICS.speed * speedMul * dt; mz = mz / len * PHYSICS.speed * speedMul * dt; }
      // E016：统一滑动碰撞（空中也检测，防跳跃穿进方块）；移动后防卡死推出
      slideMove(MAP, p, mx, mz, PHYSICS.playerR);
      pushOutOfBlock(MAP, p, PHYSICS.playerR);
      if (p.jump && p.y <= groundYAt(MAP, p.x, p.y, p.z) + 0.01) { p.vy = PHYSICS.jumpV; }
      p.vy += PHYSICS.gravity * dt;
      p.y += p.vy * dt;
      const gy = groundYAt(MAP, p.x, p.y, p.z);
      // E018：只在下降/静止时吸附地面（vy<=0）——跳跃上升经过方块侧面不被吸上（防闪回）
      if (p.y < gy && p.vy <= 0) { p.y = gy; p.vy = 0; }
      if (p.y > CFG.physics.maxY) { p.y = CFG.physics.maxY; p.vy = 0; }
      p.jump = false;
      // E024：记录实际水平速度（供 SCAV 命中率做"移动规避"判定）
      p.speedActual = Math.hypot(p.x - _px0, p.z - _pz0) / (dt || 1 / 60);
      // 脚步事件（供听声辨位；M1 起 SCAV AI 感知依赖）
      const now = Date.now();
      if ((Math.abs(mx) > 0.01 || Math.abs(mz) > 0.01) && p.y <= groundYAt(MAP, p.x, p.y, p.z) + 0.01 && (!p.stepAt || now - p.stepAt > CFG.player.stepSoundIntervalMs)) {
        p.stepAt = now;
        this.emit('sound', { kind: 'step', x: p.x, y: p.y, z: p.z });
      }
    }
    // 换弹：弹匣不满 + 弹药库有对应口径 → 开始换弹（1.5s 后完成，期间不能开枪）
    // E020：备弹从玩家统一弹药库 ammoLib 扣（同口径所有枪共用）
    reload(p) {
      if (!p || !p.alive || p.reloading || !p.weapon) return;
      const ammo = p.weapon.ammo;
      const avail = this.invAmmoOf(p, ammo.ammoId); // 2026-09-26：备弹 = 背包内该口径实体堆叠总量
      if (ammo.count >= p.weapon.magSize || avail <= 0) return;
      p.reloading = true;
      p.reloadDoneAt = Date.now() + CFG.combat.reloadMs;
      this.emit('reloadStart', { id: p.id });
    }

    tick(dt) {
      for (const p of this.players.values()) {
        const now = Date.now();
        // 换弹完成检测（1.5s 后：弹药库 → 弹匣，E020 统一从 ammoLib 扣）
        if (p.reloading && now >= p.reloadDoneAt) {
          const ammo = p.weapon ? p.weapon.ammo : null;
          if (ammo) {
            const need = p.weapon.magSize - ammo.count;
            const take = this.takeInvAmmo(p, ammo.ammoId, need); // 2026-09-26：从背包实体堆叠扣弹
            ammo.count += take;
            p.reloading = false;
            this.refreshAmmoLib(p);
            this.emit('reloadDone', { id: p.id, count: ammo.count, reserve: this.invAmmoOf(p, ammo.ammoId) });
          } else {
            p.reloading = false;
          }
        }
        if (!p.alive) continue;
        // E021：按输入队列逐步消费（每输入 = 一步）——与客户端"回滚+重放"严格对称，消除联机闪回
        if (!p.inputQueue) p.inputQueue = [];
        const steps = p.inputQueue.splice(0, 4); // 单 tick 最多 4 步（防抖包暴走）
        if (steps.length === 0) {
          this.stepPlayer(p, dt); // 无输入：仅物理（重力/碰撞），水平不动
        } else {
          for (const inp of steps) {
            p.keys = inp.keys;
            p.jump = inp.jump;
            if (inp.yaw !== undefined) p.yaw = inp.yaw;
            if (inp.pitch !== undefined) p.pitch = inp.pitch;
            if (inp.reload) this.reload(p);
            if (inp.fire && p.alive) this.handleShoot(p);
            this.stepPlayer(p, dt);
            p.seq = inp.seq;
          }
        }
        // M1c 撤离点检测（进入 → 倒计时 → 成功；离开 → 取消）
        let inExtract = null;
        for (const e of this.extracts) {
          if (Math.hypot(p.x - e.x, p.z - e.z) <= e.radius) { inExtract = e; break; }
        }
        if (inExtract) {
          if (!p.extractTarget) {
            p.extractTarget = inExtract.id;
            p.extractAt = now;
            this.emit('extractStart', { id: p.id, extractId: inExtract.id, duration: inExtract.duration });
          }
          const remain = Math.max(0, inExtract.duration - (now - p.extractAt) / 1000);
          this.emit('extractProgress', { id: p.id, remain: Math.ceil(remain) });
          if (remain <= 0 && !p.extracted) {
            p.extracted = true;
            this.emit('extractSuccess', { id: p.id });
          }
        } else if (p.extractTarget) {
          p.extractTarget = null;
          this.emit('extractCancel', { id: p.id });
        }
      }
      this.tickScavs(dt); // M2：SCAV 行为更新（巡逻/后续调查/交火）
    }

    handleShoot(shooter) {
      const now = Date.now();
      if (shooter.reloading) return; // 换弹中不能开枪
      const inst = shooter.weapon;
      // 冷却按武器 fireRate（60000/fireRate ms）：AK 650rpm→92ms，PM 320rpm→188ms；无 fireRate 回退默认
      const cd = inst && inst.fireRate ? 60000 / inst.fireRate : (this._shotCooldown !== undefined ? this._shotCooldown : CFG.combat.shotCooldownMs);
      if (shooter.lastShot && now - shooter.lastShot < cd) return;
      if (!inst) return; // 无武器不能开枪（塔克夫规则：徒手无法射击，摸到枪才能打）
      if (inst.ammo.count <= 0) { this.emit('empty', { id: shooter.id }); return; }
      inst.ammo.count--;
      this.emit('ammo', { id: shooter.id, count: inst.ammo.count, reserve: (shooter.ammoLib || {})[inst.ammo.ammoId] || 0 });
      shooter.lastShot = now;
      const dir = directionFromAngles(shooter.yaw, shooter.pitch);
      const ox = shooter.x, oy = shooter.y + 1.6, oz = shooter.z;
      this.emit('sound', { kind: 'shot', x: shooter.x, y: shooter.y, z: shooter.z });
      // M2d：目标包含玩家 + SCAV（SCAV 有 waypoints 字段用于区分）
      const targets = [...this.players.values(), ...this.scavs.values()];
      const hit = raycastPlayers(MAP, targets, ox, oy, oz, dir.x, dir.y, dir.z, 120, shooter.id);
      if (hit) {
        const ammoId = inst.ammo ? inst.ammo.ammoId : null;
        const part = this.hitPartAt(hit, ox, oy, oz, dir.x, dir.y, dir.z);
        const res = this.resolveHit(hit, inst, ammoId, part);
        const isScav = !!hit.waypoints;
        // 被打的 SCAV 立即转向攻击者还击（塔克夫行为）
        if (isScav && hit.alive) {
          hit.state = 'combat';
          hit.lastTarget = { x: shooter.x, z: shooter.z };
          hit.lastSeenAt = 0; // 被打立即还击（无警觉延迟）
        }
        this.emit('hit', { shooter: shooter.id, target: hit.id, dmg: res.dmg, hp: hit.hp, alive: hit.alive, isScav, part: res.part, armorHit: res.armorHit, absorbed: res.absorbed, durNow: res.durNow });
        if (isScav && !hit.alive) {
          // M2e：SCAV 死亡留尸体（可搜刮容器：武器 + 随机杂物），尸体摸完消失
          const w = hit.weapon;
          const loot = [];
          if (w) {
            loot.push({
              itemId: 'w_' + w.weaponId, isWeapon: true, count: 1, weaponId: w.weaponId,
              dmg: w.dmg, fireRate: w.fireRate, magSize: w.magSize, ammoType: w.ammo.ammoId,
              slots: w.slots || [], ammo: { ...w.ammo }
            });
          }
          // 随机杂物：60% 掉 1 件（按 SCAV 武器口径的弹药箱 / 绷带）
          // E032 修复（2026-09-13）：弹药箱条目必须携带 ammo 字段——否则会逃逸 interactContainer 的
          // 「自动入弹药库」分支而落进背包，背包 UI 的口径判定因缺武器字段恒显示"口径不符"
          // 实测见 .workbuddy/ui-thread/BUG-1_实测报告.md（200 次击杀 58 次掉箱 → 100% 逃逸入库）
          if (Math.random() < SCAV_CFG.corpseExtraLootChance) {
            const lootTable = (CFG.content && CFG.content.loot) || {};
            // 按口径反查弹药箱（数据驱动，替代原硬编码 545/9x18 两分支——加新口径自动适配）
            const boxId = w && Object.keys(lootTable).find(k => {
              const d = lootTable[k];
              return d && d.type === 'ammo' && d.ammo && d.ammo.ammoId === w.ammo.ammoId;
            });
            const box = boxId ? lootTable[boxId] : null;
            if (Math.random() < 0.5 && box) {
              loot.push({ itemId: boxId, weight: box.weight, count: 1, ammo: { ammoId: box.ammo.ammoId, count: box.ammo.count } });
            } else {
              const bandage = lootTable.bandage;
              loot.push({ itemId: 'bandage', weight: bandage ? bandage.weight : 0.1, count: 1 });
            }
          }
          const bodyId = 'body_' + hit.id;
          this.containers.push({ id: bodyId, x: hit.x, z: hit.z, label: 'SCAV 尸体', loot: loot.map(it => this._tagLoot(it)), looted: false }); // E043
          this.emit('scavDead', { id: hit.id, x: hit.x, z: hit.z, by: shooter.id, bodyId });
          this.scavs.delete(hit.id);
        }
      }
    }

    respawn(id) {
      const p = this.players.get(id);
      if (!p) return;
      const sp = spawnPoint(id, this.testMode ? this.players.size : undefined);
      p.x = sp.x; p.y = sp.y; p.z = sp.z; p.hp = 100; p.alive = true;
      this.emit('respawn', { id });
    }

    // ---------- v0.15.0 护甲 / 穿透 / 命中部位（契约 3） ----------
    // 命中点 y（与 core.raycastPlayers 同一水平最近点参数 t）→ 头/胸
    hitPartAt(target, ox, oy, oz, dx, dy, dz) {
      const denom = (dx * dx + dz * dz) || 0.0001;
      const t = ((target.x - ox) * dx + (target.z - oz) * dz) / denom;
      const hitY = oy + dy * (t > 0 ? t : 0);
      return hitPartOf(hitY, target.y, null);
    }
    // 结算一次命中：契约 3.2 减伤 + 扣护具耐久，写回 hp/alive，返回结算明细
    resolveHit(target, weapon, ammoId, part) {
      const res = resolveDamage(ammoId, weapon, part, target.armor || null);
      target.hp = Math.max(0, target.hp - res.dmg);
      if (target.hp <= 0) target.alive = false;
      return res;
    }
    // 运行时替换护具（进图适配层 / 测试用；形状见 normalizeArmorState）
    setArmor(id, raw) {
      const p = this.players.get(id);
      if (!p) return null;
      p.armor = normalizeArmorState(raw);
      return p.armor;
    }
    // 快照视图：{ armor: durNow|null, helm: durNow|null }（契约 3.4，只增字段）
    armorView(p) {
      const st = (p && p.armor) || {};
      const dur = (e) => (e && Number.isFinite(Number(e.durNow))) ? Number(e.durNow) : null;
      return { armor: dur(st.armor), helm: dur(st.helm) };
    }

    snapshot() {
      const players = [];
      for (const p of this.players.values()) {
        players.push({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, vy: p.vy || 0, yaw: p.yaw, pitch: p.pitch, hp: p.hp, alive: p.alive, lastSeq: p.seq, ammoLib: this.refreshAmmoLib(p), weapon: p.weapon ? p.weapon.weaponId : null, isScav: !!p.isScav, armor: this.armorView(p) });
      }
      const scavs = [];
      for (const s of this.scavs.values()) {
        scavs.push({ id: s.id, name: s.name, x: s.x, y: s.y, z: s.z, yaw: s.yaw, hp: s.hp, alive: s.alive, state: s.state });
      }
      return { t: Date.now(), players, scavs };
    }

    emit(type, data) {
      this.events.push({ type, ...data });
      // M2b：玩家声源（枪声/脚步）同步触发 SCAV 感知（SCAV 自身脚步不互触发）
      if (type === 'sound' && data && !data.scav) this.notifyScavs(data);
    }
    drainEvents() { const e = this.events; this.events = []; return e; }

    // ---------- 弹药实体化（2026-09-26 用户决策：档 A 全链实体化）----------
    // 局内弹药 = 背包里的**实体堆叠条目**（itemId 即口径，遵守调参表 stackMax）；
    // ammoLib 降级为**派生视图**（口径 → 背包总量），既有读取方（HUD/快照/结算）零改动。
    _stackMax() {
      const g = CFG.grid || {};
      const v = Math.floor(Number(g.stackMax));
      return (Number.isFinite(v) && v > 0) ? v : 9999;
    }
    _ammoWeight(cal) {
      const a = (CFG.content && CFG.content.ammo) || {};
      const d = a[cal];
      return (d && Number(d.weight)) || 0;
    }
    // 背包内某口径弹药总数
    invAmmoOf(p, cal) {
      let n = 0;
      for (const it of (p.inventory || [])) if (it && it.itemId === cal) n += (it.count || 1);
      return n;
    }
    // 刷新派生弹药库（口径 → 背包总量）
    refreshAmmoLib(p) {
      const lib = {};
      const a = (CFG.content && CFG.content.ammo) || {};
      for (const cal of Object.keys(a)) {
        const n = this.invAmmoOf(p, cal);
        if (n > 0) lib[cal] = n;
      }
      p.ammoLib = lib;
      return lib;
    }
    // 从背包实体堆叠扣除 need 发（跨多叠，从后往前），返回实际扣除数
    takeInvAmmo(p, cal, need) {
      let taken = 0;
      for (let i = p.inventory.length - 1; i >= 0 && taken < need; i--) {
        const e = p.inventory[i];
        if (!e || e.itemId !== cal) continue;
        const take = Math.min(need - taken, e.count || 1);
        if (take <= 0) continue;
        e.count = (e.count || 1) - take;
        taken += take;
        if (e.count <= 0) p.inventory.splice(i, 1);
      }
      return taken;
    }
    // 弹药箱拆包 → 散装弹药条目（武器条目带 ammo 字段但 isWeapon=true，E017，故排除；非弹药箱返回 null）
    _unwrapAmmo(item) {
      if (!item || item.isWeapon || !item.ammo || !item.ammo.ammoId) return null;
      const cal = item.ammo.ammoId;
      const n = Math.max(1, Math.floor(Number(item.ammo.count) || 1));
      return { itemId: cal, weight: this._ammoWeight(cal), count: n };
    }

    // ---------- M1b 背包 ----------
    invWeight(p) {
      return (p.inventory || []).reduce((s, it) => s + (it.weight || 0) * (it.count || 1), 0);
    }
    isOverweight(p) { return this.invWeight(p) > p.invCap; }
    // 拾取容器：距离 <3m 且未搜刮；逐件尝试入包（超重拒绝）
    interactContainer(playerId, containerId) {
      const p = this.players.get(playerId);
      const c = this.containers.find(x => x.id === containerId);
      if (!p || !c || c.looted) return null;
      if (Math.hypot(p.x - c.x, p.z - c.z) > CFG.items.containerSearchRange) return null;
      const picked = [];
      const autoRefilled = []; // 拆包入包的弹药（2026-09-26 实体化：不再「入数值库」）
      for (const item of c.loot) {
        // 弹药箱 → 拆包成散装弹药堆叠入背包（武器条目带 ammo 字段但 isWeapon=true，E017，故由 _unwrapAmmo 排除）
        const incoming = this._unwrapAmmo(item) || item;
        const w = this.invWeight(p) + (incoming.weight || 0) * (incoming.count || 1);
        if (w > p.invCap) { this.emit('invFull', { id: playerId, itemId: incoming.itemId }); continue; }
        this.addInvItem(p, incoming);
        picked.push(item);
        if (incoming.itemId !== item.itemId) autoRefilled.push({ ammoId: incoming.itemId, count: incoming.count });
      }
      c.looted = true;
      this.refreshAmmoLib(p);
      if (autoRefilled.length) {
        this.emit('ammoRefilled', { id: playerId, items: autoRefilled, reserve: p.ammoLib || {} });
      }
      this.emit('containerLooted', { id: playerId, containerId, picked, leftover: c.loot.filter(i => !picked.includes(i)) });
      this.emit('invChanged', { id: playerId, weight: this.invWeight(p), items: p.inventory });
      return picked;
    }
    // E043：容器 loot 条目注入稳定 uid（已有则保留；尸体等运行时生成路径同样走这里）
    _tagLoot(it) {
      if (it && it.uid) return it;
      this._lootSeq = (this._lootSeq || 0) + 1;
      return { ...it, uid: 'cl' + this._lootSeq.toString(36) };
    }

    // E043：塔科夫式搜刮——打开容器。返回当前内容（不改状态，可重复打开）；逐件拿取见 takeFromContainer
    openContainer(playerId, containerId) {
      const p = this.players.get(playerId);
      const c = this.containers.find(x => x.id === containerId);
      if (!p || !c || c.looted) return null;
      if (Math.hypot(p.x - c.x, p.z - c.z) > CFG.items.containerSearchRange) return null;
      this.emit('containerOpened', { id: playerId, containerId, loot: c.loot.map(i => ({ ...i })) });
      return c.loot.map(i => ({ ...i })); // 返回副本：调用方改动不得影响容器（E043 单测防线）
    }

    // E043：从容器逐件拿取（uid 锚定）。弹药自动入备弹库（E020 语义，不进背包），
    // 其余进背包（容量校验，满则拒绝且条目留在容器）。拿空 → looted + containerLooted；未空 → containerLootChanged。
    takeFromContainer(playerId, containerId, uid) {
      const p = this.players.get(playerId);
      const c = this.containers.find(x => x.id === containerId);
      if (!p || !c || c.looted) return { ok: false, reason: 'no-container' };
      if (Math.hypot(p.x - c.x, p.z - c.z) > CFG.items.containerSearchRange) return { ok: false, reason: 'too-far' };
      const idx = c.loot.findIndex(i => i.uid === uid);
      if (idx < 0) return { ok: false, reason: 'no-item' };
      const item = c.loot[idx];
      // 2026-09-26 弹药实体化：弹药（箱→拆包 / 散装）一律入背包成实体堆叠（受容量约束）
      // B4：搜刮入包不带 src → 视为 'backpack'（从容器/尸体捡的不算胸挂，塔科夫语义）
      const incoming = this._unwrapAmmo(item) || item;
      const w = this.invWeight(p) + (incoming.weight || 0) * (incoming.count || 1);
      if (w > p.invCap) { this.emit('invFull', { id: playerId, itemId: incoming.itemId }); return { ok: false, reason: 'inv-full' }; }
      this.addInvItem(p, incoming);
      c.loot.splice(idx, 1);
      this.refreshAmmoLib(p);
      if (incoming.itemId !== item.itemId) {
        this.emit('ammoRefilled', { id: playerId, items: [{ ammoId: incoming.itemId, count: incoming.count }], reserve: p.ammoLib });
      }
      this.emit('invChanged', { id: playerId, weight: this.invWeight(p), items: p.inventory });
      if (!c.loot.length) {
        c.looted = true;
        this.emit('containerLooted', { id: playerId, containerId, picked: [] });
      } else {
        this.emit('containerLootChanged', { id: playerId, containerId, loot: c.loot.map(i => ({ ...i })) });
      }
      return { ok: true };
    }

    addInvItem(p, item) {
      if (item.isWeapon) {
        // 武器不堆叠，完整字段入包（dmg/ammo/mods——M2e 尸体搜刮的武器可装备）
        p.inventory.push({ ...item });
        return;
      }
      // 2026-09-26 实体化：按 stackMax 分叠（先填满已有叠 → 剩余开新叠），绝不无上限合并
      // B4（2026-09-26）：条目可带 src（'rig'|'backpack'，缺省视为 'backpack'）。
      //   ⚠️ 不同 src 的同 itemId 不合并（如搜刮的绷带不得并入胸挂绷带叠）——
      //   否则胸挂叠被搜刮物污染 → 快捷可用数量虚增，违反 B4「宁少不多」保守原则。
      const cap = this._stackMax();
      const srcOf = (e) => e.src || 'backpack';
      const src = srcOf(item);
      let left = Math.max(1, Math.floor(Number(item.count) || 1));
      for (const e of p.inventory) {
        if (left <= 0) break;
        if (e.itemId !== item.itemId) continue;
        if (srcOf(e) !== src) continue; // B4：来源不同不合并
        const room = cap - (e.count || 1);
        if (room <= 0) continue;
        const put = Math.min(room, left);
        e.count = (e.count || 1) + put;
        left -= put;
      }
      while (left > 0) {
        const put = Math.min(cap, left);
        p.inventory.push({ itemId: item.itemId, weight: item.weight || 0, count: put, src: item.src });
        left -= put;
      }
    }
    // 使用物品（医疗 +HP / 弹药箱补弹）——效果参数由调用方从 items 表传入（sim 不依赖表）
    // B4（2026-09-26）：主体逻辑抽入 _consumeInvItem（行为零变化，既有调用方零改动）；
    //   快捷使用走 quickUse（仅 src==='rig' 放行，见下）。
    useItem(playerId, invIndex, heal = 0, ammoRefill = null) {
      const p = this.players.get(playerId);
      if (!p || !p.inventory[invIndex]) return null;
      const item = p.inventory[invIndex];
      if (item.isWeapon) return this.equipWeapon(playerId, invIndex); // 武器条目 → 装备
      return this._consumeInvItem(p, playerId, invIndex, heal, ammoRefill);
    }
    // B4：消费 1 件局内物品并生效（useItem / quickUse 共用主体；签名内部约定，不对外）
    _consumeInvItem(p, playerId, invIndex, heal = 0, ammoRefill = null) {
      const item = p.inventory[invIndex];
      if (!item) return null;
      if (heal > 0) p.hp = Math.min(100, p.hp + heal);
      // 2026-09-26 实体化：弹药箱「使用」= 拆包成散装弹药堆叠入背包（口径由箱自带）
      if (ammoRefill && ammoRefill.ammoId && ammoRefill.count > 0) {
        this.addInvItem(p, {
          itemId: ammoRefill.ammoId,
          weight: this._ammoWeight(ammoRefill.ammoId),
          count: ammoRefill.count
        });
      }
      const used = { itemId: item.itemId, count: 1 };
      if (item.count > 1) item.count--;
      else p.inventory.splice(invIndex, 1);
      this.refreshAmmoLib(p);
      this.emit('usedItem', { id: playerId, itemId: item.itemId, invIndex, remaining: item.count || 0, hp: p.hp });
      this.emit('invChanged', { id: playerId, weight: this.invWeight(p), items: p.inventory });
      return used;
    }
    // B4（2026-09-26）：胸挂快捷使用——塔科夫语义「胸挂内可快捷使用、背包内不可」。
    // 只校验「来源」这一条硬规则（src==='rig'），医疗品/弹药的类型过滤由调用方负责（sim 不依赖 items 表）。
    // src 缺省（undefined，含 sim 内部入包的搜刮物/弹药）一律视为 'backpack' → 保守拒绝（宁少不多）。
    // 返回 {ok:true, used} 或 {ok:false, reason}；拒绝时状态零变化。
    quickUse(playerId, invIndex, heal = 0, ammoRefill = null) {
      const p = this.players.get(playerId);
      if (!p || !p.inventory[invIndex]) return { ok: false, reason: 'no-item' };
      const item = p.inventory[invIndex];
      if (item.isWeapon) return { ok: false, reason: 'is-weapon' };
      if ((item.src || 'backpack') !== 'rig') return { ok: false, reason: 'not-quick-usable' };
      const used = this._consumeInvItem(p, playerId, invIndex, heal, ammoRefill);
      return used ? { ok: true, used } : { ok: false, reason: 'consume-failed' };
    }
    // 装备背包中的武器（旧武器放回背包；新武器带当前弹药）
    equipWeapon(playerId, invIndex) {
      const p = this.players.get(playerId);
      if (!p || !p.inventory[invIndex]) return null;
      const item = p.inventory[invIndex];
      if (!item.isWeapon) return null;
      if (p.weapon) {
        // 旧武器转背包条目（保留弹药/改装，可再装备回来）
        p.inventory.push({
          itemId: 'w_' + p.weapon.weaponId, isWeapon: true, count: 1, weaponId: p.weapon.weaponId,
          dmg: p.weapon.dmg, fireRate: p.weapon.fireRate, magSize: p.weapon.magSize,
          ammoType: p.weapon.ammo.ammoId, slots: p.weapon.slots || [],
          ammo: { ...p.weapon.ammo }, mods: p.weapon.mods ? { ...p.weapon.mods } : {}
        });
      }
      p.weapon = {
        weaponId: item.weaponId, name: item.name || item.weaponId,
        dmg: item.dmg, fireRate: item.fireRate, magSize: item.magSize,
        slots: item.slots || [], mods: item.mods ? { ...item.mods } : {},
        // E020：武器只带弹匣（ammoId/count），备弹统一在 ammoLib
        ammo: { ammoId: item.ammoType, count: item.ammo ? item.ammo.count : 0 }
      };
      p.inventory.splice(invIndex, 1);
      this.emit('equipped', { id: playerId, weaponId: item.weaponId, weaponName: p.weapon.name, ammo: p.weapon.ammo.count });
      this.emit('invChanged', { id: playerId, weight: this.invWeight(p), items: p.inventory });
      return { itemId: item.itemId, count: 1, equipped: true };
    }
    // 丢弃物品
    dropItem(playerId, invIndex) {
      const p = this.players.get(playerId);
      if (!p || !p.inventory[invIndex]) return null;
      const [dropped] = p.inventory.splice(invIndex, 1);
      this.emit('droppedItem', { id: playerId, itemId: dropped.itemId });
      this.emit('invChanged', { id: playerId, weight: this.invWeight(p), items: p.inventory });
      return dropped;
    }
  }

  const SIM = { GameSim, computeScavHitChance };
  if (typeof module !== 'undefined' && module.exports) module.exports = SIM;
  if (typeof window !== 'undefined') window.EXFIL_SIM = SIM;
})();
