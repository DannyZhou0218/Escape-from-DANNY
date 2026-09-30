/*
 * EXFIL ZONE · 客户端（双模式）
 * 单机模式（solo）：浏览器本地跑 GameSim（shared/sim.js），零网络延迟，输入直接本地消费
 * 联机模式（online）：WebSocket 连服务器，服务器权威 + 客户端预测 + EMA 偏差补偿
 */
import * as THREE from '/vendor/three/build/three.module.js';

// 全局共享模块（index.html 已用 <script> 加载 shared/*.js）
const CORE = window.EXFIL_CORE;
const SIM = window.EXFIL_SIM;
const ITEMS = window.EXFIL_ITEMS;
const STORAGE = window.EXFIL_STORAGE;
const PREDICT = window.EXFIL_PREDICT; // 联机预测-和解（E021）
const LOADOUT = window.EXFIL_LOADOUT; // P2：整备档案适配层（格子/装备 ↔ 既有 stash 格式）
const GRIDUI = window.EXFIL_GRID;     // P2：格子几何（P1 冻结接口，只调用不修改）
const RAIDINV = window.EXFIL_RAIDINV; // P4：局内背包视图网格（仅视觉；sim 的 inventory 仍是数组）
const CONTAINERS = window.EXFIL_CONTAINERS; // 任务 B：装备容器空间（胸挂/背包；纯函数库）
// 调参表（config/tuning.json → shared/config.js 的 CFG；客户端表现参数全从这里读）
const CFG = (window.EXFIL_CONFIG_LIB && window.EXFIL_CONFIG_LIB.CFG) || {};
const CCLIENT = CFG.client || {};
const CRECOIL = CCLIENT.recoil || {};
const CKICK = CCLIENT.gunKick || {};

let mode = 'solo';       // 'solo' | 'online'
let sim = null;          // 单机模式模拟
let ws = null;
let myId = 'solo';
let myName = '玩家' + Math.floor(Math.random() * 900 + 100);
let profileId = null;       // 联机档案持久 id（localStorage，跨局复用）
let raidIsScav = false;     // E039：本局是否以 SCAV 形态进入（决定结算语义：不扣仓库 / 阵亡无损失）
let connected = false;
let dead = false;
let mapBlocks = [];
let PHY = CORE ? CORE.PHYSICS : { speed: 6, gravity: -20, jumpV: 8, playerH: 1.8, playerR: 0.45 };
let remotePlayers = new Map();

// M1a 整备状态
let profile = null;            // 单机档案（localStorage）
let selectedIdx = -1;          // 出战武器的 legacy 仓库下标（P2：由 selectedUid 派生，保持 join.stashIndex / 结算语义）
let selectedUid = null;        // P2：出战武器 uid（格子锚点；杜绝裸下标悬空）
let focusUid = null;           // P2：最近点选的格内物品（按 R 旋转它）
let dragState = null;          // P2：拖拽会话（自写 pointer 事件，D4）
const GRID_SLOT_LABEL = { primary: '主武器', secondary: '副武器', head: '头盔', armor: '防弹衣', rig: '胸挂', backpack: '背包', melee: '近战' };
let raidWeapon = null;         // 进图携带的武器实例
let localAmmoLib = {};         // 联机模式：服务器快照同步的弹药库（口径→数量）
let raidAmmoStart = {};        // 进图时的弹药库快照（死亡结算用：局内捡的弹药丢失）

// 本地状态
const local = { x: 0, y: 0, z: 0, vy: 0, yaw: 0, pitch: 0, hp: 100, alive: true };
const keys = { f: false, b: false, l: false, r: false };
let jumpPending = false; // 单机模式跳跃标记（本地 tick 消费）
let reloading = false; // 换弹中标志（R 键换弹，1.5s）
let firing = false;
let seq = 0;
let soloAcc = 0;
// E021 联机预测-和解状态
let remoteContainers = []; // E022：联机世界容器（服务器权威，含 looted 状态）
let remoteInventory = [];  // E022：联机背包（服务器 invChanged 事件维护的副本）
let pendingInputs = [];   // 待服务器确认的输入队列（用于回滚重放）
let onlineAcc = 0;        // 联机 60Hz 步进累加器
// P4（2026-09-20 用户需求）：局内背包「视图网格」——搜刮要看得见、要能拖
let raidLayout = null;      // { w, h, items:[{uid,itemId,x,y,rot,count,ammo}] } 仅客户端布局
let raidLastTap = { uid: null, t: 0 }; // 局内双击识别（pointerdown 的 preventDefault 会压掉 DOM dblclick）
let raidCell = 32;          // 局内格子像素
let raidSelUid = null;      // 局内选中项 uid
let lootFlash = {};         // uid → 高亮到期时间（刚搜到的物品）
let lootFrom = '';          // 面板来源容器名
let pendingLootOpen = null; // 搜刮后待打开面板
// E043：塔科夫式容器搜刮（容器有自己的格子，逐件选择拿取）
let lootOpen = null;        // 当前打开的容器 { containerId, loot:[{uid,itemId,...}] }
let lootLayout = null;      // 容器视图网格（uid 驱动，跨广播稳定）
let lootCell = 27;
const bias = { x: 0, z: 0 };

const dom = {
  hpfill: document.getElementById('hpfill'),
  hpnum: document.getElementById('hpnum'),
  msg: document.getElementById('msg'),
  net: document.getElementById('net'),
  players: document.getElementById('players'),
  toast: document.getElementById('toast'),
  canvas: document.getElementById('game'),
  crosshair: document.getElementById('crosshair'),
  hitmarker: document.getElementById('hitmarker'),
  hitflash: document.getElementById('hitflash'),
  // ---- 阶段一①：补齐原先分散直取的静态元素（一处查询，后续改 id 只动这里）----
  fps: document.getElementById('fps'),
  lobby: document.getElementById('lobby'),
  money: document.getElementById('money'),
  ammoLib: document.getElementById('ammo-lib'),
  // ---- P2：配装格子（塔克夫式拖拽）静态元素 ----
  stashGrid: document.getElementById('stash-grid'),
  gridCap: document.getElementById('grid-cap'),
  gridHint: document.getElementById('grid-hint'),
  equipslots: document.getElementById('equipslots'),
  carryBox: document.getElementById('carry-box'),
  // ---- 任务 B · B3：携带空间（胸挂 / 背包两个容器格）----
  rigGrid: document.getElementById('rig-grid'),
  backpackGrid: document.getElementById('backpack-grid'),
  carryCap: document.getElementById('carry-cap'),
  carryHint: document.getElementById('carry-hint'),
  trader: document.getElementById('trader'),
  detail: document.getElementById('wdetail'),
  lobbyEnter: document.getElementById('lobby-enter'),
  lobbyEnterScav: document.getElementById('lobby-enter-scav'),
  invPanel: document.getElementById('inv-panel'),
  interactHint: document.getElementById('interact-hint'),
  extractBar: document.getElementById('extract-bar'),
  extractTxt: document.getElementById('extract-txt'),
  extractFill: document.getElementById('extract-fill'),
  summary: document.getElementById('summary'),
  summaryRes: document.getElementById('summary-res'),
  summaryList: document.getElementById('summary-list'),
  ammo: document.getElementById('ammo'),
  weaponName: document.getElementById('weapon-name'),
  invW: document.getElementById('inv-w'),
  invList: document.getElementById('inv-list'),
  // ---- P4：局内背包格子（静态元素，一处查询）----
  invTitle: document.getElementById('inv-title'),
  invGrid: document.getElementById('inv-grid'),
  invAct: document.getElementById('inv-act'),
  invUsed: document.getElementById('inv-used'),
  invCap: document.getElementById('inv-cap'),
  // ---- E043：容器搜刮栏（静态元素，一处查询）----
  lootPane: document.getElementById('loot-pane'),
  lootGrid: document.getElementById('loot-grid'),
  lootTitle: document.getElementById('loot-title'),
  lootTakeAll: document.getElementById('loot-take-all'),
  // ---- E035：局域网大厅 / 房间页（静态元素，一处查询）----
  guide: document.getElementById('guide'),
  lanhall: document.getElementById('lanhall'),
  lanList: document.getElementById('lan-list'),
  lanSelf: document.getElementById('lan-self'),
  lanCreate: document.getElementById('lan-create'),
  room: document.getElementById('room'),
  roomTitle: document.getElementById('room-title'),
  roomSub: document.getElementById('room-sub'),
  roomGrid: document.getElementById('room-grid'),
  roomWeapon: document.getElementById('room-weapon'),
  roomReady: document.getElementById('room-ready'),
  roomStart: document.getElementById('room-start'),
  roomScav: document.getElementById('room-scav'),
  roomErr: document.getElementById('room-err')
};
// 动态元素（运行时由 renderLobby 等创建，不能顶层注册）——统一入口，便于集中排错
function dyn(id) { return document.getElementById(id); }
let toastTimer = null;
function toast(text) {
  dom.toast.textContent = text;
  dom.toast.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.style.opacity = 0; }, 2200);
}
function bigMsg(text, sub) {
  dom.msg.innerHTML = text ? `<div class="big">${text}</div><div class="sub">${sub || ''}</div>` : '';
}
function setHp(hp) {
  dom.hpfill.style.width = `${Math.max(0, Math.min(100, hp))}%`;
  if (dom.hpnum) dom.hpnum.textContent = hp;
}
function fireFeedback() {
  if (audio) playNoise(0.12, 0.5, 2);
  applyRecoil(); // 后坐力反馈（视角上抬 + 枪模型后坐 + 枪口火光），不再全屏闪
  dom.crosshair.classList.add('pop');
  setTimeout(() => { dom.crosshair.classList.remove('pop'); }, 120);
}
// 声音事件统一入口：自己的 shot（<2.5m）= 开火确认 → 本地反馈（枪声+闪光+准星，与弹药消耗同源）
// 别人的声音 → 距离衰减播放
function handleSoundEvent(ev) {
  const d = Math.hypot(ev.x - local.x, ev.z - local.z);
  if (ev.kind === 'shot' && d < 2.5) fireFeedback();
  else playSound(ev.kind, ev.x, ev.y, ev.z);
}
function hitFlashRed() {
  dom.hitflash.style.opacity = 1;
  setTimeout(() => { dom.hitflash.style.opacity = 0; }, 200);
}
function hitMarkerShow() {
  dom.hitmarker.style.display = 'block';
  setTimeout(() => { dom.hitmarker.style.display = 'none'; }, CCLIENT.hitmarkerMs || 140);
}
function handleHitEvent(ev) {
  if (ev.target === myId) {
    local.hp = ev.hp;
    setHp(ev.hp);
    hitFlashRed();
    playHit();
    if (!ev.alive) {
      dead = true; local.alive = false;
      if (mode === 'solo') showSummary('death'); // M1c：死亡 → 结算（装备丢失）
      else bigMsg('你被击倒了', ''); // 联机：服务器结算 + raidResult 面板（E026）
    }
    else { toast(`受到 ${ev.dmg} 伤害`); }
  } else if (ev.shooter === myId) {
    hitMarkerShow();
    // 命中提示节流：650rpm 连发不刷屏（400ms 只提示一次）
    const now = Date.now();
    if (now - (window.__lastHitToast || 0) > (CCLIENT.hitToastThrottleMs || 400)) {
      window.__lastHitToast = now;
      toast(ev.hp <= 0 ? '击杀!' : `命中 ${ev.hp} 血`);
    }
  }
}

// ---------- 渲染器（像素风） ----------
const renderer = new THREE.WebGLRenderer({ antialias: false });
const RATIO_TIERS = CCLIENT.renderRatioTiers || [0.6, 0.45, 0.35, 0.28];
let ratioIdx = 0;
renderer.setPixelRatio(RATIO_TIERS[0]);
renderer.setSize(window.innerWidth, window.innerHeight);
dom.canvas.appendChild(renderer.domElement);
try {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
  if (/swiftshader|llvmpipe|software/i.test(gpuName)) {
    dom.net.textContent = '软件渲染';
    toast('检测到软件渲染（无 GPU 加速）——建议用 Chrome/Edge 打开');
  }
} catch (e) {}
let fpsFrames = 0, fpsT0 = performance.now(), curFps = 60, downCount = 0;
function fpsTick() {
  fpsFrames++;
  const now = performance.now();
  if (now - fpsT0 >= 1500) {
    curFps = Math.round(fpsFrames * 1000 / (now - fpsT0));
    fpsFrames = 0; fpsT0 = now;
    const fpsEl = dom.fps;
    if (fpsEl) {
      fpsEl.textContent = `${curFps} FPS`;
      fpsEl.style.color = curFps >= 50 ? '#7ee787' : (curFps >= 30 ? '#ffd54f' : '#ff6b6b');
    }
    if (curFps < (CCLIENT.lowFpsThreshold || 45) && ratioIdx < RATIO_TIERS.length - 1) {
      if (++downCount >= 2) { ratioIdx++; renderer.setPixelRatio(RATIO_TIERS[ratioIdx]); downCount = 0; }
    } else if (curFps >= 58 && ratioIdx > 0 && downCount < -1) {
      ratioIdx--; renderer.setPixelRatio(RATIO_TIERS[ratioIdx]);
    }
    if (curFps >= 50) downCount = 0;
  }
}
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb4c7);
scene.fog = new THREE.Fog(0x9fb4c7, 55, 105);
const camera = new THREE.PerspectiveCamera(CCLIENT.fov || 75, window.innerWidth / window.innerHeight, CCLIENT.cameraNear || 0.1, CCLIENT.cameraFar || 140);
scene.add(camera); // 必须挂进场景图：相机子对象（第一人称持枪模型）才会被渲染
scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const sun = new THREE.DirectionalLight(0xfff3d6, 1.1);
sun.position.set(30, 60, 20);
scene.add(sun);
const sun2 = new THREE.DirectionalLight(0x8fb3ff, 0.3);
sun2.position.set(-20, 30, -30);
scene.add(sun2);

function buildMap(blocks) {
  mapBlocks = blocks;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshLambertMaterial();
  const inst = new THREE.InstancedMesh(geo, mat, blocks.length);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const mtx = new THREE.Matrix4();
  blocks.forEach((b, i) => {
    p.set(b.x, b.y, b.z); q.identity(); s.set(b.w, b.h, b.d);
    inst.setMatrixAt(i, mtx.compose(p, q, s));
    inst.setColorAt(i, new THREE.Color(b.c));
  });
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  scene.add(inst);
}

// ---------- 客户端碰撞/预测（联机模式用；单机用 sim 权威） ----------
function collidesXZ(px, py, pz, r) {
  for (const b of mapBlocks) {
    if (b.y + b.h / 2 <= 0.01) continue;
    const hw = b.w / 2, hd = b.d / 2;
    const bTop = b.y + b.h / 2, bBot = b.y - b.h / 2;
    if (px > b.x - hw - r && px < b.x + hw + r && pz > b.z - hd - r && pz < b.z + hd + r
      && py < bTop && py + PHY.playerH > bBot) return b;
  }
  return null;
}
function groundYAt(px, py, pz) {
  let gy = 0;
  for (const b of mapBlocks) {
    const hw = b.w / 2, hd = b.d / 2;
    const top = b.y + b.h / 2;
    if (top <= py + 0.01 && px > b.x - hw && px < b.x + hw && pz > b.z - hd && pz < b.z + hd) gy = Math.max(gy, top);
  }
  return gy;
}
function dirFromYaw(yaw) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return { x: -sy, z: -cy };
}
function onGroundLocal() { return local.y <= groundYAt(local.x, local.y, local.z) + 0.01; }

