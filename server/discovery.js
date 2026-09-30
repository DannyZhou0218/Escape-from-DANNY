/**
 * E035：局域网房间自动发现（UDP 广播 + 监听）
 *
 * 房主：每 2 秒向 255.255.255.255:9099 广播自身房间信息
 * 所有实例：监听 9099，收集其他房间（6 秒未更新即淘汰）
 * 效果：玩家无需手动查 IP —— 打开本机页面即可看到局域网内的房间
 */
const dgram = require('dgram');

const DISCOVERY_PORT = 9099;
const BROADCAST_INTERVAL = 2000;   // 广播间隔（ms）
const ROOM_TTL = 6000;             // 房间超时淘汰（ms）

const TAG = 'exfil-room';
const rooms = new Map();           // key = ip:port -> room
let opts = null;
let timer = null;

function start(options) {
  opts = options;
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (buf, rinfo) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || m.t !== TAG) return;
    const key = rinfo.address + ':' + (m.port || 0);
    rooms.set(key, {
      key,
      name: m.name || '未命名房间',
      ip: rinfo.address,
      port: m.port || 9090,
      players: m.players || 0,
      max: m.max || 8,
      state: m.state || 'lobby',
      version: m.version || '',
      lastSeen: Date.now()
    });
  });

  sock.on('error', () => { /* 端口被占/网卡异常时静默 —— 发现功能不是主链路 */ });

  sock.bind(DISCOVERY_PORT, () => {
    try { sock.setBroadcast(true); } catch (e) { /* 某些环境不允许广播 */ }
  });

  timer = setInterval(() => {
    const now = Date.now();
    // 1) 淘汰过期房间
    for (const [k, r] of rooms) if (now - r.lastSeen > ROOM_TTL) rooms.delete(k);
    // 2) 广播自己
    if (!opts) return;
    let payload;
    try {
      const info = opts.info();
      payload = JSON.stringify({
        t: TAG,
        name: opts.roomName(),
        port: opts.port,
        players: info.players,
        max: info.max,
        state: info.state,
        version: opts.version
      });
    } catch (e) { return; }
    const b = Buffer.from(payload);
    try {
      sock.send(b, 0, b.length, DISCOVERY_PORT, '255.255.255.255', () => {});
    } catch (e) { /* 广播失败忽略 */ }
  }, BROADCAST_INTERVAL);
}

/** 返回当前局域网内发现的房间（不含自己） */
function list() {
  const now = Date.now();
  const out = [];
  for (const r of rooms.values()) {
    if (now - r.lastSeen > ROOM_TTL) continue;
    out.push({
      key: r.key, name: r.name, ip: r.ip, port: r.port,
      players: r.players, max: r.max, state: r.state, version: r.version,
      ageSec: Math.round((now - r.lastSeen) / 1000)
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function stop() { if (timer) clearInterval(timer); }

module.exports = { start, list, stop, DISCOVERY_PORT };
