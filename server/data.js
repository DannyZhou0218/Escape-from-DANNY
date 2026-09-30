/*
 * EXFIL ZONE · server/data.js — 存档层（JSON，M1 起完整使用）
 * 玩家档案：{id, name, money, stash: []}；data/profiles/<id>.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Items = require('../shared/items');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

function profilePath(id) { return path.join(PROFILES_DIR, `${id}.json`); }

// 加载档案；不存在则创建默认档案并落盘
function loadProfile(id, name) {
  ensureDirs();
  const p = profilePath(id);
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    // E020：弹药库迁移——旧档案武器 reserve → profile.ammoLib（同口径聚合），武器条目 reserve 清零
    if (!parsed.ammoLib) parsed.ammoLib = {};
    let migrated = false;
    for (const s of (parsed.stash || [])) {
      if (s.weaponId && s.ammo && s.ammo.reserve) {
        parsed.ammoLib[s.ammo.ammoId] = (parsed.ammoLib[s.ammo.ammoId] || 0) + s.ammo.reserve;
        s.ammo.reserve = 0;
        migrated = true;
      }
    }
    // 保底迁移：空仓库 → 补满弹 PM；武器弹药 0 → 补满弹匣（与单机 ensureLoadable 同一函数）
    if (Items.ensureLoadable(parsed)) saveProfile(parsed);
    return parsed;
  } catch (e) {
    const fresh = { id, name: String(name || 'Player').slice(0, 16), money: 1000, stash: [], created: Date.now() };
    Items.ensureLoadable(fresh); // 初始手枪
    saveProfile(fresh);
    return fresh;
  }
}

function saveProfile(profile) {
  ensureDirs();
  fs.writeFileSync(profilePath(profile.id), JSON.stringify(profile, null, 2), 'utf-8');
}

// 异步落盘（E027：结算等非关键路径用，避免同步 I/O 阻塞主循环/网络副线程）
function saveProfileAsync(profile) {
  ensureDirs();
  const data = JSON.stringify(profile, null, 2);
  fs.writeFile(profilePath(profile.id), data, 'utf-8', (err) => {
    if (err) console.error(`[save] 档案落盘失败 ${profile.id}: ${err.message}`);
  });
}

function profileCount() {
  try {
    ensureDirs();
    return fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json')).length;
  } catch (e) { return 0; }
}

module.exports = { loadProfile, saveProfile, saveProfileAsync, profileCount };