// 角度插值（处理 ±π 环绕）——远端玩家转向平滑，不瞬跳
function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ---------- 其他玩家渲染 ----------
const matCache = new Map();
function boxMat(color) {
  if (!matCache.has(color)) matCache.set(color, new THREE.MeshLambertMaterial({ color }));
  return matCache.get(color);
}
function makeNameTexture(name, hp) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 28px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = hp <= 0 ? '#8a9299' : '#7ee787';
  ctx.fillText(`${name}  ${hp}`, 128, 40);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  return tex;
}
function makeNameSprite(name, hp) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeNameTexture(name, hp), depthTest: false }));
  sprite.scale.set(2.4, 0.6, 1);
  return sprite;
}
function makePlayerMesh(alive, isScav) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.1, 0.4), boxMat(isScav ? 0x5d6b3c : 0x4e5d6c));
  body.position.y = 1.1;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), boxMat(isScav ? 0xb0a090 : 0xd8a878));
  head.position.y = 1.95;
  g.add(body, head);
  g.visible = alive;
  return g;
}
// 第三人称持枪模型（远端玩家手持，随 group 朝向旋转；-z 为前方）
function buildRemoteGun(weaponId) {
  const g = new THREE.Group();
  const add = (w, h, d, x, y, z, c) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: c }));
    m.position.set(x, y, z); g.add(m);
  };
  const short = weaponId === 'pm';
  const len = short ? 0.32 : (weaponId === 'mp5' ? 0.5 : 0.8);
  add(0.06, 0.06, len, 0, 0, -len / 2, 0x3a3f46); // 枪管（朝前 -z）
  add(0.09, 0.10, 0.16, 0, -0.01, 0.08, 0x2b2e33); // 机匣
  add(0.06, 0.12, 0.08, 0, -0.13, 0.02, 0x2b2e33); // 弹匣（向下）
  g.position.set(0, 1.12, -0.34); // 身体前方手持高度
  return g;
}
function upsertRemote(p) {
  let r = remotePlayers.get(p.id);
  if (!r) {
    const g = makePlayerMesh(p.alive, p.isScav);
    scene.add(g);
    const name = makeNameSprite(p.name, p.hp);
    name.position.y = 2.6;
    g.add(name);
    r = { group: g, prev: null, cur: p, _t: 0, gun: null, gunId: null };
    remotePlayers.set(p.id, r);
  }
  // E029：武器切换（捡枪/换枪）→ 更新远端持枪模型
  const wid = p.weapon || null;
  if ((r.gunId || null) !== wid) {
    if (r.gun) { r.group.remove(r.gun); r.gun = null; }
    if (wid) { r.gun = buildRemoteGun(wid); r.group.add(r.gun); }
    r.gunId = wid;
  }
  r.prev = { ...r.cur };
  r._t = performance.now();
  r.cur = p;
}
function removeRemote(id) {
  const r = remotePlayers.get(id);
  if (r) { scene.remove(r.group); remotePlayers.delete(id); }
}
// ---------- M2 SCAV 渲染（绿色人形 + 名字标签） ----------
const scavMeshes = new Map(); // id -> { group }
function buildScavMesh(s) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.1, 0.4), boxMat(0x5d6b3c)); // 暗绿（SCAV 色）
  body.position.y = 1.1;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), boxMat(0xb0a090));
  head.position.y = 1.95;
  g.add(body, head);
  // M2d 头顶血条：背景红 + 前景绿（左对齐，随 hp 缩放）
  const barBg = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.09), new THREE.MeshBasicMaterial({ color: 0xcc3b3b, transparent: true, opacity: 0.9 }));
  barBg.position.y = 2.45;
  const barFg = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.09), new THREE.MeshBasicMaterial({ color: 0x53d769, transparent: true, opacity: 0.95 }));
  barFg.position.y = 2.45;
  barFg.position.z = 0.005;
  g.add(barBg, barFg);
  g.userData.barFg = barFg;
  const name = makeNameSprite(s.name, s.hp);
  name.name = 'scavName'; // 供状态标签更新
  name.position.y = 2.62;
  g.add(name);
  g.visible = s.alive;
  scene.add(g);
  return g;
}
function updateScavBar(m, s) {
  const fg = m.group.userData.barFg;
  if (!fg) return;
  const ratio = Math.max(0, Math.min(1, s.hp / (s.maxHp || 60)));
  fg.scale.x = ratio;
  fg.position.x = -0.45 + 0.45 * ratio; // 左端固定
  fg.material.color.set(ratio > 0.5 ? 0x53d769 : (ratio > 0.25 ? 0xffc94d : 0xff6b6b));
}
// 阶段一③：单机/联机 SCAV 同步合并为单一实现（原两份函数重复 90%）
// list：SCAV 集合（Map.values() 迭代器 或 数组）；trackState：是否跟踪 state 变化（单机 sim 权威时跟踪）
function syncScavs(list, trackState) {
  const seen = new Set();
  for (const s of (list || [])) {
    seen.add(s.id);
    let m = scavMeshes.get(s.id);
    if (!m) { m = { group: buildScavMesh(s) }; scavMeshes.set(s.id, m); }
    m.group.position.set(s.x, s.y, s.z);
    m.group.rotation.y = s.yaw;
    m.group.visible = s.alive;
    updateScavBar(m, s); // M2d：血条随 hp 更新
    // 名字标签（含 hp 数字）：血量变化必须实时重建（否则出现「命中不扣血」错觉）；单机额外跟踪 state
    const hpChanged = s._shownHp !== s.hp;
    const stateChanged = trackState && s._shownState !== s.state;
    if (hpChanged || stateChanged) {
      if (trackState) s._shownState = s.state;
      s._shownHp = s.hp;
      const label = s.state === 'patrol' ? 'SCAV' : (s.state === 'investigate' ? '调查中' : '战斗中');
      const name = m.group.getObjectByName('scavName');
      if (name) name.material.map = makeNameTexture(`${label}  ${s.hp}`, s.hp);
    }
  }
  for (const id of [...scavMeshes.keys()]) {
    if (!seen.has(id)) { const m = scavMeshes.get(id); scene.remove(m.group); scavMeshes.delete(id); }
  }
}
// 单机：sim 权威（薄封装，仅承载 !sim 守卫）
function syncScavsFromSim() { if (sim) syncScavs(sim.scavs.values(), true); }
// M2d/M2e：SCAV 死亡 → 移除模型 + 生成尸体容器（可搜刮）
function handleScavDead(ev) {
  const m = scavMeshes.get(ev.id);
  if (m) { scene.remove(m.group); scavMeshes.delete(ev.id); }
  // 尸体容器 mesh（深红，区别于普通棕箱）
  if (ev.bodyId && containerGroup) {
    containerGroup.add(buildContainerMesh({ id: ev.bodyId, x: ev.x, z: ev.z, label: 'SCAV 尸体' }, 0x8d4a3a));
  }
  toast(ev.by === myId ? '击杀 SCAV！靠近按 F 搜刮尸体' : 'SCAV 被击毙');
}
function updatePlayerList() {
  const cur = Array.from(remotePlayers.values()).map(r => r.cur);
  if (!cur.length) { dom.players.innerHTML = '<div style="color:#6b757d">在线玩家: 仅你一人</div>'; return; }
  dom.players.innerHTML = '<div style="color:#90a4ae">在线玩家</div>' + cur.map(p =>
    `<div class="p ${p.alive ? '' : 'dead'}">${p.name} ${p.alive ? p.hp + '❤' : '✝'}</div>`).join('');
}

// ---------- 音频 ----------
let audio = null;
function initAudio() {
  if (audio || !window.AudioContext) return;
  audio = new (window.AudioContext || window.webkitAudioContext)();
}
function playNoise(dur, vol, decayPow) {
  const buf = audio.createBuffer(1, Math.max(1, Math.floor(audio.sampleRate * dur)), audio.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, decayPow);
  const src = audio.createBufferSource();
  src.buffer = buf;
  const g = audio.createGain();
  g.gain.value = vol;
  src.connect(g); g.connect(audio.destination);
  src.start();
  return src;
}
function playSound(kind, x, y, z) {
  if (!audio) return;
  const dist = Math.hypot(x - local.x, y - local.y, z - local.z);
  const vol = Math.max(0, Math.min(1, 1 - dist / 45));
  if (vol <= 0.01) return;
  if (kind === 'shot') playNoise(0.12, 0.5 * vol, 2);
  else if (kind === 'step') playNoise(0.06, 0.15 * vol, 2);
}
function playHit() {
  if (!audio) return;
  const o = audio.createOscillator();
  o.type = 'square';
  o.frequency.setValueAtTime(200, audio.currentTime);
  const g = audio.createGain();
  g.gain.setValueAtTime(0.22, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.15);
  o.connect(g); g.connect(audio.destination);
  o.start(); o.stop(audio.currentTime + 0.16);
}

// ================= E035：局域网大厅 + 房间（CF 式） =================
let roomSnap = null;          // 最近一次房间快照
let pendingRoomEntry = false; // 当前拉档案的目的是进入房间
let lanTimer = null;

function wsSend(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function escRoom(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function currentWeaponName() {
  const s = (profile && profile.stash) ? profile.stash[selectedIdx] : null;
  if (!s || !s.weaponId) return null;
  const def = ITEMS.WEAPONS[s.weaponId];
  return def ? def.name : s.weaponId;
}

function hideAllPanels() {
  dom.lanhall.style.display = 'none';
  dom.room.style.display = 'none';
  dom.lobby.style.display = 'none';
}

// ---- 局域网大厅：自动发现同一 WiFi 下的房间 ----
function showLanHall() {
  enterOnlineMode(); // E036：进入联机界面即设定联机模式并启动渲染循环
  hideAllPanels();
  dom.guide.style.display = 'none';
  dom.lanhall.style.display = 'flex';
  refreshLan();
  if (lanTimer) clearInterval(lanTimer);
  lanTimer = setInterval(refreshLan, 3000); // 每 3 秒自动刷新
}

async function refreshLan() {
  if (!dom.lanList) return;
  try {
    const r = await fetch('/api/discover');
    const j = await r.json();
    const self = j.self || {};
    dom.lanSelf.textContent = (self.players > 0) ? (self.name + '（' + self.players + ' 人）') : '未创建';
    const rooms = j.rooms || [];
    dom.lanList.innerHTML = rooms.length
      ? rooms.map((rm) => (
          '<div class="lanitem" onclick="window._exfilJoinLan(\'' + rm.ip + '\',' + rm.port + ')">'
          + '<div class="ln">' + escRoom(rm.name) + '</div>'
          + '<div class="sub">' + rm.ip + ':' + rm.port + ' · ' + rm.players + '/' + rm.max
          + ' 人 · ' + (rm.state === 'playing' ? '游戏中' : '等待中') + '</div></div>'
        )).join('')
      : '<div class="sub">暂未发现其他房间 —— 让房主点「创建房间」；本列表每 3 秒自动刷新</div>';
  } catch (e) {
    dom.lanList.innerHTML = '<div class="sub">扫描失败（请通过服务器页面访问）：' + e.message + '</div>';
  }
}

// ---- 创建/加入房间 ----
function createRoom() {
  enterOnlineMode(); // E036：联机入口必须启动渲染循环（否则开局黑屏）
  if (lanTimer) { clearInterval(lanTimer); lanTimer = null; }
  hideAllPanels();
  dom.guide.style.display = 'none';
  dom.room.style.display = 'flex';
  dom.roomSub.textContent = '正在连接服务器…';
  pendingRoomEntry = true;
  if (ws && ws.readyState === 1) wsSend({ type: 'getProfile', id: profileId, name: myName });
  else setupOnline();
}

function joinLanRoom(ip, port) {
  location.href = 'http://' + ip + ':' + port + '/?join=1';
}

// ---- 房间页渲染 ----
function renderRoom() {
  if (!roomSnap) return;
  dom.room.style.display = 'flex';
  dom.lanhall.style.display = 'none';
  const pl = roomSnap.players || [];
  const me = pl.find((p) => p.id === myId);
  const isHost = !!me && me.isHost;
  dom.roomTitle.textContent = roomSnap.roomName + '（' + pl.length + '/' + roomSnap.maxPlayers + '）';
  dom.roomSub.textContent = roomSnap.state === 'playing'
    ? '游戏进行中'
    : '等待玩家准备…（全员准备后，房主可开始）';
  dom.roomGrid.innerHTML = pl.map((p) => (
    '<div class="pcell' + (p.isHost ? ' host' : '') + (p.ready ? ' ready' : '') + '">'
    + '<div class="pn">' + escRoom(p.name) + '</div>'
    + '<div class="ps">' + (p.isScav ? 'SCAV · ' : '') + (p.isHost ? '房主' : (p.ready ? '已准备' : '未准备')) + '</div></div>'
  )).join('');
  const iReady = !!(me && me.ready);
  dom.roomReady.textContent = iReady ? '取消准备' : '准备';
  dom.roomReady.style.background = iReady ? '#5d6b3c' : '#1565c0';
  // E037 配套：SCAV 形态开关（随机装备 · 撤离归仓 · 阵亡无损失）
  if (dom.roomScav) {
    const iScav = !!(me && me.isScav);
    dom.roomScav.textContent = iScav ? 'SCAV 出战：已开启（点击取消）' : '以 SCAV 身份出战';
    dom.roomScav.style.background = iScav ? '#5d6b3c' : '#37474f';
  }
  dom.roomStart.style.display = isHost ? 'block' : 'none';
  renderRoomWeapon();
}

function renderRoomWeapon() {
  if (!dom.roomWeapon) return;
  // E037 配套：SCAV 形态下出战武器由服务器随机下发，房间内不再选枪
  const me = roomSnap && (roomSnap.players || []).find((p) => p.id === myId);
  if (me && me.isScav) {
    dom.roomWeapon.innerHTML = '<div class="sub">SCAV 形态：随机装备进入（撤离装备归仓 · 阵亡无损失）</div>';
    return;
  }
  if (!profile) { dom.roomWeapon.innerHTML = '<div class="sub">档案加载中…</div>'; return; }
  const guns = (profile.stash || []).map((s, i) => ({ s, i })).filter((x) => x.s.weaponId);
  if (!guns.length) { dom.roomWeapon.innerHTML = '<div class="sub">仓库暂无武器（将以徒手进入）</div>'; return; }
  dom.roomWeapon.innerHTML = guns.map((x) => {
    const def = ITEMS.WEAPONS[x.s.weaponId] || {};
    return '<button class="rtbtn' + (x.i === selectedIdx ? ' sel' : '')
      + '" onclick="window._exfilPickWeapon(' + x.i + ')">'
      + escRoom(def.name || x.s.weaponId) + (x.i === selectedIdx ? '  ◀ 出战' : '') + '</button>';
  }).join('');
}

function pickWeapon(i) {
  selectedIdx = i;
  selectedUid = (profile && profile.stash && profile.stash[i]) ? profile.stash[i].uid : null; // P2：与 uid 锚定保持一致
  renderRoomWeapon();
  wsSend({ type: 'setReady', ready: false }); // 换枪后自动取消准备（避免用错枪开局）
}

function roomReady() {
  if (!roomSnap) return;
  const me = (roomSnap.players || []).find((p) => p.id === myId);
  wsSend({ type: 'setReady', ready: !(me && me.ready) });
}

// E037 配套：房间内切换 SCAV / PMC 形态（服务器权威，等 room 快照回传后再渲染）
function roomScavToggle() {
  if (!roomSnap) return;
  const me = (roomSnap.players || []).find((p) => p.id === myId);
  wsSend({ type: 'setScav', isScav: !(me && me.isScav) });
}

function roomStart() { wsSend({ type: 'startRaid' }); }

function roomLeave() {
  wsSend({ type: 'leaveRoom' });
  setTimeout(() => location.reload(), 200);
}

function hideRoomUI() {
  dom.room.style.display = 'none';
  dom.lanhall.style.display = 'none';
}

window._exfilShowLan = showLanHall;
window._exfilRefreshLan = refreshLan;
window._exfilCreateRoom = createRoom;
window._exfilJoinLan = joinLanRoom;
window._exfilRoomReady = roomReady;
window._exfilRoomScav = roomScavToggle;
window._exfilRoomStart = roomStart;
window._exfilRoomLeave = roomLeave;
window._exfilPickWeapon = pickWeapon;

// ================= 联机模式（WebSocket） =================
function setupOnline() {
  detachGun(); // 联机持枪模型由 init 下发的武器实例重建
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    connected = true; dom.net.textContent = '联机·已连接';
    // M3e：先拉服务器档案 → 整备界面选武器 → 再 join（持久 id 跨局复用）
    if (!profileId) profileId = STORAGE.get('playerId');
    if (!profileId) { profileId = 'p' + Math.random().toString(36).slice(2, 10); STORAGE.set('playerId', profileId); }
    ws.send(JSON.stringify({ type: 'getProfile', id: profileId, name: myName }));
  };
  ws.onclose = () => { connected = false; dom.net.textContent = '联机·已断开'; bigMsg('连接已断开', '刷新页面重试'); };
  ws.onerror = () => { dom.net.textContent = '联机·错误'; };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case 'profile':
        // M3e：服务器档案（E035：拉档案后进入房间，由房主开局）
        mode = 'online';
        profile = LOADOUT.ensure(m.profile); // P2：服务器档案 → 补 grid/equipment 骨架并对齐（联机格子只读）
        profileId = m.id;
        myName = profile.name;
        selectedUid = LOADOUT.findWeaponUid(profile, profile.selectedUid || null);
        ensureValidSelection(); // 统一守卫（无武器时保持 -1，不再硬指 0）
        if (m.msg) toast(m.msg); // E030：trade 响应的提示（购买/卖出/钱不够）
        if (pendingRoomEntry) {
          pendingRoomEntry = false;
          wsSend({
            type: 'enterRoom', id: profileId, name: myName,
            stashIndex: selectedIdx, weaponName: currentWeaponName()
          });
        } else {
          renderRoom(); // trade 等响应 → 刷新房间内武器列表
        }
        break;
      case 'roomJoined':
        myId = m.id;
        roomSnap = m.room;
        renderRoom();
        break;
      case 'room':
        roomSnap = m;
        if (dom.room.style.display !== 'none') renderRoom();
        break;
      case 'roomError': {
        if (dom.roomErr) {
          dom.roomErr.textContent = m.msg || '操作失败';
          setTimeout(() => { dom.roomErr.textContent = ''; }, 3000);
        }
        break;
      }
      case 'raidResult':
        if (m.id === myId) showOnlineSummary(m);
        break;
      case 'init':
        hideRoomUI(); // E035：开局 → 关闭房间/大厅界面
        myId = m.id;
        if (m.physics) PHY = m.physics;
        buildMap(m.map);
        const sp = m.players.find(p => p.id === myId);
        if (sp) { local.x = sp.x; local.y = sp.y; local.z = sp.z; local.hp = sp.hp; local.alive = sp.alive; setHp(sp.hp); }
        // E026/M3e：服务器下发的武器实例 → 持枪模型 + 弹药 HUD（整备选择生效）
        if (m.weapon) { raidWeapon = m.weapon; attachGun(m.weapon); updateAmmoHUD(m.weapon); }
        else { raidWeapon = null; detachGun(); }
        for (const p of m.players) if (p.id !== myId) upsertRemote(p);
        // E022：渲染服务器下发的世界（容器 + 撤离点）
        remoteContainers = m.containers || [];
        if (remoteContainers.length) buildContainers(remoteContainers);
        if (m.extracts && m.extracts.length) buildExtracts(m.extracts);
        remoteInventory = (m.profile && m.profile.stash) ? [] : []; // 局内背包从空开始（server invChanged 维护）
        if (m.scavs) syncScavs(m.scavs, false);
        bigMsg('', '');
        requestPointerLock();
        // E036：服务器消息触发的指针锁定会被浏览器拒绝（要求用户手势）→ 明确提示点击画面
        toast(`已加入联机（${m.players.length} 人）· 点击画面锁定鼠标 · F 搜刮 · Tab 背包`);
        break;
      case 'state': applySnapshot(m); break;
      case 'playerJoin': toast(`${m.name} 进入地图`); break;
      case 'playerLeave': removeRemote(m.id); break;
      case 'sound': handleSoundEvent(m); break;
      case 'containerOpened':
        // E043：容器内容回传（服务器权威）→ 渲染容器格子
        if (m.id === myId) {
          const from = lootFrom, wantOpen = !!pendingLootOpen;
          pendingLootOpen = null;
          ensureRaidInvSession(); // 同单机：会话判定必须先于 lootOpen 赋值
          const now = Date.now();
          for (const e of m.loot) lootFlash[e.uid] = now + 8000;
          lootOpen = { containerId: m.containerId, loot: m.loot };
          lootLayout = null;
          lootFrom = from;
          if (dom.lootPane) dom.lootPane.style.display = 'block';
          if (wantOpen) openBackpack(from);
          renderLootGrid();
        }
        break;
      case 'containerLootChanged':
        // E043：容器剩余同步（任何人拿取后广播；未打开该容器则忽略）
        if (lootOpen && lootOpen.containerId === m.containerId) { lootOpen.loot = m.loot; renderLootGrid(); }
        break;
      case 'containerLooted': {
        // E022：搜刮结果（服务器权威）——标记容器 + 更新世界副本 + 提示
        markContainerLooted(m.containerId);
        const c = remoteContainers.find(x => x.id === m.containerId);
        if (c) c.looted = true;
        const names = (m.picked || []).map(i => ITEMS.LOOT[i.itemId] ? ITEMS.LOOT[i.itemId].name : i.itemId);
        if (m.id === myId) {
          if (names.length) toast('拾取：' + names.join('、'));
          else toast('容器已搜刮完');
          if (lootOpen && lootOpen.containerId === m.containerId) { hideLootPane(); renderRaidGrid(); break; } // E043：拿空收容器栏
        }
        if (paused) renderInventory();
        break;
      }
      case 'invChanged':
        if (m.id === myId) { remoteInventory = m.items || []; if (paused) renderInventory(); }
        break;
      case 'equipped': toast(`装备了 ${m.weaponName}`); if (paused) renderInventory(); break;
      case 'usedItem': if (m.id === myId && paused) renderInventory(); break;
      case 'extractStart': showExtractHUD(m); break;
      case 'extractProgress': updateExtractHUD(m); break;
      case 'extractSuccess':
        hideExtractHUD();
        raidOutcome = { extracted: true, weaponIdx: -1, inventory: [] }; // 联机：结算由服务器落档，客户端仅展示
        showSummary('success');
        break;
      case 'extractCancel': hideExtractHUD(); break;
      case 'ammo':
        // 联机弹药消耗（服务器权威）→ 同步本地 HUD，不再卡旧数字
        if (raidWeapon && raidWeapon.ammo) { raidWeapon.ammo.count = m.count; raidWeapon.ammo.reserve = m.reserve || 0; }
        updateAmmoHUD(raidWeapon);
        break;
      case 'ammoRefilled':
        // E020：服务器弹药库对象同步（reserve 现为 ammoLib）
        if (m.reserve && typeof m.reserve === 'object') localAmmoLib = { ...m.reserve };
        updateAmmoHUD(raidWeapon);
        toast(`弹药已放入背包`);
        break;
      case 'empty': toast('弹匣空了！按 R 换弹'); break;
      case 'reloadStart': reloading = true; dipGun(true); break;
      case 'reloadDone':
        // 用服务器事件数据同步本地副本（count/reserve）
        reloading = false; dipGun(false);
        if (raidWeapon && raidWeapon.ammo) { raidWeapon.ammo.count = m.count; raidWeapon.ammo.reserve = m.reserve || 0; }
        updateAmmoHUD(raidWeapon);
        break;
      case 'hit': handleHitEvent(m); updatePlayerList(); break;
      case 'scavDead': handleScavDead(m); break;
      case 'respawn': break;
    }
  };
  // E021：输入发送与本地预测绑定在同一个 60Hz 步进里（onlineStep），不再独立 setInterval
  pendingInputs.length = 0;
  onlineAcc = 0;
}
// 生成一个输入（同一对象同时用于：发送 / 本地预测 / 待确认队列——三者 seq 必须一致）
function buildInput(forceJump) {
  return {
    seq: ++seq,
    keys: { f: keys.f ? 1 : 0, b: keys.b ? 1 : 0, l: keys.l ? 1 : 0, r: keys.r ? 1 : 0 },
    jump: !!forceJump,
    yaw: local.yaw + recoilYaw,
    pitch: local.pitch + recoilPitch,
    fire: firing && local.alive // 开火权由服务器判定（冷却+弹药），客户端只上报意图
  };
}
function sendInputObject(input) {
  if (!ws || ws.readyState !== 1 || !myId) return;
  ws.send(JSON.stringify({ type: 'input', ...input }));
}
// E021：联机 60Hz 步进 = 生成输入 → 立即预测一步 → 发送 → 入待确认队列
function onlineStep(dt) {
  if (!connected) return;
  onlineAcc += dt;
  let guard = 0;
  while (onlineAcc >= 1 / 60 && guard < 4) {
    onlineAcc -= 1 / 60;
    guard++;
    if (!local.alive) continue;
    const input = buildInput(jumpPending);
    jumpPending = false;
    PREDICT.step(local, input, 1 / 60);       // 本地立即预测（零延迟手感）
    PREDICT.push(pendingInputs, input);       // 等待服务器确认
    sendInputObject(input);
  }
}
function applySnapshot(m) {
  if (!myId) return;
  for (const p of m.players) {
    if (p.id === myId) {
      local.hp = p.hp;
      // E020：同步服务器弹药库（联机 HUD 备弹显示）
      if (p.ammoLib) localAmmoLib = { ...p.ammoLib };
      if (local.alive && !p.alive) { local.alive = false; dead = true; bigMsg('你被击倒了', ''); }
      if (!local.alive && p.alive) { local.alive = true; dead = false; bigMsg('', ''); }
      if (!dead) setHp(local.hp);
      if (local.alive && p.alive && PREDICT) {
        // E021：回滚到服务器权威 + 重放未确认输入（根治闪回；不再用 EMA 掩盖/阈值瞬移）
        const r = PREDICT.reconcile(
          local,
          { x: p.x, y: p.y, z: p.z, vy: p.vy || 0, lastSeq: p.lastSeq || 0 },
          pendingInputs,
          1 / 60
        );
        // 诊断指标（验收用）：和解修正距离应保持在 1-2 帧位移量级
        if (r.correction > (window.__maxCorrection || 0)) window.__maxCorrection = r.correction;
        window.__lastReconcile = r;
      } else {
        // 死亡/重生：直接对齐并清空待确认输入
        local.x = p.x; local.y = p.y; local.z = p.z; local.vy = 0;
        pendingInputs.length = 0;
      }
    } else {
      upsertRemote(p);
    }
  }
  updatePlayerList();
  syncScavs(m.scavs, false); // M2：联机 SCAV 服务器权威同步
}

