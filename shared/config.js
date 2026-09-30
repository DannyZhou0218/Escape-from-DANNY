'use strict';
(function () {
  /*
   * EXFIL ZONE · shared/config.js — 配置加载层（Node 与浏览器共用）
   * 数据流：config/tuning.json（唯一数据源）
   *   → Node：直接 require JSON
   *   → 浏览器：服务器路由 /shared/tuning.js 动态生成 window.EXFIL_TUNING
   * DEFAULTS 为兜底值：配置缺字段时用默认，绝不因配置缺失崩溃
   * 调参：改 tuning.json → POST /api/reload-config（逻辑层）或刷新页面（表现层）
   */
  const DEFAULTS = {
    physics: {
      speed: 6, gravity: -20, jumpV: 8, playerH: 1.8, playerR: 0.45,
      groundTolerance: 0.15, stepHeight: 0.7, maxY: 60
    },
    player: {
      hp: 100, invCap: 20, overweightSpeedMul: 0.5, bareHandDmg: 12, stepSoundIntervalMs: 400
    },
    combat: {
      shotCooldownMs: 250, reloadMs: 1500, shotRange: 120
    },
    scav: {
      count: 1, hp: 100, speed: 3.2, speedInvestigateMul: 1.3,
      visionRange: 25, visionAngle: 120, hearingRangeGunshot: 40, hearingRangeStep: 12,
      alertDelayMs: 800, fireCooldownMs: 600, fireRange: 25, engageMinDist: 9,
      hitChanceBase: 0.55, hitChanceMin: 0.05, hitChanceDistDiv: 50, moveAccuracyPenaltyMax: 0.55,
      patrolPauseMin: 0.8, patrolPauseMax: 2.0, waypointReachDist: 0.6,
      wpInitialPauseMin: 0.5, wpInitialPauseMax: 1.5,
      investigateSearchMs: 2000, investigateReachDist: 1.2,
      spawnMinDistFromPlayer: 10,
      weaponPool: { ak74: 0.3, pm: 0.7 },
      corpseExtraLootChance: 0.6,
      navGridRange: 40, navGridCell: 1, navClearance: 0.55, routePoints: 4, spawnAttempts: 60
    },
    items: {
      containerSearchRange: 3.0, weaponDropWeight: 1.0
    },
    grid: {
      stashW: 10, stashH: 30, stackMax: 60,
      raidCols: 10, raidRows: 10, lootCols: 8, lootRows: 5,
      slots: ['head', 'armor', 'rig', 'backpack', 'primary', 'secondary', 'melee'],
      // 任务 B · B1：装备容器内部空间（装备物品的 container:{w,h} 优先）
      containers: {
        maxDim: 20,
        fallbackRigW: 4, fallbackRigH: 1,
        fallbackBackpackW: 5, fallbackBackpackH: 3
      }
    },
    client: {
      fov: 75, cameraNear: 0.1, cameraFar: 140,
      mouseSensitivity: 0.0024, maxLookDeltaPerFrame: 0.5,
      renderRatioTiers: [0.6, 0.45, 0.35, 0.28], lowFpsThreshold: 45,
      hitToastThrottleMs: 400,
      recoil: { pitchPerShot: 0.035, pitchRandom: 0.012, yawRandom: 0.008, decayPerFrame60: 0.92 },
      gunKick: { decayPerFrame60: 0.82, back: 0.22, up: 0.06, side: 0.15 },
      muzzleFlashMs: 70, reloadDipHeight: 0.35, hitmarkerMs: 140
    }
  };

  // 深合并：外部配置覆盖默认（对象递归，数组/标量直接替换）
  function deepMerge(base, over) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (!over || typeof over !== 'object') return out;
    for (const k of Object.keys(over)) {
      if (k.startsWith('_')) continue; // 跳过 _说明 等注释字段
      const bv = out[k], ov = over[k];
      if (bv && ov && typeof bv === 'object' && typeof ov === 'object' && !Array.isArray(bv) && !Array.isArray(ov)) {
        out[k] = deepMerge(bv, ov);
      } else if (ov !== undefined) {
        out[k] = ov;
      }
    }
    return out;
  }

  // 外部配置来源（Node: JSON require / 浏览器: window.EXFIL_TUNING + window.EXFIL_CONTENT）
  function loadExternal() {
    try {
      if (typeof module !== 'undefined' && module.exports) {
        // 注意：不能 require JSON（模块缓存会让热重载读到旧值）——必须每次 fs 直读
        const fs = require('fs');
        const path = require('path');
        const readJson = (f) => {
          try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', f), 'utf-8')); }
          catch (e) { return null; }
        };
        const tuning = readJson('tuning.json');
        const content = readJson('content.json');
        if (tuning && content) return { ...tuning, content };
        return tuning || (content ? { content } : null);
      }
      if (typeof window !== 'undefined') {
        const tuning = window.EXFIL_TUNING || null;
        const content = window.EXFIL_CONTENT || null;
        if (tuning && content) return { ...tuning, content };
        return tuning || (content ? { content } : null);
      }
    } catch (e) {
      // 配置缺失/损坏 → 全部走默认值（保证引擎可运行）
    }
    return null;
  }

  const CFG = deepMerge(DEFAULTS, loadExternal());
  // 调参热重载：Node 端替换整个对象（引用不变，各模块读到的即时生效）
  function applyTuning(json) {
    const merged = deepMerge(DEFAULTS, json);
    for (const group of Object.keys(merged)) {
      const cur = CFG[group], next = merged[group];
      if (cur && next && typeof cur === 'object' && typeof next === 'object' && !Array.isArray(cur)) {
        // 原地更新：保持对象引用（core/sim 等模块持有的 CFG.<group> 引用即时看到新值）
        for (const k of Object.keys(cur)) delete cur[k];
        Object.assign(cur, next);
      } else {
        CFG[group] = next;
      }
    }
    return CFG;
  }
  // 重载来源（Node 端重新读文件 / 浏览器端重新读 EXFIL_TUNING）
  function reload() {
    return applyTuning(loadExternal());
  }

  const ConfigLib = { CFG, DEFAULTS, deepMerge, applyTuning, reload, isDefault: !loadExternal() };
  if (typeof module !== 'undefined' && module.exports) module.exports = ConfigLib;
  if (typeof window !== 'undefined') window.EXFIL_CONFIG_LIB = ConfigLib;
})();
