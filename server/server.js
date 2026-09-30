/*
 * EXFIL ZONE · 游戏服务器（多人模式薄壳）
 * 职责：静态页面服务 + WebSocket 传输 + 权威模拟（GameSim）调度 + /health + crash.log + 端口自清理
 * 协议：C→S {join/input/respawn} | S→C {init/state/hit/sound/playerJoin/playerLeave/respawn}
 * 单机模式不需要本服务器（浏览器本地跑 shared/sim.js）；本服务器 = 多人局域网模式
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');
const ConfigLib = require('../shared/config');
const { GameSim } = require('../shared/sim');
const Core = require('../shared/core');

const PORT = parseInt(process.env.PORT || '9090', 10);
const PUBLIC = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;   // 契约4（v0.15.0）：版本号单一数据源 = package.json（不再硬编码）
const TEST_MODE = process.env.EXFIL_TEST === '1';

// ---------- 崩溃日志（基线#7） ----------
const CRASH_LOG = path.join(__dirname, '..', 'crash.log');
function logCrash(tag, err) {
  try { fs.appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] ${tag}: ${err && err.stack || err}\n`, 'utf-8'); } catch (e) {}
}
process.on('uncaughtException', (e) => { logCrash('uncaughtException', e); });
process.on('unhandledRejection', (e) => { logCrash('unhandledRejection', e); });

// ---------- 端口自清理（基线#6） ----------
try {
  const out = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf-8', windowsHide: true });
  const pids = out.split('\n').filter(l => l.includes('LISTENING')).map(l => l.trim().split(/\s+/).pop()).filter(Boolean);
  for (const p of new Set(pids)) { try { execSync(`taskkill /f /pid ${p}`, { windowsHide: true, stdio: 'pipe' }); console.log(`[boot] 清理残留进程 PID=${p}`); } catch (e) {} }
} catch (e) {}

// ---------- 游戏模拟（服务器权威，60Hz 物理 + 30Hz 广播） ----------
const Items = require('../shared/items');

// ---------- E026：联机局内结算（服务器权威档案） ----------
const PLAYER_PROFILES = new Map(); // id -> { profile, ammoStart }
// 契约7.4（本轮仅撤离回写）：局内磨损后的护具耐久 → 档案 equipment（无护具/缺字段静默跳过，绝不抛异常）
function writebackArmorDurability(profile, playerId) {
  try {
    const p = sim.players.get(playerId);
    if (!p || !p.armor || !profile || !profile.equipment) return;
    for (const pair of [['armor', p.armor.armor], ['head', p.armor.helm]]) {
      const slot = pair[0], inst = pair[1], eq = profile.equipment[slot];
      if (!inst || !eq) continue;
      const durNow = Number(inst.durNow);
      if (Number.isFinite(durNow)) eq.durNow = Math.max(0, durNow);
      if (Number.isFinite(Number(inst.durMax)) && eq.durMax === undefined) eq.durMax = Number(inst.durMax);
      if (eq.armorClass === undefined && inst.armorClass !== undefined) eq.armorClass = inst.armorClass;
      if (!Array.isArray(eq.cover) && Array.isArray(inst.cover)) eq.cover = inst.cover.slice();
    }
  } catch (e) { /* 静默：verify.js A8 会把未捕获异常判 FAIL */ }
}