// ================= 单机模式（本地 GameSim，零网络） =================
// ---------- 整备界面（M1a：仓库取装 → 配弹 → 进图） ----------
// 选中态守卫：保证 selectedIdx 始终指向仓库中的有效武器
// （修复 2026-09-19 缺陷：结算/出售后仓库结构变化 → 下标悬空 → 界面误报「无武器可选」；判定逻辑见 shared/items.js pickWeaponIndex）
function ensureValidSelection() {
  // P2：改为 uid 锚定 —— 先选出战武器 uid，再派生 legacy 下标（既有 join.stashIndex 与
  // computeRaidOutcome(..., selectedIdx, ...) 语义不变；裸下标悬空的根因由此消除）
  if (!profile) { selectedUid = null; selectedIdx = -1; return; }
  if (selectedUid && !LOADOUT.isWeaponUid(profile, selectedUid)) selectedUid = null;
  selectedUid = LOADOUT.findWeaponUid(profile, selectedUid);
  selectedIdx = LOADOUT.indexByUid(profile, selectedUid);
  profile.selectedUid = selectedUid || null; // P2：选择随档案落盘（刷新后仍指向同一把枪）
}
function showLobby() {
  if (!CORE || !SIM || !ITEMS || !STORAGE) {
    const miss = [];
    if (!CORE) miss.push('core.js');
    if (!SIM) miss.push('sim.js');
    if (!ITEMS) miss.push('items.js');
    if (!STORAGE) miss.push('storage.js');
    bigMsg('核心模块加载失败', `缺失: ${miss.join(', ')} —— 请按 Ctrl+F5 强制刷新`);
    return;
  }
  mode = 'solo';
  profile = STORAGE.get('profile') || ITEMS.defaultProfile(myName);
  profile = LOADOUT.ensure(profile); // P2：旧档案迁移（补 grid/equipment 骨架）并与 stash 对齐
  STORAGE.set('profile', profile);
  selectedUid = LOADOUT.findWeaponUid(profile, profile.selectedUid || selectedUid); // P2：恢复上次出战武器
  myName = profile.name;
  renderLobby(); // 选中态由 renderLobby 内的 ensureValidSelection 统一守卫
}
// 保底可开火：仓库无武器 → 补满弹 PM；有武器但弹药 0 → 补满弹匣（与联机 data.js 同一函数）
function ensureBackupWeapon() {
  const changed = ITEMS.ensureLoadable(profile);
  if (changed) {
    profile = LOADOUT.syncProfile(profile).profile; // P2：补发的武器（无 uid）落入格子
    STORAGE.set('profile', profile);
  }
  return changed;
}
function renderLobby() {
  const lobby = dom.lobby;
  lobby.style.display = 'flex';
  const isOnline = mode === 'online';
  if (!profile) profile = ITEMS.defaultProfile(myName);
  profile = LOADOUT.ensure(profile); // P2：骨架与一致性保障（幂等）
  // E039：SCAV 现已支持单机（本地随机装备：不消耗仓库 / 撤离归仓 / 阵亡无损失）→ 按钮两种模式均可点，
  // 文案不再区分模式。（旧实现自 2026-09-19 起在单机置灰并标注「联机可用」，随单机能力上线而废弃）
  if (dom.lobbyEnterScav) {
    dom.lobbyEnterScav.textContent = '以 SCAV 身份进入（随机装备 · 撤离归仓）';
    dom.lobbyEnterScav.disabled = false;
  }
  // 破产保底：仅单机（联机由服务器 data.js 的 ensureLoadable 兜底）
  if (!isOnline && ensureBackupWeapon()) toast('仓库无武器，已免费补给一把 PM 马卡洛夫');
  // P2：出战武器 = uid 锚定（装备槽优先）；selectedIdx 由它派生
  ensureValidSelection();
  dom.money.textContent = profile.money;
  // 2026-09-26 弹药实体化：此处为「仓库弹药堆叠合计」（profile.ammoLib 已是派生视图）
  const ammoLibEl = dom.ammoLib;
  if (ammoLibEl) {
    const lib = profile.ammoLib || {};
    const parts = Object.keys(lib).map(aid => {
      const nm = (ITEMS.AMMO && ITEMS.AMMO[aid] && ITEMS.AMMO[aid].name) || aid;
      return `${nm}×${lib[aid]}`;
    });
    ammoLibEl.textContent = parts.length ? parts.join(' · ') : '空';
    ammoLibEl.title = '仓库弹药堆叠合计（弹药已实体化：占用仓库格与重量）';
  }
  renderStashGrid();   // P2：仓库格子（10×30，拖拽整理）
  renderEquipSlots();  // P2：装备槽（7 槽）
  renderCarryArea();   // 任务 B · B3：携带空间（胸挂 / 背包容器格）
  if (!isOnline) renderCarrySection(); // M4：携带设置（单机；联机待接入）
  renderTrader(); // E030：联机也显示商人/出售（点击发 trade 指令，服务器权威）
  renderWeaponDetail();
}
// ---------- P2：配装格子（塔克夫式拖拽；D4 = 自写 pointer 事件，支持触屏 + 拖动中旋转） ----------
let gridCell = 30;      // 单元格像素边长（每次渲染按容器宽度计算）
let gridBound = false;  // 事件只绑一次
function loadoutEditable() { return mode === 'solo'; } // 联机格子编辑需服务器存 loadout（P3）
function itemLabel(itemId) {
  const d = ITEMS.LOOT[itemId] || ITEMS.WEAPONS[itemId] || ITEMS.MODS[itemId] || null;
  return d ? d.name : itemId;
}
// 单元格尺寸（BUG-A 修复：点击格子导致格子区域逐次放大）
//
// 事故机制（自激正反馈）：
//   1. 玩家点击格子 → _selectByUid → renderLobby → renderStashGrid → gridMetrics
//   2. 旧实现读 host.parentElement.clientWidth（即 .col-grid 的 clientWidth）作为基准
//   3. .col-grid 是 flex 项且未设 min-width，计算值 auto → 无法收缩到低于内容宽度
//   4. 一旦某轮算出的 cell 使「10×cell + 内边距」超过 386px，.col-grid 被内容撑大
//   5. 下一轮 gridMetrics 读到**已被撑大**的宽度 → cell 再 +1 → 再撑大 → 无限叠加
//   实测：每点一次 cell +1px、.col-grid +10px。
//
// 修复：基准宽度改用**固定值**（CSS 里的 flex-basis 386px），不再读取运行时布局。
// 同时给 .col-grid 加 min-width:0（见 index.html）作为第二道闸门，防止内容反向撑大。
// 这样任何次渲染算出的 cell 恒定，回路被切断。
var GRID_BASE_W = 386; // 与 index.html 中 #lobby .col-grid 的 flex-basis 保持一致
function gridMetrics() {
  const cols = (profile && profile.grid ? profile.grid.w : 10) || 10;
  const cell = Math.max(16, Math.floor(Math.max(120, GRID_BASE_W - 26) / cols));
  return { cell: cell, cols: cols, rows: (profile && profile.grid ? profile.grid.h : 30) || 30 };
}
// ---------- P4：物品名称渲染（整备与局内共用）----------
// 修复「名称显示不好」的根因：旧实现有 tiny 分支，1 格宽 / 1×1 的物品（多数战利品）
// 只画一个「枪」或纯数量。现改为**自适应字号 + 自动换行**，名称永不缺席。
function _textWidth(str, fs) {
  let w = 0;
  const t = String(str == null ? '' : str);
  for (let i = 0; i < t.length; i++) w += (t.charCodeAt(i) > 0x2E80) ? fs : fs * 0.56; // 中文 1em / 西文 0.56em
  return w;
}
function _labelPlan(text, bw, bh) {
  const avail = Math.max(10, bw - 6);
  const maxFs = Math.max(8, Math.min(13, Math.floor(bh * 0.62)));
  for (let fs = maxFs; fs >= 8; fs--) if (_textWidth(text, fs) <= avail) return { fs: fs, lines: 1 };
  for (let lines = 2; lines <= 4; lines++) {
    const fs = 9;
    if (_textWidth(text, fs) / lines <= avail && lines * fs * 1.15 <= bh) return { fs: fs, lines: lines };
  }
  return { fs: 8, lines: Math.max(1, Math.min(4, Math.floor(bh / 9.2))) };
}
function paintItemEl(el, e, cell, opts) {
  const o = opts || {};
  const fp = GRIDUI.footprint(e.itemId, e.rot);
  const bw = fp[0] * cell - 2, bh = fp[1] * cell - 2;
  const name = itemLabel(e.itemId);
  const cnt = (e.count || 1) > 1 ? ('\u00d7' + e.count) : '';
  const plan = _labelPlan(name + (cnt ? ' ' + cnt : ''), bw, bh);
  const sub = e.ammo ? ('弹 ' + e.ammo.count) : ((e.mods && e.mods.sight) ? '瞄具' : '');
  const showSub = !!sub && plan.lines === 1 && bh >= 34;
  el.innerHTML = '<span class="gn" style="font-size:' + plan.fs + 'px;-webkit-line-clamp:' + plan.lines + '">' + name
    + (cnt ? '<span class="ct">' + cnt + '</span>' : '') + '</span>'
    + (showSub ? '<span class="gd" style="font-size:9px">' + sub + '</span>' : '');
  el.title = name + (cnt ? ' ' + cnt : '') + (sub ? ' \u00b7 ' + sub : '') + (o.tip ? (' \u00b7 ' + o.tip) : '');
}
function renderStashGrid() {
  const host = dom.stashGrid; if (!host) return;
  const g = profile.grid || { w: 10, h: 30, items: [] };
  const m = gridMetrics(); gridCell = m.cell;
  let bg = host.querySelector('.gridbg');
  if (!bg) { bg = document.createElement('div'); bg.className = 'gridbg'; host.appendChild(bg); }
  bg.style.gridTemplateColumns = 'repeat(' + m.cols + ', ' + m.cell + 'px)';
  bg.style.gridAutoRows = m.cell + 'px';
  bg.style.height = (m.cell * m.rows) + 'px';
  const total = m.cols * m.rows;
  const arr = new Array(total);
  for (let i = 0; i < total; i++) arr[i] = '<div class="cell"></div>';
  bg.innerHTML = arr.join('');
  for (const el of Array.prototype.slice.call(host.querySelectorAll('.gitem, .dropll'))) el.remove();
  const frag = document.createDocumentFragment();
  for (const e of g.items) {
    const fp = GRIDUI.footprint(e.itemId, e.rot);
    const isW = GRIDUI.isWeaponId(e.itemId);
    const el = document.createElement('div');
    el.className = 'gitem' + (isW ? ' w' : '') + (e.uid === selectedUid ? ' sel' : '') + (e.uid === focusUid ? ' foc' : '');
    el.setAttribute('data-uid', e.uid);
    el.style.left = (e.x * gridCell) + 'px';
    el.style.top = (e.y * gridCell) + 'px';
    el.style.width = (fp[0] * gridCell - 2) + 'px';
    el.style.height = (fp[1] * gridCell - 2) + 'px';
    paintItemEl(el, e, gridCell); // P4：自适应字号 + 多行，名称不再被 tiny 分支吞掉
    frag.appendChild(el);
  }
  host.appendChild(frag);
  const capEl = dom.gridCap;
  if (capEl) capEl.textContent = ' ' + GRIDUI.usedCells(g) + '/' + GRIDUI.totalCells(g) + ' 格';
  const hintEl = dom.gridHint;
  if (hintEl) hintEl.textContent = loadoutEditable()
    ? '拖动整理 · 拖动中按 R 旋转 · 拖到左侧槽位装备 · 单击武器设为出战'
    : '联机整备：单击格子里的武器可设为出战（格子编辑将在下一批开放）';
  bindGridEvents();
}
// ---------- 任务 B · B3：携带空间（胸挂 / 背包）渲染 ----------
// 与仓库格共用 .gitem / data-uid / data-surface 约定，事件走同一套 onPointerDown。
// 差异：cell 尺寸独立（容器通常更窄更小）；空容器显示占位提示；未装备 → 提示先装备。
var rigCell = 30, backpackCell = 30;   // 容器格像素（各自计算）
function _containerOfSlot(slot) {
  if (!CONTAINERS) return null;
  return CONTAINERS.containerOf(profile, slot);
}
function renderContainerGrid(slot) {
  const host = (slot === 'rig') ? dom.rigGrid : dom.backpackGrid;
  if (!host) return;
  const g = _containerOfSlot(slot);
  // 未装备 / 无空间 → 占位
  if (!g) {
    host.classList.add('empty');
    host.innerHTML = (slot === 'rig') ? '未装备胸挂' : '未装备背包';
    return;
  }
  host.classList.remove('empty');
  const cell = Math.max(20, Math.min(34, Math.floor(Math.max(80, host.clientWidth - 26) / Math.max(1, g.w))));
  if (slot === 'rig') rigCell = cell; else backpackCell = cell;
  let bg = host.querySelector('.gridbg');
  if (!bg) { bg = document.createElement('div'); bg.className = 'gridbg'; host.appendChild(bg); }
  bg.style.gridTemplateColumns = 'repeat(' + g.w + ', ' + cell + 'px)';
  bg.style.gridAutoRows = cell + 'px';
  bg.style.height = (cell * g.h) + 'px';
  const total = g.w * g.h;
  const arr = new Array(total);
  for (let i = 0; i < total; i++) arr[i] = '<div class="cell"></div>';
  bg.innerHTML = arr.join('');
  for (const el of Array.prototype.slice.call(host.querySelectorAll('.gitem, .dropll'))) el.remove();
  const frag = document.createDocumentFragment();
  for (const e of g.items) {
    const fp = GRIDUI.footprint(e.itemId, e.rot);
    const el = document.createElement('div');
    el.className = 'gitem' + (GRIDUI.isWeaponId(e.itemId) ? ' w' : '') + (e.uid === focusUid ? ' foc' : '');
    el.setAttribute('data-uid', e.uid);
    el.style.left = (e.x * cell) + 'px';
    el.style.top = (e.y * cell) + 'px';
    el.style.width = (fp[0] * cell - 2) + 'px';
    el.style.height = (fp[1] * cell - 2) + 'px';
    paintItemEl(el, e, cell, { tip: slot === 'rig' ? '胸挂 · 可快捷使用' : '背包' });
    frag.appendChild(el);
  }
  host.appendChild(frag);
}
function renderCarryArea() {
  renderContainerGrid('rig');
  renderContainerGrid('backpack');
  if (dom.carryCap) {
    const rs = _containerOfSlot('rig'), bs = _containerOfSlot('backpack');
    const fmt = function (c) { return c ? (GRIDUI.usedCells(c) + '/' + GRIDUI.totalCells(c)) : '—'; };
    dom.carryCap.textContent = ' 胸挂 ' + fmt(rs) + ' · 背包 ' + fmt(bs) + ' 格';
  }
  if (dom.carryHint) {
    dom.carryHint.textContent = loadoutEditable()
      ? '拖入物品即可携带 · 胸挂内物品可快捷使用（背包内不可） · 拖动中按 R 旋转'
      : '联机整备：携带空间编辑将在下一批开放';
  }
}
function renderEquipSlots() {
  const host = dom.equipslots; if (!host) return;
  const eq = profile.equipment || {};
  host.innerHTML = LOADOUT.slotOrder().map(function (slot) {
    const e = eq[slot];
    const sub = (e && e.ammo) ? ('弹 ' + e.ammo.count) : '';
    return '<div class="eslot' + (e ? ' filled' : '') + '" data-slot="' + slot + '"' + (e ? ' data-uid="' + e.uid + '"' : '') + '>'
      + '<div class="sl">' + (GRID_SLOT_LABEL[slot] || slot) + '</div>'
      + '<div class="sv">' + (e ? itemLabel(e.itemId) : '—') + '</div>'
      + (sub ? '<div class="sl">' + sub + '</div>' : '') + '</div>';
  }).join('');
  bindGridEvents();
}
// —— 拖拽（自写 pointer 事件；P4 起泛化为「表面 surface」：整备 loadout / 局内 raid）——
// 两个网格共用同一套指针逻辑，避免两套实现漂移（E034 教训：禁止重复实现）
const SURFACES = {
  loadout: {
    host: () => dom.stashGrid,
    grid: () => profile.grid,
    cell: () => gridCell,
    editable: () => loadoutEditable(),
    slotsHost: () => dom.equipslots,
    commit: (uid, target, rot) => {
      let r = null;
      if (target.type === 'slot') r = LOADOUT.equipUid(profile, uid, target.slot);
      else if (target.type === 'grid') r = LOADOUT.moveUid(profile, uid, target.x, target.y, rot);
      if (r && r.ok) { profile = r.profile; STORAGE.set('profile', profile); ensureValidSelection(); }
      return r;
    },
    after: () => renderLobby()
  },
  raid: {
    host: () => dom.invGrid,
    grid: () => raidLayout,
    cell: () => raidCell,
    editable: () => true,          // 局内只改视图布局，不落盘、不动 sim
    slotsHost: () => null,
    commit: (uid, target, rot) => {
      if (!raidLayout || !target || target.type !== 'grid') return null;
      const r = RAIDINV.move(raidLayout, uid, target.x, target.y, rot);
      if (r && r.ok) raidLayout = r.grid;
      return r;
    },
    after: () => renderRaidGrid()
  },
  loot: {
    // E043：容器格子（source surface）—— 单击/拖出 = 拿取；容器内移动无意义（拿走即移除）
    host: () => dom.lootGrid,
    grid: () => lootLayout,
    cell: () => lootCell,
    editable: () => true,
    slotsHost: () => null,
    commit: () => null,              // 容器内不做移动（拿取走 tap / cross）
    tap: (uid) => takeFromContainer(uid),
    after: () => renderLootGrid()
  },
  // 任务 B · B3：携带空间（胸挂 / 背包）—— 两个独立表面，共用容器逻辑
  rig: _containerSurface('rig'),
  backpack: _containerSurface('backpack')
};

