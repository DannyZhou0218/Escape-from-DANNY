'use strict';
(function () {
  /*
   * EXFIL ZONE · shared/storage.js — 存档抽象（IIFE 双兼容）
   * 单机（浏览器）：localStorage | Node：本地 JSON 文件（data/local/<key>.json）
   * 联机模式：档案由 server/data.js 管理（本模块仅服务单机）
   */
  function nodeStorage() {
    const fs = (typeof require !== 'undefined') ? require('fs') : null;
    const path = (typeof require !== 'undefined') ? require('path') : null;
    if (!fs) return null;
    const DIR = path ? path.join(__dirname, '..', 'data', 'local') : null;
    return {
      get(key) {
        try {
          if (DIR && fs.existsSync(path.join(DIR, `${key}.json`))) {
            return JSON.parse(fs.readFileSync(path.join(DIR, `${key}.json`), 'utf-8'));
          }
        } catch (e) {}
        return null;
      },
      set(key, val) {
        try {
          fs.mkdirSync(DIR, { recursive: true });
          fs.writeFileSync(path.join(DIR, `${key}.json`), JSON.stringify(val, null, 2), 'utf-8');
          return true;
        } catch (e) { return false; }
      }
    };
  }

  // 单机存档：浏览器 localStorage（离线版零服务器依赖）
  const Store = {
    get(key) {
      if (typeof localStorage !== 'undefined' && localStorage) {
        try { const v = localStorage.getItem('exfil_' + key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
      }
      const ns = nodeStorage();
      return ns ? ns.get(key) : null;
    },
    set(key, val) {
      if (typeof localStorage !== 'undefined' && localStorage) {
        try { localStorage.setItem('exfil_' + key, JSON.stringify(val)); return true; } catch (e) { return false; }
      }
      const ns = nodeStorage();
      return ns ? ns.set(key, val) : false;
    }
  };

  const Storage = { get: Store.get, set: Store.set };
  if (typeof module !== 'undefined' && module.exports) module.exports = Storage;
  if (typeof window !== 'undefined') window.EXFIL_STORAGE = Storage;
})();