function settleOnlineRaid(playerId, extracted) {
  const p = sim.players.get(playerId);
  const rec = PLAYER_PROFILES.get(playerId);
  if (!rec) return null;
  const prof = rec.profile;
  // E031：玩家 SCAV 结算——撤离成功：随机装备+局内背包并入档案（赚装备）；死亡：无损失
  if (rec.isScav) {
    const result = { ...prof, stash: (prof.stash || []).map(s => ({ ...s, mods: s.mods ? { ...s.mods } : s.mods })) };
    if (extracted) {
      if (p && p.weapon) result.stash.push({ weaponId: p.weapon.weaponId, mods: { ...(p.weapon.mods || {}) }, ammo: { ammoId: p.weapon.ammo.ammoId, count: p.weapon.ammo.count } });
      for (const it of (p ? p.inventory : [])) {
        if (it.isWeapon) result.stash.push({ weaponId: it.weaponId, mods: { ...(it.mods || {}) }, ammo: { ...(it.ammo || { ammoId: it.ammoType, count: 0 }) } });
        else {
          const slot = result.stash.find(s => s.itemId === it.itemId);
          if (slot) slot.count = (slot.count || 1) + (it.count || 1);
          else result.stash.push({ itemId: it.itemId, count: it.count || 1 });
        }
      }
    }
    Items.ensureLoadable(result);
    saveProfileAsync(result);
    rec.profile = result;
    const summary = { extracted, money: result.money, weapons: (result.stash || []).filter(x => x.weaponId).length, loot: (result.stash || []).filter(x => !x.weaponId).length, ammoLib: result.ammoLib || {} };
    console.log(`[raid][SCAV] ${prof.name} ${extracted ? '撤离成功（装备入仓）' : '阵亡（无损失）'}：武器 ${summary.weapons} / 物资 ${summary.loot} / 资金 ${summary.money}`);
    return summary;
  }
  // E026：进图所带武器与当前手持一致才写回弹药；局内换枪则原枪已在背包（随撤离并入仓库）
  const orig = (prof.stash || [])[rec.stashIndex];
  const sameGun = orig && p && p.weapon && orig.weaponId === p.weapon.weaponId;
  const weaponIdx = sameGun ? rec.stashIndex : -1;
  const result = Items.settleRaid(prof, {
    extracted,
    weaponIdx,
    weaponAmmo: (p && p.weapon) ? { ammoId: p.weapon.ammo.ammoId, count: p.weapon.ammo.count } : null,
    weaponMods: (p && p.weapon && p.weapon.mods) ? { ...p.weapon.mods } : null,
    inventory: (p ? p.inventory : []).map(i => ({ ...i }))
  });
  // M4：携带结算——撤离：局内剩余弹药【以实体堆叠归仓】；死亡：携带量【已丢失】（join 时已从档案扣除）
  // 2026-09-26 弹药实体化：settleCarry 返回**完整档案**（stash 里归仓的实体弹药 + 派生 ammoLib），
  // 旧实现只取 .ammoLib 会把归仓弹药丢掉 —— 必须整体接收
  const settledCarry = Items.settleCarry(result, { extracted, raidAmmo: (p && p.ammoLib) || {} });
  Object.assign(result, settledCarry);
  if (extracted) writebackArmorDurability(result, playerId); // 契约7.4：仅撤离回写耐久
  Items.ensureLoadable(result); // 保底（防止破产后无法再玩）
  saveProfileAsync(result); // E027：异步落盘，不阻塞主循环 tick
  rec.profile = result;
  const summary = {
    extracted,
    money: result.money,
    weapons: (result.stash || []).filter(x => x.weaponId).length,
    loot: (result.stash || []).filter(x => !x.weaponId).length,
    ammoLib: result.ammoLib
  };
  console.log(`[raid] ${rec.profile.name} ${extracted ? '撤离成功' : '阵亡'}：武器 ${summary.weapons} / 物资 ${summary.loot} / 资金 ${summary.money}`);
  return summary;
}