// 携带空间表面工厂（rig / backpack 结构相同，仅槽位不同；避免重复实现 → E034 教训）
function _containerSurface(slot) {
  return {
    host: () => (slot === 'rig' ? dom.rigGrid : dom.backpackGrid),
    grid: () => _containerOfSlot(slot),
    cell: () => (slot === 'rig' ? rigCell : backpackCell),
    editable: () => loadoutEditable(),
    slotsHost: () => null,
    commit: (uid, target, rot) => {
      if (!target || target.type !== 'grid' || !CONTAINERS) return null;
      const r = CONTAINERS.moveIn(profile, slot, uid, target.x, target.y, rot);
      if (r && r.ok) { profile = { ...profile, containers: r.containers }; STORAGE.set('profile', profile); }
      return r;
    },
    after: () => renderLobby()
  };
}
function _surfaceOf(el) {
  const host = (el && el.closest) ? el.closest('[data-surface]') : null;
  const key = host ? host.getAttribute('data-surface') : null;
  return (key && SURFACES[key]) ? { key: key, def: SURFACES[key] } : null;
}
function _srcEntry(surfaceKey, uid) {
  if (!uid) return null;
  if (surfaceKey === 'raid') {
    if (!raidLayout) return null;
    const e = GRIDUI.findByUid(raidLayout, uid);
    return e ? { where: 'grid', entry: e } : null;
  }
  if (surfaceKey === 'loot') {
    // E043：容器 surface —— 从容器视图网格取条目（缺此分支会落到 loadout 逻辑找 profile.grid → 永远 null）
    if (!lootLayout) return null;
    const e = GRIDUI.findByUid(lootLayout, uid);
    return e ? { where: 'grid', entry: e } : null;
  }
  if (surfaceKey === 'rig' || surfaceKey === 'backpack') {
    // 任务 B：携带空间 —— 从 profile.containers[slot] 取条目
    const g = _containerOfSlot(surfaceKey);
    if (!g) return null;
    const e = GRIDUI.findByUid(g, uid);
    return e ? { where: 'grid', entry: e } : null;
  }
  if (!profile || !profile.grid) return null;
  const inGrid = GRIDUI.findByUid(profile.grid, uid);
  if (inGrid) return { where: 'grid', entry: inGrid };
  for (const slot of LOADOUT.slotOrder()) {
    const e = profile.equipment && profile.equipment[slot];
    if (e && e.uid === uid) return { where: 'slot', slot: slot, entry: e };
  }
  return null;
}
function _hlEl(surfaceKey) {
  const def = SURFACES[surfaceKey]; if (!def) return null;
  const host = def.host(); if (!host) return null;
  let hl = host.querySelector('.dropll');
  if (!hl) { hl = document.createElement('div'); hl.className = 'dropll'; host.appendChild(hl); }
  return hl;
}
function _clearHl(surfaceKey) {
  const def = surfaceKey ? SURFACES[surfaceKey] : null;
  const hosts = def ? [def.host()] : [dom.stashGrid, dom.invGrid, dom.rigGrid, dom.backpackGrid];
  for (const h of hosts) { if (!h) continue; const hl = h.querySelector('.dropll'); if (hl) hl.style.display = 'none'; }
  if (dom.equipslots) for (const el of Array.prototype.slice.call(dom.equipslots.querySelectorAll('.hl, .bad'))) el.classList.remove('hl', 'bad');
  if (dom.invGrid) dom.invGrid.classList.remove('dropok'); // E043：跨拖高亮一并清
  // 任务 B：携带空间跨拖高亮一并清
  if (dom.rigGrid) dom.rigGrid.classList.remove('dropok');
  if (dom.backpackGrid) dom.backpackGrid.classList.remove('dropok');
}
function _sizeGhost() {
  const st = dragState; if (!st) return;
  const fp = GRIDUI.footprint(st.itemId, st.rot);
  st.ghost.style.width = (fp[0] * st.cell - 2) + 'px';
  st.ghost.style.height = (fp[1] * st.cell - 2) + 'px';
}
function onPointerDown(ev) {
  if (dragState) return;
  const el = (ev.target && ev.target.closest) ? ev.target.closest('[data-uid]') : null;
  if (!el) return;
  const surf = _surfaceOf(el);
  if (!surf) return;
  const def = surf.def;
  const grid = def.grid();
  if (!grid) return;
  const uid = el.getAttribute('data-uid');
  const src = _srcEntry(surf.key, uid);
  if (!src) return;
  focusUid = uid;
  if (!def.editable()) { requestAnimationFrame(function () { _selectByUid(surf.key, uid); }); return; }
  const cell = def.cell();
  const fp = GRIDUI.footprint(src.entry.itemId, src.entry.rot);
  const rect = el.getBoundingClientRect();
  const isGrid = src.where === 'grid';
  const ghost = document.createElement('div');
  ghost.className = 'gitem ghost' + (GRIDUI.isWeaponId(src.entry.itemId) ? ' w' : '');
  paintItemEl(ghost, src.entry, cell);
  document.body.appendChild(ghost);
  dragState = {
    surface: surf.key, cell: cell, uid: uid, itemId: src.entry.itemId, rot: src.entry.rot, where: src.where,
    grabDX: isGrid ? (ev.clientX - rect.left) : fp[0] * cell / 2,
    grabDY: isGrid ? (ev.clientY - rect.top) : fp[1] * cell / 2,
    ghost: ghost, srcEl: el, moved: false, target: null,
    startX: ev.clientX, startY: ev.clientY, px: ev.clientX, py: ev.clientY
  };
  _sizeGhost();
  ghost.style.left = (ev.clientX - dragState.grabDX) + 'px';
  ghost.style.top = (ev.clientY - dragState.grabDY) + 'px';
  el.classList.add('dragging');
  if (ev.cancelable) ev.preventDefault();
}
function onPointerMove(ev) {
  const st = dragState; if (!st) return;
  st.px = ev.clientX; st.py = ev.clientY;
  if (ev.cancelable) ev.preventDefault();
  st.ghost.style.left = (ev.clientX - st.grabDX) + 'px';
  st.ghost.style.top = (ev.clientY - st.grabDY) + 'px';
  if (!st.moved && Math.abs(ev.clientX - st.startX) + Math.abs(ev.clientY - st.startY) > 5) st.moved = true;
  if (!st.moved) return;
  _updateDropTarget();
}
function _updateDropTarget() {
  const st = dragState; if (!st) return;
  const def = SURFACES[st.surface]; if (!def) return;
  const grid = def.grid(); if (!grid) return;
  const cell = st.cell;
  const fp = GRIDUI.footprint(st.itemId, st.rot);
  const cx = st.px - st.grabDX + fp[0] * cell / 2;
  const cy = st.py - st.grabDY + fp[1] * cell / 2;
  _clearHl(st.surface);
  // 任务 B · B3：整备区跨区拖拽（仓库 ↔ 胸挂 ↔ 背包）
  // 源 surface → 允许拖入的目标（host 由 SURFACES[key].host() 取）
  const CROSS = {
    loadout: ['rig', 'backpack'],
    rig: ['loadout', 'backpack'],
    backpack: ['loadout', 'rig']
  };
  const crossKeys = CROSS[st.surface];
  if (crossKeys) {
    for (const key of crossKeys) {
      const tdef = SURFACES[key]; if (!tdef) continue;
      const th = tdef.host(); if (!th) continue;
      if (th.classList.contains('empty')) { th.classList.remove('dropok'); continue; }  // 未装备 → 不可放
      const tr = th.getBoundingClientRect();
      const inside = st.px >= tr.left - 8 && st.px <= tr.right + 8 && st.py >= tr.top - 8 && st.py <= tr.bottom + 8;
      th.classList.toggle('dropok', inside);
      if (inside) { st.target = { type: 'cross', to: key }; return; }
    }
  }
  // E043：跨 surface —— 容器物品拖入背包区 = 拿取（自动放置，忽略落点格）
  if (st.surface === 'loot' && dom.invGrid) {
    const ir = dom.invGrid.getBoundingClientRect();
    const inside = st.px >= ir.left - 8 && st.px <= ir.right + 8 && st.py >= ir.top - 8 && st.py <= ir.bottom + 8;
    if (dom.invGrid) dom.invGrid.classList.toggle('dropok', inside);
    if (inside) { st.target = { type: 'cross', to: 'raid' }; return; }
  }
  const slotsHost = def.slotsHost();
  if (slotsHost && typeof document.elementFromPoint === 'function') {
    const hit = document.elementFromPoint(cx, cy);
    const slotEl = (hit && hit.closest) ? hit.closest('[data-slot]') : null;
    if (slotEl) {
      const slot = slotEl.getAttribute('data-slot');
      const ok = GRIDUI.slotsFor(st.itemId).indexOf(slot) >= 0;
      slotEl.classList.add(ok ? 'hl' : 'bad');
      st.target = ok ? { type: 'slot', slot: slot } : null;
      return;
    }
  }
  const host = def.host(); if (!host) { st.target = null; return; }
  const hr = host.getBoundingClientRect();
  if (st.px < hr.left - cell || st.px > hr.right + cell || st.py < hr.top - cell || st.py > hr.bottom + cell) { st.target = null; return; }
  let gx = Math.round((st.px - st.grabDX - hr.left + host.scrollLeft) / cell);
  let gy = Math.round((st.py - st.grabDY - hr.top + host.scrollTop) / cell);
  gx = Math.max(0, Math.min(grid.w - fp[0], gx));
  gy = Math.max(0, Math.min(grid.h - fp[1], gy));
  const ok = GRIDUI.canPlace(grid, { itemId: st.itemId, rot: st.rot, uid: st.uid }, gx, gy, { skipUid: st.uid });
  st.target = ok ? { type: 'grid', x: gx, y: gy } : null;
  const hl = _hlEl(st.surface);
  if (hl) {
    hl.style.display = 'block';
    hl.className = 'dropll' + (ok ? '' : ' bad');
    hl.style.left = (gx * cell) + 'px';
    hl.style.top = (gy * cell) + 'px';
    hl.style.width = (fp[0] * cell) + 'px';
    hl.style.height = (fp[1] * cell) + 'px';
  }
}
function onPointerUp() {
  const st = dragState; if (!st) return;
  const def = SURFACES[st.surface];
  const moved = st.moved, target = st.target, surface = st.surface, uid = st.uid, rot = st.rot;
  _clearHl(surface);
  if (st.srcEl) st.srcEl.classList.remove('dragging');
  if (st.ghost && st.ghost.parentNode) st.ghost.parentNode.removeChild(st.ghost);
  dragState = null;
  if (!moved || !def) {
    // E043：容器物品单击 = 拿取（塔科夫式；拖拽走 moved 分支的 cross）
    if (def && surface === 'loot') { def.tap(uid); return; }
    // 局内背包：双击旋转。不用 DOM dblclick —— pointerdown 上的 preventDefault 会按规范
    // 连带压掉兼容鼠标事件（mousedown/click/dblclick），故在此自行识别「同 uid 快速二次点击」
    if (def && surface === 'raid') {
      const now = Date.now();
      if (raidLastTap.uid === uid && (now - raidLastTap.t) < 420) {
        raidLastTap = { uid: null, t: 0 };
        const rr = RAIDINV.rotate(raidLayout, uid);
        if (rr && rr.ok) raidLayout = rr.grid; else toast('没有空间旋转（先挪出空位）');
        renderRaidGrid();
        return;
      }
      raidLastTap = { uid: uid, t: now };
    }
    _selectByUid(surface, uid);
    return;
  }
  if (!target) { def.after(); return; }
  // 跨 surface 分派
  if (target.type === 'cross') {
    // E043：容器 → 局内背包 = 拿取
    if (target.to === 'raid') { takeFromContainer(uid); def.after(); return; }
    // 任务 B · B3：整备区跨区（仓库 ↔ 胸挂 ↔ 背包）
    _doCrossTransfer(surface, target.to, uid);
    return;
  }
  const r = def.commit(uid, target, rot);
  if (r && !r.ok) toast(r.reason === 'no-space' ? '没有足够空间' : '该位置放不下');
  def.after();
}