// E022：联机世界生成（服务器权威）——容器战利品与单机同款加权生成
function makeContainers() {
  return Items.CONTAINERS.map(c => ({
    id: c.id, x: c.x, z: c.z, label: c.label,
    loot: Items.rollContainerLoot(c).map(itemId => {
      const def = Items.LOOT[itemId];
      const ammoTag = def && def.ammo ? { ammoId: def.ammo.ammoId, count: def.ammo.count } : null;
      return { itemId, weight: def ? def.weight : 0, count: 1, ammo: ammoTag };
    })
  }));
}
const sim = new GameSim({ testMode: TEST_MODE, containers: makeContainers(), extracts: Items.EXTRACTS });
const TICK_MS = 16;
const BROADCAST_MS = 33;
const { loadProfile, saveProfileAsync } = require('./data');
const Disc = require('./discovery'); // E035：局域网房间自动发现（UDP 广播/监听）
// 联机默认武器：档案第一把枪；无档案武器则默认 AK-74（M3 接整备后替换）
function onlineWeapon(profile, stashIndex) {
  try {
    const stash = profile.stash || [];
    const gun = (typeof stashIndex === 'number' && stash[stashIndex] && stash[stashIndex].weaponId)
      ? stash[stashIndex]
      : stash.find(s => s.weaponId);
    return Items.makeWeaponInstance(gun || Items.defaultStash()[0]);
  } catch { return null; }
}
// E031：随机 SCAV 武器（玩家 SCAV 形态用，与 AI SCAV 同池 AK 30% / PM 70%）
// E039：SCAV 出征装备抽取已下沉到 shared/items.js（单机/联机共用同一实现，支持武器池扩展）
function randomScavWeapon() {
  try { return Items.randomScavWeapon(); } catch { return null; }
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of wss.clients) { if (ws.readyState === ws.OPEN) ws.send(s); }
}
function send(ws, msg) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }

// ---------- HTTP 静态服务 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon' };
// 开发期禁用缓存（E010：旧 HTML 缓存 + 新 JS = shared 模块未加载 → "核心模块加载失败"）
const NO_CACHE = { 'Cache-Control': 'no-store' };
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()), players: sim.players.size, version: VERSION, mode: TEST_MODE ? 'lan-test' : 'lan' }));
    return;
  }
  // 热重载调参表：改 config/tuning.json 后调用即生效（无需重启服务器）
  if (url === '/api/room') {
    // 房间概要（供局域网扫描识别与列表展示）
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE });
    res.end(JSON.stringify({
      type: 'roomInfo', name: ROOM_NAME, players: ROOM.players.size, max: ROOM_MAX,
      state: ROOM.state, ips: localIPs, port: PORT, version: VERSION
    }));
    return;
  }
  if (url === '/api/discover') {
    // 局域网房间列表（本机房间 + UDP 广播发现的房间）
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE });
    res.end(JSON.stringify({
      self: { name: ROOM_NAME, players: ROOM.players.size, max: ROOM_MAX, state: ROOM.state, ips: localIPs, port: PORT, version: VERSION },
      rooms: Disc.list().filter(r => !(r.port === PORT && localIPs.includes(r.ip)))
    }));
    return;
  }
  if (url === '/api/reload-config') {
    try {
      const cfg = ConfigLib.reload();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE });
      res.end(JSON.stringify({ ok: true, physics: cfg.physics, player: cfg.player, combat: cfg.combat, scav: cfg.scav }));
    } catch (e) {
      logCrash('reload-config', e);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
    return;
  }
  // 当前生效配置（只读查询，便于验收/调参核对）
  if (url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE });
    res.end(JSON.stringify(ConfigLib.CFG));
    return;
  }
  if (url === '/api/map') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ blocks: Core.MAP.length, list: Core.MAP }));
    return;
  }
  if (url.startsWith('/vendor/')) {
    const rel = url.slice('/vendor/'.length);
    if (!rel.startsWith('three/')) { res.writeHead(403); res.end('forbidden'); return; }
    const vfull = path.normalize(path.join(__dirname, '..', 'node_modules', rel));
    if (!vfull.startsWith(path.join(__dirname, '..', 'node_modules'))) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(vfull, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(vfull).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...NO_CACHE });
      res.end(data);
    });
    return;
  }
  // 共享逻辑模块（单机模式浏览器本地运行 GameSim）
  // 调参表动态下发：读 config/tuning.json → window.EXFIL_TUNING（每次请求重读，改配置刷新页面即生效）
  if (url === '/shared/tuning.js') {
    fs.readFile(path.join(__dirname, '..', 'config', 'tuning.json'), 'utf-8', (err, data) => {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', ...NO_CACHE });
      if (err) { res.end('window.EXFIL_TUNING = null; // tuning.json 读取失败，浏览器将使用默认值'); return; }
      res.end('window.EXFIL_TUNING = ' + data + ';');
    });
    return;
  }
  // 内容表动态下发：读 config/content.json → window.EXFIL_CONTENT（武器/战利品/容器/撤离点）
  if (url === '/shared/content.js') {
    fs.readFile(path.join(__dirname, '..', 'config', 'content.json'), 'utf-8', (err, data) => {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', ...NO_CACHE });
      if (err) { res.end('window.EXFIL_CONTENT = null; // content.json 读取失败，浏览器将使用内置默认表'); return; }
      res.end('window.EXFIL_CONTENT = ' + data + ';');
    });
    return;
  }
  if (url.startsWith('/shared/')) {
    const rel = url.slice('/shared/'.length);
    if (!/^(core|sim|map|items|grid|containers|loadout|raidinv|storage|bt|config|predict)\.js$/.test(rel)) { res.writeHead(403); res.end('forbidden'); return; }
    const sfull = path.normalize(path.join(__dirname, '..', 'shared', rel));
    if (!sfull.startsWith(path.join(__dirname, '..', 'shared'))) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(sfull, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', ...NO_CACHE });
      res.end(data);
    });
    return;
  }
  let fp = url === '/' ? '/index.html' : url;
  const full = path.normalize(path.join(PUBLIC, fp));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...NO_CACHE });
    // 契约4：仅 / 与 /index.html 现场注入 {{VERSION}}（不缓存注入结果；无占位符时不得报错）
    if (url === '/' || url === '/index.html') { res.end(String(data).split('{{VERSION}}').join(VERSION)); return; }
    res.end(data);
  });
});