// 任务 B · B3：整备区跨区转移分派（源 surface → 目标 surface）
// 语义：容器→仓库 / 仓库→容器 / 容器↔容器；失败时提示且**物品留在原处**（纯函数保证）
function _doCrossTransfer(fromKey, toKey, uid) {
  if (!CONTAINERS) return;
  let r = null;
  if (fromKey === 'loadout' && (toKey === 'rig' || toKey === 'backpack')) {
    r = CONTAINERS.transferFromGrid(profile, uid, toKey);
  } else if ((fromKey === 'rig' || fromKey === 'backpack') && toKey === 'loadout') {
    r = CONTAINERS.transferToGrid(profile, fromKey, uid);
  } else if ((fromKey === 'rig' || fromKey === 'backpack') && (toKey === 'rig' || toKey === 'backpack')) {
    r = CONTAINERS.transferBetween(profile, fromKey, uid, toKey);
  }
  if (r && r.ok && r.profile) {
    // ⚠️ 铁律（B3 实机踩坑，勿回退）：Containers.transfer* 只返回「新 grid + 新 containers」，
    // 其 **stash 仍是旧的一份**（还写着「物品在仓库」）。若直接把它交给 renderLobby →
    // LOADOUT.ensure → syncProfile，后者会**以旧 stash 为准**逐条认领 grid：被移走的那条
    // uid 已不在 grid 里 → 落入分支③「新物品 → 入格」→ **物品被复制回仓库**。
    // 症状：绷带/弹药同时在仓库与胸挂（两个不同 uid，数量翻倍）。
    // 正解：先用**新 grid**把 stash 重新派生一遍，再交给 syncProfile（此时它认领的
    // 就是新 stash，不会凭空补条目）。
    const rp = { ...r.profile };
    rp.stash = LOADOUT.legacyStash(rp);
    // ⚠️ 同样必须**成对重派生** ammoLib（不变量：ammoLib 是 stash 的派生视图）。
    // 若只重派生 stash 而留下旧 ammoLib，syncProfile 第⑦步 ammoLibToGrid 会发现
    // 「ammoLib 记着 60 发、仓库实体 0 发」→ 把差额补成实体堆叠 → 弹药被复制回仓库。
    rp.ammoLib = (ITEMS.ammoLibOf ? ITEMS.ammoLibOf(rp) : rp.ammoLib) || {};
    profile = LOADOUT.syncProfile(rp).profile;
    STORAGE.set('profile', profile);
    ensureValidSelection();
    if (fromKey === 'loadout' || toKey === 'loadout') renderStashGrid();
  } else if (r && !r.ok) {
    toast(r.reason === 'no-space' ? '没有足够空间' : (r.reason === 'no-container' ? '先装备胸挂/背包' : '该位置放不下'));
  }
  renderLobby();
}
function _selectByUid(surfaceKey, uid) {
  if (surfaceKey === 'raid') {
    raidSelUid = uid;
    const src = invSource();
    if (src) {
      const idx = RAIDINV.indexByUid(src.items);
      const i = idx[uid];
      if (i !== undefined) toast(itemLabel(src.items[i].itemId));
    }
    renderRaidGrid();
    return;
  }
  if (LOADOUT.isWeaponUid(profile, uid)) {
    selectedUid = uid; ensureValidSelection();
    STORAGE.set('profile', profile);
    const s = profile.stash[selectedIdx];
    toast('出战武器：' + (s && s.weaponId ? ITEMS.WEAPONS[s.weaponId].name : itemLabel(s ? s.itemId : uid)));
  } else {
    const src = _srcEntry('loadout', uid);
    if (src) toast(itemLabel(src.entry.itemId));
  }
  renderLobby();
}
function onLoadoutKey(ev) {
  if (ev.code !== 'KeyR') return;
  if (dragState) {
    if (dragState.surface !== 'loadout') return; // 局内背包：R 是换弹，旋转走双击（避免语义冲突）
    dragState.rot = GRIDUI.normRot(dragState.rot) === 1 ? 0 : 1;
    _sizeGhost(); _updateDropTarget();
    ev.preventDefault();
    return;
  }
  if (!profile || !focusUid || !loadoutEditable()) return;
  if (!dom.lobby || dom.lobby.style.display === 'none') return;
  const r = LOADOUT.rotateUid(profile, focusUid);
  if (r.ok) { profile = r.profile; STORAGE.set('profile', profile); renderLobby(); }
  ev.preventDefault();
}
// 局内背包旋转的统一实现（按钮与双击都走这里；与 R = 换弹 划清边界）
window._exfilRaidRotate = function () {
  if (!raidLayout || !raidSelUid) return;
  const r = RAIDINV.rotate(raidLayout, raidSelUid);
  if (r && r.ok) raidLayout = r.grid; else toast('没有空间旋转（先挪出空位）');
  renderRaidGrid();
};
let raidBound = false;
let lootBound = false; // E043
let carryBound = false; // 任务 B：携带空间（rig / backpack）
function bindGridEvents() {
  if (!gridBound) {
    const host = dom.stashGrid;
    if (host) host.addEventListener('pointerdown', onPointerDown);
    if (dom.equipslots) dom.equipslots.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('keydown', onLoadoutKey);
    gridBound = true;
  }
  const rh = dom.invGrid;
  if (rh && !raidBound) {
    rh.addEventListener('pointerdown', onPointerDown);
    raidBound = true;
  }
  const lh = dom.lootGrid;
  if (lh && !lootBound) {
    lh.addEventListener('pointerdown', onPointerDown);
    lootBound = true;
  }
  // 任务 B：携带空间（两个容器格共用一个绑定标志即可——两者总是同时存在）
  if (!carryBound && dom.rigGrid && dom.backpackGrid) {
    dom.rigGrid.addEventListener('pointerdown', onPointerDown);
    dom.backpackGrid.addEventListener('pointerdown', onPointerDown);
    carryBound = true;
  }
}
// ---------- P4：局内背包格子渲染（视图层）----------
let raidInvSim = null, raidInvMyId = null;
// E043：逐件拿取（uid 锚定；弹药自动入备弹库 / 其他进背包，结果经事件回传刷新）
function takeFromContainer(uid) {
  if (!lootOpen) return;
  if (mode === 'solo' && sim) {
    sim.takeFromContainer('solo', lootOpen.containerId, uid);
    drainNow();
  } else if (mode === 'online' && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'takeFromContainer', containerId: lootOpen.containerId, uid }));
  }
}
window._exfilTakeAll = function () {
  if (!lootOpen) return;
  if (mode === 'solo' && sim) {
    sim.interactContainer('solo', lootOpen.containerId); // 全部拿走（原 search 语义）
    drainNow();
  } else if (mode === 'online' && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'search', containerId: lootOpen.containerId }));
  }
};
// E043：容器格子渲染（战利品逐件摆格；布局由 uid 驱动，跨广播稳定）
function lootGridCfg() {
  const g = CFG.grid || {};
  const num = (v, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : d; };
  return { cols: Math.max(4, num(g.lootCols, 8)), rows: Math.max(3, num(g.lootRows, 5)) };
}
function renderLootGrid() {
  const host = dom.lootGrid;
  if (!host || !lootOpen) return;
  ensureRaidInvSession();
  const c = lootGridCfg();
  const res = RAIDINV.reconcile(lootLayout, lootOpen.loot, { cols: c.cols, rows: (lootLayout && lootLayout.h) || c.rows });
  lootLayout = res.grid;
  const now = Date.now();
  const pw = host.clientWidth || 250;
  lootCell = Math.max(20, Math.min(34, Math.floor(Math.max(80, pw - 26) / c.cols)));
  let bg = host.querySelector('.gridbg');
  if (!bg) { bg = document.createElement('div'); bg.className = 'gridbg'; host.appendChild(bg); }
  bg.style.gridTemplateColumns = 'repeat(' + c.cols + ', ' + lootCell + 'px)';
  bg.style.gridAutoRows = lootCell + 'px';
  bg.style.height = (lootCell * lootLayout.h) + 'px';
  const total = c.cols * lootLayout.h;
  const arr = new Array(total);
  for (let i = 0; i < total; i++) arr[i] = '<div class="cell"></div>';
  bg.innerHTML = arr.join('');
  for (const el of Array.prototype.slice.call(host.querySelectorAll('.gitem, .dropll'))) el.remove();
  const frag = document.createDocumentFragment();
  for (const e of lootLayout.items) {
    const fp = GRIDUI.footprint(e.itemId, e.rot);
    const el = document.createElement('div');
    el.className = 'gitem' + (GRIDUI.isWeaponId(e.itemId) ? ' w' : '') + (lootFlash[e.uid] > now ? ' gnew' : '');
    el.setAttribute('data-uid', e.uid);
    el.style.left = (e.x * lootCell) + 'px';
    el.style.top = (e.y * lootCell) + 'px';
    el.style.width = (fp[0] * lootCell - 2) + 'px';
    el.style.height = (fp[1] * lootCell - 2) + 'px';
    paintItemEl(el, e, lootCell, { tip: '单击拿取 · 或拖入背包' });
    frag.appendChild(el);
  }
  host.appendChild(frag);
  if (dom.lootTitle) dom.lootTitle.textContent = lootFrom ? ('容器 · ' + lootFrom) : '容器';
  bindGridEvents();
}
// E043：收起容器栏（拿空 / 关闭面板共用）
function hideLootPane() {
  lootOpen = null; lootLayout = null;
  if (dom.lootPane) dom.lootPane.style.display = 'none';
  if (dom.invGrid) dom.invGrid.classList.remove('dropok');
}
function resetRaidInvView() {
  raidLayout = null; raidSelUid = null; lootFlash = {}; lootFrom = ''; pendingLootOpen = null;
  lootOpen = null; lootLayout = null; // E043：新的一局容器视图一并复位
}
// 每局重置：单机按 sim 对象身份、联机按局内 id（不依赖任何 raid 启动钩子）
function ensureRaidInvSession() {
  if (mode === 'solo') {
    if (sim !== raidInvSim) { raidInvSim = sim; raidInvMyId = null; resetRaidInvView(); }
  } else if (myId !== raidInvMyId) {
    raidInvMyId = myId; raidInvSim = null; resetRaidInvView();
  }
}
function raidGridCfg() {
  const g = CFG.grid || {};
  const num = (v, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : d; };
  return { cols: Math.max(4, num(g.raidCols, 10)), rows: Math.max(3, num(g.raidRows, 10)) };
}
function renderRaidActions() {
  const box = dom.invAct;
  const detail = dom.invList;
  const src = invSource();
  if (!src) { if (box) box.innerHTML = ''; return; }
  const idx = RAIDINV.indexByUid(src.items);
  const i = (raidSelUid && (raidSelUid in idx)) ? idx[raidSelUid] : -1;
  const it = (i >= 0) ? src.items[i] : null;
  if (!it) {
    if (detail) detail.innerHTML = '<div id="inv-empty">点选格子里的物品后可装备 / 使用 / 丢弃 · 拖动整理 · 双击旋转</div>';
    if (box) box.innerHTML = '';
    return;
  }
  const def = ITEMS.LOOT[it.itemId] || ITEMS.WEAPONS[it.itemId] || ITEMS.MODS[it.itemId] || {};
  if (detail) {
    detail.innerHTML = '<div class="nm">' + itemLabel(it.itemId)
      + '<span class="sub">' + (def.desc || '') + (def.price ? (' · ' + def.price + '₽') : '') + '</span></div>'
      + '<div class="w" style="margin-top:4px">数量 ' + (it.count || 1) + (it.ammo ? (' · 弹 ' + it.ammo.count) : '') + '</div>';
  }
  let html = '';
  if (it.isWeapon) html += '<button class="mini" onclick="window._exfilUseItem(' + i + ')">装备</button>';
  else if (def.heal || def.ammo) html += '<button class="mini" onclick="window._exfilUseItem(' + i + ')">使用</button>';
  html += '<button class="mini" onclick="window._exfilRaidRotate()">旋转</button>';
  html += '<button class="mini danger" onclick="window._exfilDropItem(' + i + ')">丢弃</button>';
  if (box) box.innerHTML = html;
}
function renderRaidGrid() {
  const host = dom.invGrid;
  if (!host) return;
  ensureRaidInvSession();
  const src = invSource();
  if (!src) return;
  const c = raidGridCfg();
  const res = RAIDINV.reconcile(raidLayout, src.items, { cols: c.cols, rows: (raidLayout && raidLayout.h) || c.rows });
  raidLayout = res.grid;
  const now = Date.now();
  for (const uid of res.added) lootFlash[uid] = now + 8000; // 刚搜到的 → 高亮 8 秒
  const pw = host.clientWidth || 350;
  raidCell = Math.max(24, Math.min(40, Math.floor(Math.max(120, pw - 26) / c.cols)));
  let bg = host.querySelector('.gridbg');
  if (!bg) { bg = document.createElement('div'); bg.className = 'gridbg'; host.appendChild(bg); }
  bg.style.gridTemplateColumns = 'repeat(' + c.cols + ', ' + raidCell + 'px)';
  bg.style.gridAutoRows = raidCell + 'px';
  bg.style.height = (raidCell * raidLayout.h) + 'px';
  const total = c.cols * raidLayout.h;
  const arr = new Array(total);
  for (let i = 0; i < total; i++) arr[i] = '<div class="cell"></div>';
  bg.innerHTML = arr.join('');
  for (const el of Array.prototype.slice.call(host.querySelectorAll('.gitem, .dropll'))) el.remove();
  const frag = document.createDocumentFragment();
  for (const e of raidLayout.items) {
    const fp = GRIDUI.footprint(e.itemId, e.rot);
    const el = document.createElement('div');
    el.className = 'gitem' + (GRIDUI.isWeaponId(e.itemId) ? ' w' : '')
      + (e.uid === raidSelUid ? ' sel' : '') + (lootFlash[e.uid] > now ? ' gnew' : '');
    el.setAttribute('data-uid', e.uid);
    el.style.left = (e.x * raidCell) + 'px';
    el.style.top = (e.y * raidCell) + 'px';
    el.style.width = (fp[0] * raidCell - 2) + 'px';
    el.style.height = (fp[1] * raidCell - 2) + 'px';
    paintItemEl(el, e, raidCell, { tip: '双击旋转' });
    frag.appendChild(el);
  }
  host.appendChild(frag);
  if (dom.invW) { dom.invW.textContent = src.weight.toFixed(1); dom.invW.className = src.overweight ? 'val warn' : 'val'; }
  if (dom.invCap) dom.invCap.textContent = src.cap;
  if (dom.invUsed) dom.invUsed.textContent = RAIDINV.usedCells(raidLayout) + '/' + RAIDINV.totalCells(raidLayout);
  if (dom.invTitle) dom.invTitle.textContent = lootFrom ? ('背包 \u00b7 搜刮自 ' + lootFrom) : '背包';
  bindGridEvents();
  renderRaidActions();
}
// ---------- M4 携带设置（进图前按量携带；用户 2026-09-14 拍板方案 A）----------
// 语义：进图从仓库【扣除】→ 撤离【归仓剩余】/ 死亡【丢失】（逻辑见 shared/items.js takeCarry/settleCarry）
function carryState() {
  if (!profile.carry) profile.carry = ITEMS.suggestCarry(profile); // 首次：给默认建议（每口径 min(库,60)，物资不带）
  if (!profile.carry.ammo) profile.carry.ammo = {};
  if (!profile.carry.items) profile.carry.items = [];
  return profile.carry;
}
function renderCarrySection() {
  // 任务 B · B3：单机携带已实体化（改为「把要带的装进胸挂/背包容器」），
  // 旧的数值加减控件（±10 / ±1）不再参与进图逻辑 → 只留一条引导提示，避免误导。
  if (dom.carryBox) {
    dom.carryBox.innerHTML = '<div style="color:#78909c;font-size:11px;margin-top:8px;line-height:1.6">'
      + '携带已实体化：把要带进图的弹药 / 物资<b style="color:#ffd54f">拖进左侧「携带空间」</b>的胸挂或背包即可。<br>'
      + '胸挂内物品可快捷使用，背包内不可；撤离时未用完的留在容器里。</div>';
  }
}
// [已废弃·保留代码供 SCAV / 联机整备参考] 旧数值携带 UI 与加减控件
function renderCarrySectionLegacy() {
  const c = carryState();
  const lib = profile.ammoLib || {};
  let html = '<h3 style="color:#90a4ae;font-size:13px;margin:12px 0 6px">携带进图</h3>';
  const cals = Object.keys(lib).filter(k => (lib[k] || 0) > 0);
  if (!cals.length) {
    html += '<div style="color:#6b757d;font-size:12px">弹药库为空 —— 先向商人购买或局内搜刮</div>';
  }
  for (const cal of cals) {
    const nm = (ITEMS.AMMO && ITEMS.AMMO[cal] && ITEMS.AMMO[cal].name) || cal;
    const cur = Math.max(0, Math.min(c.ammo[cal] || 0, lib[cal]));
    c.ammo[cal] = cur;
    html += `<div style="display:flex;align-items:center;justify-content:space-between;color:#cfd8dc;font-size:12px;padding:2px 0">
      <span>${nm} <span style="color:#6b757d">/ 库 ${lib[cal]}</span></span>
      <span style="white-space:nowrap"><button class="modbtn" onclick="window._exfilCarryAmmo('${cal}',-10)">−10</button><b style="color:#ffd54f;margin:0 6px">${cur}</b><button class="modbtn" onclick="window._exfilCarryAmmo('${cal}',10)">+10</button></span>
    </div>`;
  }
  const loots = profile.stash.filter(s => !s.weaponId);
  if (loots.length) {
    html += '<div style="color:#90a4ae;font-size:12px;margin:8px 0 4px">携带物资（局内可用）</div>';
    html += loots.map(s => {
      const def = ITEMS.LOOT[s.itemId];
      const rec = c.items.find(x => x.itemId === s.itemId);
      const cur = rec ? rec.count : 0;
      const have = s.count || 1;
      return `<div style="display:flex;align-items:center;justify-content:space-between;color:#cfd8dc;font-size:12px;padding:2px 0">
        <span>${def ? def.name : s.itemId} <span style="color:#6b757d">/ 仓 ${have}</span></span>
        <span style="white-space:nowrap"><button class="modbtn" onclick="window._exfilCarryItem('${s.itemId}',-1)">−1</button><b style="color:#ffd54f;margin:0 6px">${cur}</b><button class="modbtn" onclick="window._exfilCarryItem('${s.itemId}',1)">+1</button></span>
      </div>`;
    }).join('');
  }
  const box = document.createElement('div');
  box.innerHTML = html;
  if (dom.carryBox) dom.carryBox.appendChild(box); // P2：格子化后携带控件独立容器（原挂在仓库列表下）
}
window._exfilCarryAmmo = function (cal, delta) {
  const c = carryState();
  const max = (profile.ammoLib || {})[cal] || 0;
  c.ammo[cal] = Math.max(0, Math.min((c.ammo[cal] || 0) + delta, max));
  STORAGE.set('profile', profile);
  renderLobby();
};
window._exfilCarryItem = function (itemId, delta) {
  const c = carryState();
  const slot = profile.stash.find(s => s.itemId === itemId && !s.weaponId);
  if (!slot) return;
  const max = slot.count || 1;
  const idx = c.items.findIndex(x => x.itemId === itemId);
  const cur = idx >= 0 ? c.items[idx].count : 0;
  const next = Math.max(0, Math.min(cur + delta, max));
  if (next <= 0) { if (idx >= 0) c.items.splice(idx, 1); }
  else if (idx >= 0) c.items[idx].count = next;
  else c.items.push({ itemId, count: next });
  STORAGE.set('profile', profile);
  renderLobby();
};
// E030：联机商人/改装指令（lobby 阶段，档案服务器权威；单机则直接改本地）
function sendTrade(action) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'trade', id: profileId, name: myName, action }));
}
// ---------- 商人系统（卖出战利品换钱 + 购买补给，形成经济循环） ----------
const TRADER_GOODS = (CFG.content && CFG.content.traderGoods) || [
  { id: 'ammo_box_545', label: '5.45 弹药箱 (30发)', price: 60 },
  { id: 'ammo_box_9x18', label: '9x18 弹药箱 (20发)', price: 40 },
  { id: 'bandage', label: '绷带 (+20HP)', price: 20 },
  { id: 'ifak', label: 'IFAK 急救包 (+50HP)', price: 80 }
];
function renderTrader() {
  const el = dom.trader;
  if (!el) return;
  el.innerHTML = '<div style="color:#90a4ae;font-size:12px;margin-bottom:8px">出售战利品换钱，购买补给</div>' +
    TRADER_GOODS.map(g => {
      const owned = profile.stash.find(s => s.itemId === g.id);
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px;color:#cfd8dc">
        <span>${g.label}${owned ? ` <span style="color:#ffd54f">×${owned.count || 1}</span>` : ''}</span>
        <button class="modbtn" onclick="window._exfilBuy('${g.id}')">${g.price}₽ 买</button>
      </div>`;
    }).join('') +
    '<div style="border-top:1px solid #313c46;margin:8px 0"></div>' +
    '<div style="color:#90a4ae;font-size:12px;margin-bottom:4px">武器</div>' +
    Object.values(ITEMS.WEAPONS).map(w =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px;color:#cfd8dc">
      <span>${w.name}（${w.magSize}+${w.magSize}发）</span><button class="modbtn" onclick="window._exfilBuyWeapon('${w.id}')">${w.price}₽ 买</button></div>`
    ).join('')
    // P2：仓库物资出售（格子化后按 itemId 汇总；战利品不再有独立列表）
    + (function () {
      const agg = {};
      for (const e of (profile.grid ? profile.grid.items : [])) {
        if (GRIDUI.isWeaponId(e.itemId)) continue;
        agg[e.itemId] = (agg[e.itemId] || 0) + (e.count || 1);
      }
      const ids = Object.keys(agg);
      if (!ids.length) return '';
      return '<div style="border-top:1px solid #313c46;margin:8px 0"></div>'
        + '<div style="color:#90a4ae;font-size:12px;margin-bottom:4px">出售物资</div>'
        + ids.map(function (id) {
          const d = ITEMS.LOOT[id] || {};
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px;color:#cfd8dc">'
            + '<span>' + (d.name || id) + ' ×' + agg[id] + '</span>'
            + '<button class="modbtn" onclick="window._exfilSellLoot(\'' + id + '\')">卖 ' + (d.price || 0) + '₽/个</button></div>';
        }).join('');
    })();
}
window._exfilSellLoot = function (itemId) {
  if (mode === 'online') { sendTrade({ type: 'sellLoot', itemId }); return; } // E030：联机服务器权威
  // P2：格子化后按 uid 逐条出仓（同 itemId 可能分散在多个格子块）
  const price = ITEMS.LOOT[itemId] ? ITEMS.LOOT[itemId].price : 0;
  const uids = profile.grid.items.filter(e => e.itemId === itemId).map(e => e.uid);
  if (!uids.length) return;
  let p = profile, sold = 0;
  for (const uid of uids) {
    const before = LOADOUT.countOf(p, itemId);
    const r = LOADOUT.removeFromGrid(p, uid);
    if (r.ok) { p = r.profile; sold += before; }
  }
  if (!sold) return;
  profile = { ...p, money: (p.money || 0) + price * sold };
  STORAGE.set('profile', profile);
  toast(`卖出 ${price * sold}₽`);
  renderLobby();
};
// 出售武器（v0.6.15）：双态确认（点一次变"确认出售？"再点才卖）——不用 confirm（iframe 沙箱禁用，E017）
window._sellConfirmTimer = null;
window._exfilSellWeapon = function (idx) {
  const item = profile.stash[idx];
  if (!item || !ITEMS.WEAPONS[item.weaponId]) return;
  const def = ITEMS.WEAPONS[item.weaponId];
  const btn = dyn('sell-weapon-btn');
  // 双态确认：未确认 → 变"确认出售？"并计时；已确认 → 执行出售
  if (!window.__sellArmed) {
    window.__sellArmed = true;
    if (btn) btn.textContent = `确认出售 ${def.name}？`;
    clearTimeout(window._sellConfirmTimer);
    window._sellConfirmTimer = setTimeout(() => { window.__sellArmed = false; if (btn) btn.textContent = `卖出 ${def.price}₽`; }, 3000);
    return;
  }
  window.__sellArmed = false;
  if (mode === 'online') { sendTrade({ type: 'sellWeapon', index: idx }); return; } // E030：联机服务器权威
  // P2：按 uid 出仓（装备中的武器先卸下再出仓）
  const uid = profile.stash[idx] ? profile.stash[idx].uid : null;
  let p = profile, okSold = false;
  if (uid && !GRIDUI.findByUid(profile.grid, uid)) {
    for (const slot of LOADOUT.slotOrder()) {
      if (profile.equipment[slot] && profile.equipment[slot].uid === uid) {
        const u = LOADOUT.unequipSlot(profile, slot);
        if (u.ok) p = u.profile;
        break;
      }
    }
  }
  const r = uid ? LOADOUT.removeFromGrid(p, uid) : { ok: false };
  if (r.ok) { profile = { ...r.profile, money: (r.profile.money || 0) + def.price }; okSold = true; }
  else { profile = { ...profile, money: profile.money + def.price }; profile = LOADOUT.syncProfile(profile).profile; }
  ensureValidSelection(); // 修复：出售后重算（原「钳到 0」会指向杂货，同样误报无武器）
  STORAGE.set('profile', profile);
  toast(`已出售 ${def.name} +${def.price}₽`);
  renderLobby();
};
window._exfilBuy = function (itemId) {
  if (mode === 'online') { sendTrade({ type: 'buy', itemId }); return; } // E030：联机服务器权威
  const g = TRADER_GOODS.find(x => x.id === itemId);
  if (!g || profile.money < g.price) { toast('钱不够'); return; }
  const r = LOADOUT.addToGrid({ ...profile, money: profile.money - g.price }, itemId, 1);
  if (!r.ok) { toast('仓库已满，无法放入'); return; }
  profile = r.profile;
  STORAGE.set('profile', profile);
  toast(`购买了 ${g.label}`);
  renderLobby();
};
window._exfilBuyWeapon = function (weaponId) {
  if (mode === 'online') { sendTrade({ type: 'buyWeapon', weaponId }); return; } // E030：联机服务器权威
  const def = ITEMS.WEAPONS[weaponId];
  if (!def || profile.money < def.price) { toast('钱不够'); return; }
  const weaponItemId = ITEMS.LOOT['w_' + weaponId] ? 'w_' + weaponId : weaponId;
  const r = LOADOUT.addToGrid({ ...profile, money: profile.money - def.price }, weaponItemId, 1,
    { mods: {}, ammo: { ammoId: def.ammoType, count: def.magSize, reserve: def.magSize } });
  if (!r.ok) { toast('仓库已满，无法放入'); return; }
  profile = r.profile;
  STORAGE.set('profile', profile);
  toast(`购买了 ${def.name}`);
  renderLobby();
};
function renderWeaponDetail() {
  const item = profile.stash[selectedIdx];
  const detail = dom.detail;
  const enter = dom.lobbyEnter;
  if (!item || !ITEMS.WEAPONS[item.weaponId]) {
    detail.innerHTML = '<div class="d" style="color:#78909c">无武器可选 —— 可徒手进图（拳头 12 伤害），或搜刮补给后再来</div>';
    enter.disabled = false;
    enter.textContent = '徒手进图';
    return;
  }
  const def = ITEMS.WEAPONS[item.weaponId];
  const ammoCount = item.ammo ? item.ammo.count : 0;
  let slotsHtml = '';
  for (const slot of def.slots) {
    const modId = item.mods ? item.mods[slot] : null;
    const modDef = modId ? ITEMS.MODS[modId] : null;
    if (slot === 'sight') {
      slotsHtml += `<div class="row"><span class="lbl">瞄具槽</span><span class="val">${modDef ? modDef.name : '空'}
        <button class="modbtn" onclick="window._exfilToggleSight(${selectedIdx})">${modDef ? '卸下' : '安装 PSO'}</button></span></div>`;
    } else {
      slotsHtml += `<div class="row"><span class="lbl">${slot} 槽</span><span class="val">${modDef ? modDef.name : '空'}</span></div>`;
    }
  }
  detail.innerHTML = `
    <div class="row"><span class="lbl">武器</span><span class="val">${def.name}</span></div>
    <div class="row"><span class="lbl">伤害</span><span class="val">${def.dmg}</span></div>
    <div class="row"><span class="lbl">弹药</span><span class="val">${ammoCount} / ${item.ammo && item.ammo.reserve ? item.ammo.reserve : 0}</span></div>
    ${slotsHtml}
    <div class="row"><span class="lbl">出售</span><span class="val"><button class="modbtn" id="sell-weapon-btn" style="color:#ff6b6b" onclick="window._exfilSellWeapon(${selectedIdx})">卖出 ${def.price}₽</button></span></div>`;
  enter.disabled = false;
  enter.textContent = ammoCount > 0 ? '进入地图' : '弹药不足，徒手进图（可搜刮弹药补给）';
}
window._exfilToggleSight = function (idx) {
  if (mode === 'online') { sendTrade({ type: 'toggleSight', index: idx }); return; } // E030：联机服务器权威
  const item = profile.stash[idx];
  if (!item) return;
  const def = ITEMS.WEAPONS[item.weaponId];
  if (!def || !def.slots.includes('sight')) return;
  // P2：改装写在 stash 上，再经 syncProfile 按 uid 写回格子/装备槽（保持纯函数风格）
  const newStash = profile.stash.map((s, i) => i === idx
    ? { ...s, mods: { ...(s.mods || {}), sight: (s.mods && s.mods.sight) ? null : 'pso' } } : s);
  profile = LOADOUT.syncProfile({ ...profile, stash: newStash }).profile;
  STORAGE.set('profile', profile);
  renderLobby();
};
// E040：单机进图统一入口（PMC 与 SCAV 共用同一条流程，只有装备来源不同）
function startSoloRaid(opts) {
  const o = opts || {};
  raidWeapon = o.weapon || null;
  dom.lobby.style.display = 'none';
  setupSolo(raidWeapon, o.ammo || {}, o.items || []);
}
// E040：进图兜底——任何异常都必须「回到整备 + 显示原因 + 留痕」，绝不允许留下白屏
// （用户实测 SCAV 白屏但开发环境无法复现，故把不可见的失败变成可见信息）
function enterRaidSafe(label, fn) {
  try {
    fn();
    return true;
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    window.__lastRaidError = { label, message: msg, stack: String((e && e.stack) || ''), at: Date.now() };
    console.error('[' + label + '] 进图失败:', e);
    try { sim = null; } catch (e2) { /* 忽略 */ }
    raidIsScav = false;
    paused = false;
    dead = false;
    try { renderLobby(); } catch (e2) { dom.lobby.style.display = 'flex'; }
    bigMsg('进入地图失败（已返回整备）', label + '：' + msg + '　—— 请把这条信息反馈给开发者');
    toast('进图失败：' + msg);
    return false;
  }
}
function enterRaid() {
  // M3e：联机 → 指令交服务器（进图武器下标 = selectedIdx），等 init 下发武器
  if (mode === 'online') {
    dom.lobby.style.display = 'none';
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'join', id: profileId, name: myName, stashIndex: selectedIdx }));
    else bigMsg('连接已断开', '刷新页面重试');
    return;
  }
  // 2026-09-26 弹药实体化：旧档案武器条目上的 reserve → 仓库**实体弹药堆叠**（不再进数值库）
  let migrated = false;
  for (const s of profile.stash) {
    if (s.weaponId && s.ammo && s.ammo.reserve) {
      const cal = s.ammo.ammoId;
      const hit = profile.stash.find(x => !x.weaponId && x.itemId === cal);
      if (hit) hit.count = (hit.count || 1) + s.ammo.reserve;
      else profile.stash.push({ itemId: cal, count: s.ammo.reserve });
      s.ammo.reserve = 0;
      migrated = true;
    }
  }
  if (migrated) STORAGE.set('profile', profile);
  // P2：出战武器由 uid 解析（装备槽优先；selectedIdx 是其 legacy 下标，语义不变）
  const wres = LOADOUT.raidWeaponOf(profile, selectedUid);
  let inst = wres ? wres.instance : null;
  if (inst && inst.ammo.count <= 0) inst = null; // 弹尽 → 徒手，防止卡死
  // 任务 B · B3：进图携带 = **读容器实体条目**（塔科夫式：把要带的装进胸挂/背包）
  // 取代旧的数值 carry（carryState）；输出 raidAmmo/raidItems 契约不变 → sim 层零改动。
  // 迁移保障：老档案 profile.carry 已由 LOADOUT.syncProfile → Containers.migrateCarry 转入容器。
  const carried = ITEMS.takeCarryFromContainers(profile);
  profile = LOADOUT.syncProfile(carried.profile).profile; // P2：扣除结果同步回格子
  STORAGE.set('profile', profile);
  const ok = enterRaidSafe('PMC 进图', () => startSoloRaid({ weapon: inst, ammo: carried.raidAmmo, items: carried.raidItems }));
  if (ok && !inst) toast('徒手进图——搜刮弹药箱补给后返回整备');
}
window._exfilEnterRaid = enterRaid;
// E031/E039：以 SCAV 身份进入
//   单机 → 本地随机装备（不消耗仓库；撤离装备归仓 / 阵亡无损失）
//   联机 → 在房间内切换形态（服务器权威，见 roomScavToggle）
window._exfilEnterRaidAsScav = function () {
  if (mode === 'online') {
    if (roomSnap) roomScavToggle();
    else toast('联机：请在房间内点「以 SCAV 身份出战」');
    return;
  }
  if (!profile) return;
  // E040：走与 PMC 完全相同的进图流程（startSoloRaid），仅装备来源不同
  enterRaidSafe('SCAV 进图', () => {
    const inst = ITEMS.randomScavWeapon();
    raidIsScav = true;
    startSoloRaid({ weapon: inst, ammo: {}, items: [] }); // 空弹药库 + 空背包（不消耗仓库携带）
    toast(inst ? ('SCAV 形态：' + inst.name + ' · 撤离装备归仓 / 阵亡无损失') : 'SCAV 形态：徒手进入');
  });
};
// E036/E039 自检入口：浏览器 F12 输入 __exfilState() 可查运行态（黑屏 / SCAV 进不去排查用）
// P4 起附位置/朝向/搜刮提示 —— 走位类验收需要真实键鼠闭环时的观测点
window.__exfilState = () => ({
  mode, hasProfile: !!profile, raidIsScav, hasRoom: !!roomSnap, selectedIdx, selectedUid,
  pos: { x: Math.round(local.x * 100) / 100, z: Math.round(local.z * 100) / 100 },
  yaw: Math.round(local.yaw * 1000) / 1000,
  hint: (dom.interactHint && dom.interactHint.textContent) || '',
  locked: document.pointerLockElement === renderer.domElement,
  frames: window.__frames || 0, renders: window.__renders || 0, lastRaidError: window.__lastRaidError || null
});
// P4 自检：未搜刮容器清单（走位验收用；按距离升序）
window.__exfilContainers = () => {
  const l = (mode === 'solo' && sim) ? sim.players.get('solo') : local;
  const list = (mode === 'solo' && sim) ? sim.containers : remoteContainers;
  if (!l) return [];
  return list.filter(c => !c.looted)
    .map(c => ({ id: c.id, label: c.label, x: c.x, z: c.z, dist: Math.round(Math.hypot(l.x - c.x, l.z - c.z) * 100) / 100 }))
    .sort((a, b) => a.dist - b.dist);
};
// P2 自检：整备界面格子状态（浏览器验收用；F12 输入 __exfilLoadout()）
window.__exfilLoadout = () => {
  if (!profile) return null;
  const eq = {};
  for (const s of LOADOUT.slotOrder()) eq[s] = (profile.equipment && profile.equipment[s]) ? profile.equipment[s].itemId : null;
  return {
    mode, w: profile.grid ? profile.grid.w : 0, h: profile.grid ? profile.grid.h : 0,
    items: (profile.grid ? profile.grid.items : []).map(e => ({ uid: e.uid, itemId: e.itemId, x: e.x, y: e.y, rot: e.rot, count: e.count })),
    equipment: eq, selectedUid, selectedIdx, money: profile.money,
    stashLen: (profile.stash || []).length,
    cell: gridCell, bound: gridBound, editable: loadoutEditable(),
    // 任务 B · B3：携带空间自检（胸挂 / 背包的规格与内容）
    rig: _containerInfo('rig'), backpack: _containerInfo('backpack')
  };
};
function _containerInfo(slot) {
  const c = _containerOfSlot(slot);
  if (!c) return null;
  return {
    w: c.w, h: c.h,
    items: (c.items || []).map(e => ({ uid: e.uid, itemId: e.itemId, x: e.x, y: e.y, rot: e.rot, count: e.count })),
    cell: (slot === 'rig') ? rigCell : backpackCell
  };
}
// P4 自检：局内背包格子状态（浏览器验收用；F12 输入 __exfilRaidInv()）
window.__exfilRaidInv = () => ({
  mode, paused, cell: raidCell, sel: raidSelUid, lootFrom, pendingLoot: !!pendingLootOpen,
  cols: raidLayout ? raidLayout.w : 0, rows: raidLayout ? raidLayout.h : 0,
  items: (raidLayout ? raidLayout.items : []).map(e => ({ uid: e.uid, itemId: e.itemId, x: e.x, y: e.y, rot: e.rot, count: e.count })),
  invLen: (invSource() || { items: [] }).items.length,
  highlighted: Object.keys(lootFlash).filter(u => lootFlash[u] > Date.now())
});
// E043 自检：容器搜刮界面状态（F12 输入 __exfilLoot()）
window.__exfilLoot = () => ({
  open: !!lootOpen,
  containerId: lootOpen ? lootOpen.containerId : null,
  lootCount: lootOpen ? lootOpen.loot.length : 0,
  layoutItems: lootLayout ? lootLayout.items.length : 0,
  cell: lootCell,
  paneVisible: dom.lootPane ? dom.lootPane.style.display : 'none',
  from: lootFrom
});
// 返回整备：把当前弹药/改装写回档案（M1a：装备不丢，死亡丢失 M1c 做）
function backToLobby() {
  if (mode === 'solo' && sim && raidOutcome) {
    const p = sim.players.get('solo');
    // E039：SCAV 进图时未从仓库扣除携带（takeCarry 未调用）→ 结算也不做弹药归仓
    if (!raidIsScav) {
      // M4 结算：撤离成功 → 局内剩余弹药【归仓】；死亡 → 携带量【丢失】（takeCarry 时已扣除）
      profile = ITEMS.settleCarry(profile, { extracted: !!raidOutcome.extracted, raidAmmo: (p && p.ammoLib) || {} });
    }
    // M1c 结算：撤离成功 → 武器/物资入仓；死亡 → 装备丢失（SCAV 时 weaponIdx 恒为 -1，仓库不受损）
    profile = ITEMS.settleRaid(profile, raidOutcome);
    profile = LOADOUT.syncProfile(profile).profile; // P2：丢枪/归仓/弹药写回 → 合并回格子与装备槽
    STORAGE.set('profile', profile);
  }
  raidIsScav = false; // E039：出局复位
  localAmmoLib = {};
  sim = null;
  raidWeapon = null;
  raidOutcome = null;
  containerGroup = null;
  for (const m of scavMeshes.values()) scene.remove(m.group);
  scavMeshes.clear(); // M2：清理 SCAV 渲染
  detachGun(); // 离开本局移除持枪模型
  dead = false;
  paused = false;
  reloading = false; // 重置换弹状态
  local.alive = true;
  setHp(100);
  bigMsg('', '');
  hideExtractHUD();
  dom.invPanel.style.display = 'none';
  dom.interactHint.textContent = '';
  if (mode === 'online') {
    // E026：结算已由服务器落档 → 重新拉取档案刷新整备界面
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'getProfile', id: profileId, name: myName }));
    else renderLobby();
    return;
  }
  renderLobby();
}