// E027：指令队列——网络回调（副线程）只入队，主循环统一消费（与 E021 的 input 队列同一纪律）
const pendingCommands = [];

// ---------- E035：房间（Lobby）系统 ----------
// 设计：一个服务器 = 一个房间；首个进入者即房主，全员「准备」后房主方可开局。
const ROOM = {
  state: 'lobby',          // 'lobby' | 'playing'
  players: new Map(),      // roomId -> { id, ws, name, ready, joinMsg }
  startedAt: 0
};
const ROOM_MAX = 8;
let ROOM_NAME = (process.env.ROOM_NAME || '').trim() || (os.hostname().slice(0, 14) + ' 的房间');

function roomHostId() {
  const f = ROOM.players.values().next();
  return f.done ? null : f.value.id;
}

function roomSnapshot() {
  const host = roomHostId();
  return {
    type: 'room',
    roomName: ROOM_NAME,
    state: ROOM.state,
    hostId: host,
    maxPlayers: ROOM_MAX,
    players: [...ROOM.players.values()].map(r => ({
      id: r.id, name: r.name, ready: !!r.ready, isHost: r.id === host,
      isScav: !!(r.joinMsg && r.joinMsg.isScav), // E037：SCAV 形态在房间内可见
      weaponName: (r.joinMsg && r.joinMsg.weaponName) || null
    }))
  };
}
function pushRoom() { broadcast(roomSnapshot()); }

// E037：一局结束后房间必须复位为 lobby —— 否则 ROOM.state 永久停留 'playing'，
// 之后所有人 enterRoom 都会收到「本局已开始，请稍后」→ 房间永久锁死（2026-09-19 探针实测复现）
function maybeResetRoom() {
  if (ROOM.state !== 'playing') return;
  if (sim.players.size > 0) return; // 仍有人在局内 → 不动
  ROOM.state = 'lobby';
  ROOM.startedAt = 0;
  for (const r of ROOM.players.values()) r.ready = false; // 新一局需重新准备
  console.log('[room] 本局结束，房间已复位为 lobby');
  pushRoom();
}