// M1b 容器渲染组
let containerGroup = null;
// M1c 结算状态
let raidOutcome = null;
let raidExtractDuration = 10;

function setupSolo(weapon, raidAmmo, raidItems) {
  PHY = CORE.PHYSICS;
  buildMap(CORE.MAP);
  // M1b：按容器配置生成战利品（{itemId, weight, count} 条目，sim 不依赖 items 表）
  const containers = ITEMS.CONTAINERS.map(c => ({
    id: c.id, x: c.x, z: c.z, label: c.label,
    loot: ITEMS.rollContainerLoot(c).map(itemId => {
      const def = ITEMS.LOOT[itemId];
      const ammoTag = def && def.ammo ? { ammoId: def.ammo.ammoId, count: def.ammo.count } : null;
      return { itemId, weight: def.weight, count: 1, ammo: ammoTag };
    })
  }));
  buildContainers(containers);
  buildExtracts(ITEMS.EXTRACTS); // M1c 撤离点
  sim = new SIM.GameSim({ testMode: false, containers, extracts: ITEMS.EXTRACTS });
  // M4：进图弹药 = 携带量（已由 enterRaid 从仓库扣除）；记快照供诊断
  raidAmmoStart = { ...(raidAmmo || {}) };
  sim.addPlayer('solo', myName, { weapon: weapon || null, ammoLib: { ...raidAmmoStart }, inventory: (raidItems || []).map(i => ({ ...i })) });
  sim.spawnScavs(1); // M2e：地图 1 个 SCAV，不刷新（用户拍板）
  syncScavsFromSim();
  myId = 'solo';
  const sp = sim.players.get('solo');
  local.x = sp.x; local.y = sp.y; local.z = sp.z; local.hp = 100; local.alive = true; local.vy = 0;
  dead = false;
  paused = false;
  raidOutcome = null;
  setHp(100);
  updateAmmoHUD(weapon);
  attachGun(weapon); // 第一人称持枪模型（跟随相机）
  renderInventory();
  bigMsg('', '');
  dom.net.textContent = '单机·局内';
  dom.players.innerHTML = '<div style="color:#90a4ae">局内: F 搜刮 · Tab 背包 · T 放弃本局</div>';
  toast(`已携带 ${weapon ? weapon.name : '徒手'} 进入地图 · 地图有 ${ITEMS.EXTRACTS.length} 个撤离点`);
}
function buildExtracts(extracts) {
  const group = new THREE.Group();
  for (const e of extracts) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(e.radius - 0.3, e.radius, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd54f, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(e.x, 0.02, e.z);
    group.add(ring);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd54f, transparent: true, opacity: 0.22 })
    );
    beam.position.set(e.x, 4, e.z);
    group.add(beam);
    const label = makeNameSprite(e.label, 1);
    label.position.set(e.x, 9.5, e.z);
    group.add(label);
  }
  scene.add(group);
}
// ---------- 第一人称持枪模型（体素拼枪，挂相机，跟随视角） ----------
let gunMesh = null;
let gunFlash = null;   // 枪口火光（gunMesh 子对象，开火时闪烁）
let gunBase = null;    // 枪模型基准位置（后坐动画恢复点）
let recoilPitch = 0;   // 视角后坐（垂直上抬，纯视觉不影响瞄准数据）
let recoilYaw = 0;     // 视角后坐（水平散布）
let gunKick = 0;       // 枪模型后坐量 0..1（衰减）
const GUN_COLOR = 0x3a3f46, GUN_DARK = 0x2b2e33, GUN_WOOD = 0x6b4a2b;
function buildGunMesh(weaponDef) {
  const g = new THREE.Group();
  const add = (w, h, d, x, y, z, c) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: c }));
    m.position.set(x, y, z);
    g.add(m);
  };
  const wid = (weaponDef.id || weaponDef.weaponId); // 兼容武器定义（id）与战利品条目（weaponId）两种字段
  let muzzleZ = -0.55;
  if (wid === 'pm') {
    // PM 马卡洛夫：紧凑手枪（套筒+握把+枪管）
    add(0.10, 0.11, 0.30, 0, 0, 0, GUN_DARK);        // 套筒
    add(0.08, 0.13, 0.10, 0, -0.10, 0.08, GUN_WOOD); // 握把
    add(0.05, 0.04, 0.22, 0, 0.05, -0.26, GUN_COLOR); // 枪管
    g.position.set(0.26, -0.30, -0.40);
    g.rotation.x = 0.02;
    muzzleZ = -0.36;
  } else if (wid === 'mp5') {
    // MP5：紧凑冲锋枪（短枪管 + 机匣 + 直弹匣 + 折叠托）
    add(0.05, 0.05, 0.34, 0, 0, -0.16, GUN_COLOR);    // 短枪管
    add(0.09, 0.10, 0.22, 0, 0, 0.06, GUN_DARK);      // 机匣
    add(0.06, 0.16, 0.08, 0, -0.12, 0.02, GUN_COLOR); // 直弹匣
    add(0.07, 0.08, 0.18, 0, -0.02, 0.24, GUN_DARK);  // 折叠托
    add(0.04, 0.04, 0.05, 0, 0.07, -0.32, GUN_COLOR); // 准星
    g.position.set(0.28, -0.30, -0.46);
    g.rotation.x = 0.03;
    muzzleZ = -0.34;
  } else if (wid === 'sv98') {
    // SV-98：栓动狙击（长枪管 + 机匣 + 光学镜 + 木托）
    add(0.06, 0.06, 0.86, 0, 0, -0.38, GUN_COLOR);    // 长枪管
    add(0.09, 0.10, 0.30, 0, 0, 0.14, GUN_DARK);      // 机匣
    add(0.05, 0.05, 0.16, 0, 0.02, 0.30, GUN_COLOR);  // 枪身连接
    add(0.08, 0.09, 0.26, 0, -0.02, 0.52, GUN_WOOD);  // 木色枪托
    add(0.06, 0.06, 0.18, 0, 0.13, 0.06, GUN_DARK);   // 光学镜筒
    add(0.03, 0.03, 0.04, 0, 0.13, -0.04, GUN_DARK);  // 镜片
    g.position.set(0.38, -0.36, -0.62);
    g.rotation.x = 0.03;
    muzzleZ = -0.84;
  } else {
    // AK-74 / AKM：长步枪（枪管+机匣+弹匣+枪托+准星+照门）
    add(0.07, 0.07, 0.60, 0, 0, -0.26, GUN_COLOR);    // 枪管
    add(0.10, 0.11, 0.26, 0, 0, 0.12, GUN_DARK);      // 机匣
    add(0.08, 0.14, 0.12, 0, -0.10, 0.06, GUN_COLOR); // 弹匣
    add(0.09, 0.10, 0.22, 0, 0, 0.38, GUN_WOOD);      // 枪托（木色）
    add(0.05, 0.05, 0.06, 0, 0.08, -0.54, GUN_COLOR); // 准星
    add(0.06, 0.06, 0.04, 0, 0.11, 0.04, GUN_COLOR);  // 照门
    g.position.set(0.34, -0.34, -0.55);
    g.rotation.x = 0.03;
  }
  // 枪口火光（开火时 visible 闪烁，代替全屏闪屏）
  const flash = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.07, 0.10),
    new THREE.MeshBasicMaterial({ color: 0xffc94d, transparent: true, opacity: 0.95 })
  );
  flash.position.set(0, 0.02, muzzleZ - 0.05);
  flash.visible = false;
  g.add(flash);
  return { group: g, flash };
}
function attachGun(weaponDef) {
  detachGun();
  if (!weaponDef) return;
  const built = buildGunMesh(weaponDef);
  gunMesh = built.group;
  gunFlash = built.flash;
  gunBase = { x: gunMesh.position.x, y: gunMesh.position.y, z: gunMesh.position.z };
  camera.add(gunMesh);
}
function detachGun() {
  if (gunMesh) { camera.remove(gunMesh); gunMesh = null; }
  gunFlash = null;
  gunBase = null;
  gunKick = 0;
}
// 换弹动作：枪模型下沉/回位（基准位置偏移）
function dipGun(down) {
  if (!gunMesh || !gunBase) return;
  const dip = CCLIENT.reloadDipHeight || 0.35;
  gunBase.y += (down ? -dip : dip);
}
// 开火后坐：视角上抬 + 水平散布 + 枪模型后坐 + 枪口火光（与弹药消耗同源触发）
function applyRecoil() {
  recoilPitch += (CRECOIL.pitchPerShot || 0.035) + Math.random() * (CRECOIL.pitchRandom || 0.012);
  recoilYaw += (Math.random() - 0.5) * (CRECOIL.yawRandom || 0.008);
  gunKick = 1;
  if (gunFlash) {
    gunFlash.visible = true;
    setTimeout(() => { if (gunFlash) gunFlash.visible = false; }, CCLIENT.muzzleFlashMs || 70);
  }
}