// E038：断线/离房时的局内清理 —— 以 ws.playerId 为准。
// 旧实现用的是连接闭包里的局部 myId，而它只在 `join` 直进路径被赋值（房间开局路径赋的是
// ws.playerId）→ 房间开局的玩家断线后不会 sim.removePlayer，留下幽灵（可被击中 / 人数虚高）
function evictFromRaid(ws) {
  const pid = ws.playerId;
  if (pid && sim.players.has(pid)) {
    sim.removePlayer(pid);
    console.log('[game] 玩家离场 ' + pid + '，在线 ' + sim.players.size);
  }
}

function enterRoom(ws, msg) {
  if (ROOM.state === 'playing') { send(ws, { type: 'roomError', msg: '本局已开始，请稍后' }); return; }
  if (ROOM.players.size >= ROOM_MAX) { send(ws, { type: 'roomError', msg: '房间已满（' + ROOM_MAX + ' 人）' }); return; }
  const id = Math.random().toString(36).slice(2, 8);
  const rec = {
    id, ws,
    name: String(msg.name || '玩家').slice(0, 16),
    ready: false,
    joinMsg: {
      id: msg.id, name: msg.name,
      stashIndex: (typeof msg.stashIndex === 'number') ? msg.stashIndex : -1,
      isScav: !!msg.isScav,
      weaponName: msg.weaponName || null
    }
  };
  ROOM.players.set(id, rec);
  ws.roomId = id;
  ws.playerId = null;
  send(ws, { type: 'roomJoined', id, room: roomSnapshot() });
  console.log('[room] ' + rec.name + '(' + id + ') 进入房间，当前 ' + ROOM.players.size + '/' + ROOM_MAX);
  pushRoom();
}

function setReady(ws, msg) {
  const rec = ROOM.players.get(ws.roomId);
  if (!rec) return;
  rec.ready = !!msg.ready;
  pushRoom();
}

// E037 配套：房间内切换「以 SCAV 身份出战」（服务端本就支持 isScav，此前客户端无入口）
// SCAV 形态 = 随机装备 + 空弹药库；撤离装备归仓、阵亡无损失（见 settleOnlineRaid 的 rec.isScav 分支）
function setScav(ws, msg) {
  const rec = ROOM.players.get(ws.roomId);
  if (!rec) return;
  if (ROOM.state === 'playing') return;
  rec.joinMsg.isScav = !!msg.isScav;
  rec.ready = false; // 换形态视同换装备 → 取消准备，避免用错形态开局
  console.log('[room] ' + rec.name + (rec.joinMsg.isScav ? ' 切换为 SCAV 形态' : ' 切换为 PMC 形态'));
  pushRoom();
}

function leaveRoom(ws) {
  const rec = ROOM.players.get(ws.roomId);
  if (!rec) return;
  ROOM.players.delete(rec.id);
  ws.roomId = null;
  evictFromRaid(ws); // E038：离房同时清理局内实体（幂等）
  console.log('[room] ' + rec.name + ' 离开房间，剩 ' + ROOM.players.size + ' 人');
  pushRoom();
  maybeResetRoom(); // E037：最后一人离场 → 房间回 lobby
}

function startRaid(ws) {
  const rec = ROOM.players.get(ws.roomId);
  if (!rec) { send(ws, { type: 'roomError', msg: '你不在房间中' }); return; }
  if (roomHostId() !== rec.id) { send(ws, { type: 'roomError', msg: '只有房主可以开始' }); return; }
  if (ROOM.state === 'playing') { send(ws, { type: 'roomError', msg: '本局已开始' }); return; }
  const list = [...ROOM.players.values()];
  const notReady = list.filter(r => !r.ready);
  if (!list.length) return;
  if (notReady.length) { send(ws, { type: 'roomError', msg: '还有 ' + notReady.length + ' 人未准备' }); return; }
  ROOM.state = 'playing';
  ROOM.startedAt = Date.now();
  console.log('[room] 房主开局，' + list.length + ' 人进图');
  for (const r of list) {
    const nid = enterRaid(r.ws, r.joinMsg, r.id);
    if (nid) r.ws.playerId = nid;
  }
  pushRoom();
}

// ---------- 进图（join 直进 / 房间开局 共用） ----------
function enterRaid(ws, msg, forcedId) {
  const profileKey = (typeof msg.id === 'string' && msg.id) ? msg.id.slice(0, 24) : Math.random().toString(36).slice(2, 8);
  const id = forcedId || Math.random().toString(36).slice(2, 8);
  let profile = loadProfile(profileKey, msg.name);
  const stashIndex = (typeof msg.stashIndex === 'number') ? msg.stashIndex : -1;
  const isScav = !!msg.isScav;
  let raidAmmo = {}, raidItems = [];
  let raidArmor = { armor: null, helm: null };   // 契约7.1：档案护具 → sim.addPlayer
  if (!isScav) {
    // 契约5（G4）：联机携带链与单机对齐——读 rig/backpack 实体条目（takeAll 会从 containers 扣除）
    const carried = Items.takeCarryFromContainers(profile);
    profile = carried.profile;
    raidAmmo = carried.raidAmmo;
    raidItems = carried.raidItems;
    raidArmor = carried.raidArmor || raidArmor;   // 契约7.1：护具随携带链进局
    // 必须落盘：携带物已从 profile.containers 扣除；不落盘 → 重进/崩溃可刷物资（E027 异步落盘）
    saveProfileAsync(profile);
  }
  const p = sim.addPlayer(id, profile.name, {
    weapon: isScav ? randomScavWeapon() : onlineWeapon(profile, stashIndex),
    ammoLib: isScav ? {} : { ...raidAmmo },
    inventory: isScav ? [] : raidItems.map(i => ({ ...i })),
    raidArmor: raidArmor
  });
  if (isScav) p.isScav = true;
  PLAYER_PROFILES.set(id, { profile, ammoStart: { ...raidAmmo }, stashIndex, isScav });
  if (sim.scavs.size === 0 && !TEST_MODE) sim.spawnScavs(1);
  ws.playerId = id;
  send(ws, {
    type: 'init', id, map: Core.MAP, physics: Core.PHYSICS, players: sim.snapshot().players,
    version: VERSION, profile, weapon: p.weapon,
    containers: sim.containers.map(c => ({ id: c.id, x: c.x, z: c.z, label: c.label, looted: c.looted })),
    extracts: sim.extracts
  });
  console.log('[game] 玩家进图: ' + p.name + ' (' + id + ')，在线 ' + sim.players.size);
  return id;
}