// 撤离 HUD（单机与联机共用）
function showExtractHUD(m) {
  if (m && m.duration) raidExtractDuration = m.duration;
  dom.extractBar.style.display = 'block';
  dom.extractTxt.style.display = 'block';
  if (m && m.duration) toast(`进入撤离点：保持位置 ${m.duration} 秒`);
}
function updateExtractHUD(m) {
  const remain = m.remain;
  dom.extractFill.style.width = `${((raidExtractDuration - remain) / raidExtractDuration * 100).toFixed(0)}%`;
  dom.extractTxt.textContent = `撤离倒计时 ${remain}s`;
}
function hideExtractHUD() {
  dom.extractBar.style.display = 'none';
  dom.extractFill.style.width = '0%';
  dom.extractTxt.style.display = 'none';
}
// M1c 结算面板
// ---------- 阶段一④：结算数据装配（纯函数——仅依赖入参，不读写模块状态、无 DOM 副作用）----------
// 局内换枪时：仓库原武器不写回（该枪在背包 inventory 里，随撤离并入仓库）；未换枪才写回弹药
function computeRaidOutcome(kind, player, weapon, prof, selIdx, isScav) {
  const inv = (player && player.inventory) || [];
  const stash = (prof && prof.stash) || [];
  const orig = stash[selIdx];
  // E039：SCAV 的手持枪不属于仓库 → 绝不能按「型号相同」写回
  // （否则阵亡时会误删仓库里同型号的枪——SCAV 拿 AK 而仓库恰好也有 AK 时必现）
  const sameGun = !isScav && weapon && orig && orig.weaponId === weapon.weaponId;
  const bag = inv.map(i => i.isWeapon
    ? { itemId: i.itemId, count: i.count, isWeapon: true, weaponId: i.weaponId, ammoType: i.ammoType, ammo: { ...i.ammo }, mods: { ...(i.mods || {}) } }
    : { itemId: i.itemId, count: i.count });
  // E039：SCAV 撤离成功 → 手持随机装备随背包一并归仓（对齐联机 settleOnlineRaid 的 SCAV 分支）；阵亡时该字段不生效
  if (isScav && weapon && kind === 'success') {
    bag.push({
      itemId: 'w_' + weapon.weaponId, count: 1, isWeapon: true, weaponId: weapon.weaponId,
      ammoType: weapon.ammo.ammoId, ammo: { ammoId: weapon.ammo.ammoId, count: weapon.ammo.count },
      mods: { ...(weapon.mods || {}) }
    });
  }
  return {
    extracted: kind === 'success',
    weaponIdx: sameGun ? selIdx : -1,
    weaponAmmo: weapon ? { ammoId: weapon.ammo.ammoId, count: weapon.ammo.count } : null,
    weaponMods: weapon && weapon.mods ? { ...weapon.mods } : null,
    inventory: bag
  };
}
function showSummary(kind) {
  const p = sim.players.get('solo');
  raidOutcome = computeRaidOutcome(kind, p, raidWeapon, profile, selectedIdx, raidIsScav);
  paused = true;
  document.exitPointerLock();
  dom.invPanel.style.display = 'none';
  hideExtractHUD();
  const res = dom.summaryRes;
  res.textContent = kind === 'success' ? '撤离成功' : '你已阵亡';
  res.className = 'res ' + (kind === 'success' ? 'ok' : 'bad');
  const list = dom.summaryList;
  if (kind === 'success') {
    let html = `<div class="row"><span class="lbl">武器</span><span>${raidWeapon ? raidWeapon.name : '徒手'}（剩余弹药 ${raidWeapon ? raidWeapon.ammo.count : 0}）</span></div>`;
    if (p.inventory.length) {
      html += p.inventory.map(i => {
        const def = ITEMS.LOOT[i.itemId];
        return `<div class="row"><span class="lbl">${def ? def.name : i.itemId}</span><span>×${i.count}</span></div>`;
      }).join('');
    } else {
      html += '<div class="row"><span class="lbl">物资</span><span>无</span></div>';
    }
    list.innerHTML = html;
  } else {
    list.innerHTML = '<div class="row"><span class="lbl">损失</span><span>携带装备与物资全部丢失</span></div>';
  }
  dom.summary.style.display = 'flex';
}
// 联机结算面板（E026）：数据来自服务器 raidResult，不依赖本地 sim
function showOnlineSummary(m) {
  paused = true;
  dead = true;
  local.alive = false;
  document.exitPointerLock();
  dom.invPanel.style.display = 'none';
  hideExtractHUD();
  const res = dom.summaryRes;
  res.textContent = m.extracted ? '撤离成功' : '你已阵亡';
  res.className = 'res ' + (m.extracted ? 'ok' : 'bad');
  const list = dom.summaryList;
  if (m.extracted) {
    list.innerHTML = `<div class="row"><span class="lbl">武器</span><span>已存入仓库（现 ${m.weapons || 0} 把）</span></div>
      <div class="row"><span class="lbl">物资</span><span>${m.loot || 0} 件</span></div>
      <div class="row"><span class="lbl">资金</span><span>${m.money || 0}₽</span></div>`;
  } else {
    list.innerHTML = '<div class="row"><span class="lbl">损失</span><span>携带装备与物资全部丢失</span></div>';
  }
  dom.summary.style.display = 'flex';
}
window._exfilFinishRaid = function () {
  dom.summary.style.display = 'none';
  backToLobby();
};
function buildContainers(containers) {
  const group = new THREE.Group();
  for (const c of containers) {
    group.add(buildContainerMesh(c, 0x8d6e63)); // 棕木箱
  }
  scene.add(group);
  containerGroup = group;
}
// 单个容器 mesh（含标签）；尸体用深红
function buildContainerMesh(c, color) {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(0.9, 0.7, 0.9);
  const mesh = new THREE.Mesh(geo, boxMat(color));
  mesh.position.set(c.x, 0.35, c.z);
  mesh.userData = { cid: c.id };
  group.add(mesh);
  const label = makeNameSprite(c.label, 1);
  label.position.set(c.x, 1.6, c.z);
  group.add(label);
  return group;
}
function markContainerLooted(cid) {
  if (!containerGroup) return;
  for (const child of containerGroup.children) {
    if (child.userData && child.userData.cid === cid && child.isMesh) {
      child.material = boxMat(0x5d6b78); // 搜刮后变灰
    }
  }
}
function updateAmmoHUD(weapon) {
  const el = dom.ammo;
  if (el) {
    if (weapon) {
      // 显示格式：弹匣内 / 弹药库该口径备弹（E020：统一弹药库，同口径枪共用）
      let reserve = 0;
      if (mode === 'solo' && sim) {
        const p = sim.players.get('solo');
        if (p && p.ammoLib) reserve = p.ammoLib[weapon.ammo.ammoId] || 0;
      } else {
        reserve = localAmmoLib[weapon.ammo.ammoId] || 0;
      }
      el.textContent = reloading ? '换弹中...' : `${weapon.ammo.count} / ${reserve}`;
      el.title = '弹匣内 / 备弹（同口径共用）';
    } else el.textContent = '--/--';
  }
  const w = dom.weaponName;
  if (w) w.textContent = weapon ? weapon.name : '徒手';
}
// ---------- M1b 背包 HUD（Tab 开关 + 鼠标操作） ----------
let paused = false; // 背包打开时暂停局内
// 当前背包数据源（单机 = sim 权威；联机 = 服务器事件维护的副本）
function invSource() {
  if (mode === 'solo' && sim) {
    const p = sim.players.get('solo');
    if (!p) return null;
    return { items: p.inventory, weight: sim.invWeight(p), cap: p.invCap, overweight: sim.isOverweight(p), owner: p };
  }
  const items = remoteInventory;
  const weight = ITEMS.invWeight(items);
  const cap = CFG.player.invCap;
  return { items, weight, cap, overweight: weight > cap, owner: null };
}
// P4：拆出 open/close —— 搜刮（F）也会打开面板并显示搜到的物品
function openBackpack(from) {
  if (mode === 'solo' && !sim) return false;
  if (mode === 'online' && !connected) return false;
  ensureRaidInvSession();   // 必须先判定本局会话（首次可能重置视图），否则 from 会被 reset 清掉
  if (from) lootFrom = from;
  paused = true;
  if (dom.invPanel) dom.invPanel.style.display = 'block';
  renderInventory();
  if (document.exitPointerLock) document.exitPointerLock(); // 解锁鼠标以便操作
  return true;
}
function closeBackpack() {
  paused = false;
  if (dom.invPanel) dom.invPanel.style.display = 'none';
  hideLootPane(); // E043：容器栏随面板收起（未拿走的留在容器，可再回来拿）
  if (dom.interactHint) dom.interactHint.textContent = '';
  requestPointerLock(); // 重新锁定视角
}
function toggleBackpack() {
  if (paused) closeBackpack();
  else openBackpack('');
}
window._exfilToggleBackpack = toggleBackpack;
function renderInventory() {
  const panel = dom.invPanel;
  if (mode === 'solo' && !sim) { if (panel) panel.style.display = 'none'; return; }
  if (!paused) { if (panel) panel.style.display = 'none'; return; } // 未打开不渲染常驻
  const src = invSource();
  if (!src) { if (panel) panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  // P4：格子渲染（负重/占用/选中操作都在 renderRaidGrid 内更新）
  renderRaidGrid();
}
window._exfilUseItem = function (idx) {
  // E022：联机模式 → 指令交服务器（服务器权威消耗/效果），结果经事件回传
  if (mode === 'online') {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'useItem', index: idx }));
    return;
  }
  if (!sim) return;
  const p = sim.players.get('solo');
  if (!p || !p.inventory[idx]) return;
  const def = ITEMS.LOOT[p.inventory[idx].itemId];
  sim.useItem('solo', idx, def ? def.heal || 0 : 0, def && def.ammo ? { ammoId: def.ammo.ammoId, count: def.ammo.count } : null);
  // 背包打开时局内暂停，事件不消费——立即同步刷新 UI（HP/弹药/背包面板）
  consumePendingUI();
  // 装备武器后：同步 raidWeapon（fire 上报/HUD/持枪模型）+ 弹药 HUD
  const pw = sim.players.get('solo').weapon;
  if (pw && (!raidWeapon || raidWeapon.weaponId !== pw.weaponId)) {
    raidWeapon = pw;
    attachGun(pw);
    updateAmmoHUD(pw);
  }
  refreshInvUI();
};
window._exfilDropItem = function (idx) {
  raidSelUid = null; // P4：被丢/被用的条目 uid 失效，先清选中再刷新
  if (mode === 'online') {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'dropItem', index: idx }));
    return;
  }
  if (!sim) return;
  sim.dropItem('solo', idx);
  consumePendingUI();
  refreshInvUI();
};
// P4：立即排空 sim 事件并走统一分发表
// （面板打开时 soloStep 不消费事件；搜刮/使用/丢弃是玩家主动操作，必须立刻反馈）
function drainNow() {
  if (!sim) return;
  for (const ev of sim.drainEvents()) dispatchSimEvent(ev);
}
// 兼容旧名（M1b 起的调用点）
function consumePendingUI() { drainNow(); }
// 立即刷新玩家状态 UI（HP/弹药/背包面板）
function refreshInvUI() {
  const p = sim ? sim.players.get('solo') : null;
  if (p) setHp(p.hp);
  if (raidWeapon) updateAmmoHUD(raidWeapon);
  else {
    // 装备武器后 raidWeapon 由调用方更新；此处兜底读 sim 当前武器
    const w = sim && sim.players.get('solo') ? sim.players.get('solo').weapon : null;
    if (w) updateAmmoHUD(w);
  }
  renderInventory();
}
// 准星提示：最近的未搜刮容器
// 最近的未搜刮容器（单机用 sim 权威；联机用服务器下发的容器副本）
function nearestContainer() {
  const local_ = (mode === 'solo' && sim) ? sim.players.get('solo') : local;
  if (!local_) return null;
  const list = (mode === 'solo' && sim) ? sim.containers : remoteContainers;
  let nearest = null, nd = (CFG.items && CFG.items.containerSearchRange) || 3;
  for (const c of list) {
    if (c.looted) continue;
    const d = Math.hypot(local_.x - c.x, local_.z - c.z);
    if (d < nd) { nd = d; nearest = c; }
  }
  return nearest;
}
function updateInteractHint() {
  const hint = dom.interactHint;
  if (!hint) return;
  if (mode === 'solo' && !sim) { hint.textContent = ''; return; }
  if (!local.alive) { hint.textContent = ''; return; }
  const c = nearestContainer();
  // P4：面板打开时不再吞掉提示（搜刮后自动开面板，需能看到下一个容器）
  hint.textContent = c ? ('按 F 搜刮：' + c.label) : '';
}
// ---------- 阶段一②：局内事件分发表（步进统一入口）----------
// 每个 handler 只做「UI 响应」，不修改 sim 状态；与原 if/else 链逐条行为等价
const SIM_EVENT_HANDLERS = {
  hit: (ev) => handleHitEvent(ev),
  scavDead: (ev) => handleScavDead(ev),
  reloadStart: () => {
    reloading = true;
    dipGun(true); // 换弹动作：枪下沉
    if (raidWeapon) updateAmmoHUD(raidWeapon);
  },
  reloadDone: () => {
    reloading = false;
    dipGun(false); // 换弹完成：枪回原位
    if (raidWeapon) updateAmmoHUD(raidWeapon);
  },
  sound: (ev) => handleSoundEvent(ev),
  scavAlert: (ev) => {
    if (ev.kind === 'vision') toast('⚠ SCAV 看见你了！');
    else if (Date.now() - (window.__lastScavSoundToast || 0) > 2000) {
      window.__lastScavSoundToast = Date.now();
      toast('SCAV 听到动静，正在调查');
    }
  },
  ammo: () => { if (raidWeapon) updateAmmoHUD(raidWeapon); },
  ammoRefilled: (ev) => {
    // 2026-09-26 弹药实体化：拾取弹药箱 → 拆包成**实体堆叠**放入背包（占格、占重、可拆分）
    const n = ev.items.reduce((s, i) => s + i.count, 0);
    toast(`弹药拆包：${n} 发放入背包`);
    if (raidWeapon) updateAmmoHUD(raidWeapon);
  },
  empty: () => toast('弹匣空了！按 R 换弹'),
  invChanged: () => renderInventory(),
  containerOpened: (ev) => {
    // E043：容器内容回传 → 渲染容器格子（新看到的物品高亮）
    if (ev.id !== myId) return;
    const from = lootFrom, wantOpen = !!pendingLootOpen;
    pendingLootOpen = null;
    ensureRaidInvSession(); // 必须先完成进图会话判定（首次渲染会 reset，顺序不对会清掉下面的 lootOpen）
    const now = Date.now();
    for (const e of ev.loot) lootFlash[e.uid] = now + 8000;
    lootOpen = { containerId: ev.containerId, loot: ev.loot };
    lootLayout = null;
    lootFrom = from;
    if (dom.lootPane) dom.lootPane.style.display = 'block';
    if (wantOpen) openBackpack(from);
    renderLootGrid();
  },
  containerLootChanged: (ev) => {
    // E043：容器剩余同步（自己或他人拿取后广播；未打开该容器则忽略）
    if (!lootOpen || lootOpen.containerId !== ev.containerId) return;
    lootOpen.loot = ev.loot;
    renderLootGrid();
  },
  containerLooted: (ev) => {
    markContainerLooted(ev.containerId);
    const names = ev.picked.map(i => ITEMS.LOOT[i.itemId] ? (ITEMS.LOOT[i.itemId].name + '×' + (i.count || 1)) : i.itemId);
    if (names.length) toast('搜刮到：' + names.join('、'));
    else toast('容器已搜刮完');
    // E043：打开中的容器被拿空 → 收起容器栏
    if (lootOpen && lootOpen.containerId === ev.containerId) { hideLootPane(); renderRaidGrid(); return; }
    // P4：搜刮即开面板（把"搜到的东西"直接摆到眼前，新条目高亮 8 秒）
    if (pendingLootOpen) {
      const from = lootFrom;
      pendingLootOpen = null;
      openBackpack(from);
    } else {
      renderInventory();
    }
  },
  equipped: (ev) => {
    toast('装备了 ' + ev.weaponName);
    if (paused) renderRaidGrid();
  },
  invFull: () => toast('背包已满，部分物品未拾取！'),
  usedItem: (ev) => {
    const p = sim.players.get('solo');
    if (p) { setHp(p.hp); if (raidWeapon) updateAmmoHUD(raidWeapon); }
    // E020：使用结果提示
    toast(ev.rejected ? '弹药无法收纳（背包无弹药库）' : `使用了 ${ITEMS.LOOT[ev.itemId] ? ITEMS.LOOT[ev.itemId].name : ev.itemId}`);
    renderInventory();
  },
  extractStart: (ev) => showExtractHUD(ev),
  extractProgress: (ev) => updateExtractHUD(ev),
  extractCancel: () => { hideExtractHUD(); toast('撤离中断！'); },
  extractSuccess: () => { hideExtractHUD(); showSummary('success'); }
};
function dispatchSimEvent(ev) {
  const h = SIM_EVENT_HANDLERS[ev.type];
  if (h) h(ev);
}
function soloStep(dt) {
  if (!sim) return;
  if (paused) { soloAcc = 0; return; } // 背包打开：暂停局内模拟
  soloAcc += dt;
  while (soloAcc >= 1 / 60 && sim) {
    soloAcc -= 1 / 60;
    // 开火权由 sim 判定（冷却+弹药），客户端只上报意图；枪声由 shot 事件触发（与消耗同源）
    // 徒手（无武器）不上报 fire——sim 无武器不开枪，避免"虚空开枪"
    const fire = firing && local.alive && !!raidWeapon;
    sim.applyInput('solo', {
      keys: { f: keys.f ? 1 : 0, b: keys.b ? 1 : 0, l: keys.l ? 1 : 0, r: keys.r ? 1 : 0 },
      jump: jumpPending, yaw: local.yaw + recoilYaw, pitch: local.pitch + recoilPitch, fire
    });
    jumpPending = false;
    sim.tick(1 / 60);
    for (const ev of sim.drainEvents()) dispatchSimEvent(ev);
    // 本地位置 = 模拟权威（零网络无偏差）
    const p = sim.players.get('solo');
    if (p) { local.x = p.x; local.y = p.y; local.z = p.z; }
  }
}