// ---------- WebSocket 传输层 ----------
const wss = new WebSocketServer({ server });
const localIPs = Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'getProfile') {
      // M3e：联机整备——返回服务器档案（客户端进图前展示仓库/资金/备弹库，选武器）
      const pid = (typeof msg.id === 'string' && msg.id) ? msg.id.slice(0, 24) : Math.random().toString(36).slice(2, 8);
      const prof = loadProfile(pid, msg.name);
      send(ws, { type: 'profile', id: pid, profile: prof });
    } else if (msg.type === 'trade') {
      // E030：联机商人/改装（lobby 阶段，档案服务器权威，纯函数判定 + 落盘）
      const pid = (typeof msg.id === 'string' && msg.id) ? msg.id.slice(0, 24) : null;
      if (!pid) return;
      const prof = loadProfile(pid, msg.name);
      const res = Items.tradeProfile(prof, msg.action);
      if (res && res.ok) saveProfileAsync(res.profile);
      send(ws, { type: 'profile', id: pid, profile: res ? res.profile : prof, ok: res ? res.ok : false, msg: res ? res.msg : '未知操作' });
    } else if (msg.type === 'join') {
      // 直接进图（单人快速进图 / 验收脚本路径；房间流程见 startRaid）
      enterRaid(ws, msg); // E047：局内身份统一存 ws.playerId（enterRaid 内部写入），不再维护闭包 myId
    } else if (msg.type === 'enterRoom') {
      enterRoom(ws, msg);
    } else if (msg.type === 'setReady') {
      setReady(ws, msg);
    } else if (msg.type === 'setScav') {
      setScav(ws, msg);
    } else if (msg.type === 'startRaid') {
      startRaid(ws);
    } else if (msg.type === 'leaveRoom') {
      leaveRoom(ws);
    // E047：以下分支一律以 ws.playerId（每连接唯一、join 与 startRaid 两条路径都会写）判定局内身份。
    // 旧实现用连接闭包里的 myId，而它只在 join 直进路径被赋值 → 房间开局（实际游玩路径）下恒为 null，
    // input 被 `&& myId` 拦下 → 服务器从不消费玩家输入 → 客户端每次和解都被拉回出生点（"橡皮筋"）。
    } else if (msg.type === 'input' && ws.playerId) {
      sim.applyInput(ws.playerId, msg);
    } else if (msg.type === 'search' && ws.playerId) {
      pendingCommands.push({ kind: 'search', id: ws.playerId, containerId: msg.containerId }); // E027 入队（= 全部拿走）
    } else if (msg.type === 'openContainer' && ws.playerId) {
      pendingCommands.push({ kind: 'openContainer', id: ws.playerId, containerId: msg.containerId }); // E043：塔科夫式逐件搜刮
    } else if (msg.type === 'takeFromContainer' && ws.playerId) {
      pendingCommands.push({ kind: 'takeFromContainer', id: ws.playerId, containerId: msg.containerId, uid: msg.uid }); // E043
    } else if (msg.type === 'useItem' && ws.playerId) {
      pendingCommands.push({ kind: 'useItem', id: ws.playerId, index: msg.index });
    } else if (msg.type === 'quickUse' && ws.playerId) {
      pendingCommands.push({ kind: 'quickUse', id: ws.playerId, index: msg.index }); // 契约1：只入队，写操作在 tick 边界
    } else if (msg.type === 'dropItem' && ws.playerId) {
      pendingCommands.push({ kind: 'dropItem', id: ws.playerId, index: msg.index });
    } else if (msg.type === 'respawn' && ws.playerId) {
      pendingCommands.push({ kind: 'respawn', id: ws.playerId });
    }
  });
  ws.on('close', () => {
    leaveRoom(ws);     // 房间成员：出房间名册 + 局内清理 + 房间状态复位
    evictFromRaid(ws); // E038：非房间路径（join 直进 / 验收脚本）也须清理局内实体
    maybeResetRoom();  // E037：最后一人断线 → 房间回 lobby
  });
  ws.on('error', () => {});
});