// ---------- 输入 ----------
function requestPointerLock() {
  // E036：非用户手势触发的指针锁定会被浏览器拒绝（服务器 init 消息即属此类）；
  // headless/受限环境还会抛 WrongDocumentError。必须吞掉异常，
  // 否则 init 处理中途中断 → 房间界面已关闭而游戏未就绪 → 黑屏。
  try {
    const r = renderer.domElement.requestPointerLock();
    if (r && typeof r.catch === 'function') r.catch(() => {}); // Chrome 113+ 返回 Promise
  } catch (e) { /* 忽略：点击画面可重新锁定（见 init 提示与 canvas click 监听） */ }
}
document.addEventListener('pointerlockchange', () => {
  dom.canvas.style.cursor = document.pointerLockElement === renderer.domElement ? 'none' : 'default';
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  // 单帧幅度钳制：pointer lock 异常大 movement（浏览器/驱动问题）会导致视角突跳——限制每帧 ≤0.5 rad（约 29°）
  const maxD = CCLIENT.maxLookDeltaPerFrame || 0.5;
  const sens = CCLIENT.mouseSensitivity || 0.0024;
  const dx = Math.max(-maxD, Math.min(maxD, e.movementX * sens));
  const dy = Math.max(-maxD, Math.min(maxD, e.movementY * sens));
  local.yaw -= dx;
  local.pitch -= dy;
  local.pitch = Math.max(-1.5, Math.min(1.5, local.pitch));
});
let lastNoWeaponToast = 0;
document.addEventListener('mousedown', (e) => {
  if (e.button === 0 && document.pointerLockElement) {
    firing = true;
    // 徒手提示（节流 1.5s）
    if (mode === 'solo' && sim && !raidWeapon && local.alive && Date.now() - lastNoWeaponToast > 1500) {
      lastNoWeaponToast = Date.now();
      toast('徒手状态——搜刮容器（F）找武器');
    }
  }
});
document.addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });
document.addEventListener('keydown', (e) => {
  switch (e.code) {
    case 'KeyW': keys.f = true; break; case 'KeyS': keys.b = true; break;
    case 'KeyA': keys.l = true; break; case 'KeyD': keys.r = true; break;
    case 'Space':
      if (local.alive && !e.repeat) {
        if (mode === 'solo') {
          jumpPending = true; // 单机：本地 tick 消费
        } else if (connected && onGroundLocal()) {
          local.vy = PHY.jumpV;
          jumpPending = true; // 下一 60Hz 步进统一发送+预测（保证 1 输入 = 1 步）
        }
        e.preventDefault();
      }
      break;
    case 'KeyR':
      if (!dead && local.alive && raidWeapon) {
        // 换弹：单机直接调 sim；联机发 input reload
        if (mode === 'solo' && sim) sim.reload(sim.players.get('solo'));
        else if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', reload: true, yaw: local.yaw, pitch: local.pitch }));
      }
      break;
    case 'KeyT':
      if (mode === 'solo' && sim) showSummary('death'); // M1c：放弃本局 = 死亡结算（装备丢失）
      break;
    case 'KeyF':
      // P4：搜刮后自动打开背包面板显示所得（面板开着时也能继续搜下一个容器）
      if (local.alive) {
        const c = nearestContainer();
        if (!c) break;
        lootFrom = c.label;
        pendingLootOpen = { label: c.label };
        if (mode === 'solo' && sim) {
          sim.openContainer('solo', c.id); // E043：打开容器格子界面（事件 containerOpened 回传内容）
          drainNow();                      // 立即反馈（否则要等下一个 tick）
        } else if (mode === 'online' && ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'openContainer', containerId: c.id })); // E043：服务器权威
        } else {
          pendingLootOpen = null;
        }
      }
      break;
    case 'Tab':
      if ((mode === 'solo' && sim) || (mode === 'online' && connected)) { toggleBackpack(); e.preventDefault(); }
      break;
  }
});
document.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'KeyW': keys.f = false; break; case 'KeyS': keys.b = false; break;
    case 'KeyA': keys.l = false; break; case 'KeyD': keys.r = false; break;
  }
});
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
dom.canvas.addEventListener('click', () => {
  if (document.pointerLockElement !== renderer.domElement) requestPointerLock();
});

// ---------- 渲染循环 ----------
function lerp(a, b, t) { return a + (b - a) * t; }
let lastFrame = performance.now();
let gameLoopStarted = false;

// E036 修复：联机流程不经过 startGame()，渲染循环从未启动 → 房主开局后房间界面关闭、canvas 全黑。
// 渲染循环必须幂等启动；联机入口显式设置 mode 并启动循环。
function ensureGameLoop() {
  if (gameLoopStarted) return;
  gameLoopStarted = true;
  lastFrame = performance.now();
  animate();
}
function enterOnlineMode() {
  mode = 'online';
  try { initAudio(); } catch (e) { /* 音频初始化失败不应阻断进图 */ }
  ensureGameLoop();
}
function animate() {
  requestAnimationFrame(animate);
  window.__frames = (window.__frames || 0) + 1; // 诊断用：渲染帧计数（联机黑屏自查：F12 输入 __frames）
  fpsTick();
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (mode === 'solo') {
    soloStep(dt); // 本地模拟（权威位置）
    syncScavsFromSim(); // M2：SCAV 位置/状态同步（单机权威）
    updateInteractHint();
  } else if (local.alive) {
    onlineStep(dt); // 联机：预测-和解（E021）
    updateInteractHint(); // 联机也要显示"按 F 搜刮"提示
  }

  // 其他玩家插值（位置 + 朝向；窗口覆盖 30Hz 快照间隔并吸收网络抖动）
  const REMOTE_LERP_MS = 100;
  for (const r of remotePlayers.values()) {
    const p = r.cur;
    if (!p) continue;
    const k = Math.min(1, (now - r._t) / REMOTE_LERP_MS);
    const q = r.prev || p;
    r.group.position.set(
      lerp(q.x, p.x, k),
      lerp(q.y, p.y, k),
      lerp(q.z, p.z, k));
    r.group.rotation.y = lerpAngle(q.yaw !== undefined ? q.yaw : p.yaw, p.yaw, k);
    r.group.visible = p.alive;
  }

  // 相机：单机 = sim 权威位置；联机 = 预测-和解后的本地状态（E021，无 EMA 掩盖）
  camera.position.set(local.x, local.y + 1.62, local.z);
  // 后坐力衰减（帧率无关；纯视觉，不影响瞄准数据 local.pitch/yaw）
  const rk = Math.pow(CRECOIL.decayPerFrame60 || 0.92, dt * 60);
  recoilPitch *= rk;
  recoilYaw *= rk;
  gunKick *= Math.pow(CKICK.decayPerFrame60 || 0.82, dt * 60);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = local.yaw + recoilYaw;
  camera.rotation.x = local.pitch + recoilPitch;
  // 枪模型后坐动画：向后+上抬，随后回位
  if (gunMesh && gunBase) {
    gunMesh.position.set(
      gunBase.x + gunKick * (CKICK.side || 0.15),
      gunBase.y - gunKick * (CKICK.up || 0.06),
      gunBase.z + gunKick * (CKICK.back || 0.22));
  }
  renderer.render(scene, camera);
  window.__renders = (window.__renders || 0) + 1; // E040：真渲染计数（__frames 只证明 rAF 在跑，不代表 render 执行）
}

// ---------- 启动 ----------
export function startGame(m) {
  mode = m === 'online' ? 'online' : 'solo';
  initAudio();
  if (mode === 'online') setupOnline();
  else showLobby(); // M1a：先进整备界面
  ensureGameLoop();
}