// ---------- 主循环：指令消费 → 物理 tick → 事件广播 + 快照广播 ----------
setInterval(() => {
  // E027：先消费指令队列（网络副线程只入队，此处统一执行——状态修改只发生在 tick 边界）
  while (pendingCommands.length) {
    const c = pendingCommands.shift();
    if (c.kind === 'search') {
      sim.interactContainer(c.id, c.containerId); // 全部拿走（原语义保留，RVP A5e 走此路径）
    } else if (c.kind === 'openContainer') {
      sim.openContainer(c.id, c.containerId);     // E043：事件 containerOpened 广播，客户端按 id 过滤
    } else if (c.kind === 'takeFromContainer') {
      sim.takeFromContainer(c.id, c.containerId, c.uid); // E043：事件 containerLootChanged / containerLooted 广播
    } else if (c.kind === 'useItem') {
      const p = sim.players.get(c.id);
      const it = p && p.inventory[c.index];
      if (it) {
        const def = Items.LOOT[it.itemId];
        sim.useItem(c.id, c.index, def ? def.heal || 0 : 0,
          def && def.ammo ? { ammoId: def.ammo.ammoId, count: def.ammo.count } : null);
      }
    } else if (c.kind === 'quickUse') {
      const p = sim.players.get(c.id);
      const it = p && p.inventory[c.index];
      if (it) {
        const def = Items.LOOT[it.itemId];
        sim.quickUse(c.id, c.index, def ? def.heal || 0 : 0,
          def && def.ammo ? { ammoId: def.ammo.ammoId, count: def.ammo.count } : null);
      }
    } else if (c.kind === 'dropItem') {
      sim.dropItem(c.id, c.index);
    } else if (c.kind === 'respawn') {
      sim.respawn(c.id);
    }
  }
  sim.tick(TICK_MS / 1000);
  for (const ev of sim.drainEvents()) {
    if (ev.type === 'playerJoin' || ev.type === 'playerLeave') continue; // 已在连接处理广播
    // E026：局内结算钩子（撤离成功 / 玩家阵亡）→ 服务器权威落档 + 通知 + 离场
    if (ev.type === 'extractSuccess') {
      broadcast(ev);
      const summary = settleOnlineRaid(ev.id, true);
      broadcast({ type: 'raidResult', id: ev.id, ...(summary || { extracted: true }) });
      if (sim.players.has(ev.id)) sim.removePlayer(ev.id); // 包装版已广播 playerLeave
      continue;
    }
    if (ev.type === 'hit' && !ev.isScav && ev.alive === false) {
      broadcast(ev);
      const summary = settleOnlineRaid(ev.target, false);
      broadcast({ type: 'raidResult', id: ev.target, ...(summary || { extracted: false }) });
      if (sim.players.has(ev.target)) sim.removePlayer(ev.target); // 包装版已广播 playerLeave
      continue;
    }
    broadcast(ev);
  }
  maybeResetRoom(); // E037：本 tick 内若已无人在局内 → 房间复位为 lobby
}, TICK_MS);
setInterval(() => broadcast({ type: 'state', ...sim.snapshot() }), BROADCAST_MS);

// playerJoin/Leave 由 sim 事件驱动即时广播（连接/断开时）
const origAdd = sim.addPlayer.bind(sim);
sim.addPlayer = (id, name, opts) => {
  const p = origAdd(id, name, opts); // 透传 opts（含 weapon，否则联机玩家徒手不能开枪）
  broadcast({ type: 'playerJoin', id, name: p.name });
  return p;
};
const origRemove = sim.removePlayer.bind(sim);
sim.removePlayer = (id) => {
  origRemove(id);
  broadcast({ type: 'playerLeave', id });
};

// ---------- 启动 ----------
server.listen(PORT, '0.0.0.0', () => {
  // E035：启动 LAN 房间发现（广播自己 + 监听他人）
  Disc.start({
    roomName: () => ROOM_NAME,
    info: () => ({ players: ROOM.players.size, max: ROOM_MAX, state: ROOM.state }),
    ips: () => localIPs,
    port: PORT,
    version: VERSION
  });
  console.log(`[boot] EXFIL ZONE v${VERSION} 已启动（${TEST_MODE ? '测试模式' : '局域网联机模式'}）`);
  console.log(`[boot] 本机访问: http://localhost:${PORT}`);
  if (localIPs.length) console.log(`[boot] 局域网加入: http://${localIPs[0]}:${PORT}`);
  console.log(`[boot] 物理 60Hz | 广播 30Hz | 玩家上限 8`);
});
