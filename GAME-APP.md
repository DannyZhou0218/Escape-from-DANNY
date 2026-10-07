# GAME-APP.md — EXFIL ZONE 项目约定

> 项目级指导性约束（参照 harness enginering STOCK-APP.md 范式）。
> 适用：本游戏项目全部里程碑（M0 起，后续所有模块）。
> 更新：2026-09-30（v0.15.0，护甲/穿透系统 + 联机正确性修复 + 交付链止血）

## 运行时约定
- 端口: **9090**（`PORT` 环境变量可覆盖）；启动前 `netstat + taskkill` 清理旧进程
- 测试模式: `EXFIL_TEST=1` 启用固定开阔出生点（验收场景确定），生产/试玩**禁止**带此变量
- 联机: WebSocket（ws 库），服务器权威；物理 60Hz（tick）+ 快照广播 30Hz（分离）
- 单机: 浏览器本地跑 shared/sim.js（GameSim），零网络；联机走 WebSocket
- 像素风: 体素低模 + 降分辨率渲染（setPixelRatio 0.6 起，自适应降质档 0.6/0.45/0.35/0.28）
- **静态服务一律 `Cache-Control: no-store`**（E010：旧 HTML 缓存 + 新 JS 会组合出幽灵 bug）

## 双环境语义纪律（E010/E011 教训固化，强制）
本项目核心逻辑以 shared/ 双兼容模块（Node CJS + 浏览器普通 script）运行，两环境语义不同，必须遵守：
1. **shared/ 模块顶层禁止声明共享名 const/let**，一律 IIFE 包裹，只通过 `window.EXFIL_*` / `module.exports` 暴露（E011：浏览器普通 script 全局作用域冲突）
2. **浏览器语义测试不可替代**：Node require 测试（每文件独立作用域）测不出浏览器全局冲突——凡改 shared/ 必须跑 `npm test`（含 vm 沙箱浏览器语义用例），Node 测试通过 ≠ 浏览器可运行
3. **验收测内容与执行，不止状态码**：verify.js A4c（内容非空）+ A4e（vm 沙箱执行）+ A4f（资源依赖图），HTTP 200 或 0 字节响应一律 FAIL
4. **前端资源依赖图**：index.html 每个 `<script src>` 必须可解析到真实文件（A4f 检查）；新增前端资源必须同步挂进验收链

## 协议（JSON over WebSocket）
| 方向 | 消息 | 说明 |
|---|---|---|
| C→S | join {name} | 加入，回 init |
| C→S | input {seq, keys, jump, yaw, pitch, fire} | 60Hz；跳跃走 keydown 即时通道 |
| C→S | search / useItem / quickUse / dropItem / respawn | 搜刮容器 / 使用物品 / **胸挂快捷使用** / 丢弃 / 重生（走服务器指令通道，身份一律取 `ws.playerId`） |
| S→C | init {id, map, physics, players, world} | world 含容器战利品 + 撤离点；physics 为客户端预测单一数据源 |
| S→C | state {t, players[{lastSeq,...}]} | 30Hz 快照；客户端回滚+重放和解（禁止 EMA） |
| S→C | hit {shooter, target, dmg, hp, alive} | 命中广播 |
| S→C | sound {kind: shot/step, x, y, z} | 音频事件（客户端合成播放） |
| S→C | playerJoin / playerLeave / respawn | 玩家事件 |
| S→C | raidResult {id, extracted, money, weapons, loot, ammoLib} | 局内结算结果（撤离成功/阵亡 → 落档） |
| S→C | extractSuccess | 撤离成功（倒计时完成） |

## 验收纪律（交付前强制）
- 交付前必须 `PORT=9091 node verify.js` → 全 PASS（**当前 25 项**），数据流未实测 = FAIL（A5 生死线）
  * 用 **9091** 而不是 9090：A1 会 taskkill 该端口，用 9090 会误杀正在跑的主线服务
  * A6 已于 v0.15.0 改造：「页面版本号 === `/health` 的 version 且无 `{{VERSION}}` 残留」（原断言 `/v0\.1\.\d|EXFIL/` 恒真，属假校验，见 E052）
- 服务器核心逻辑改前先跑 `npm test`（Node test runner，含 shared 浏览器语义用例）
- 已知坑先查 开发期错误台账（未随本仓库公开）（当前 E001–E023，含根因与防错模式）

## 构建纪律
- 单一数据源：物理参数 shared/core.js（PHYSICS），地图 shared/map.js（MAP_RAW），服务器/浏览器共用
- 前端禁止引用服务端变量（grep "store\\." 应空）；前端数据一律走 WebSocket/HTTP
- 版本号：页面标题 + /health.version + package.json 三处同步递增（v0.x.y）
- 崩溃日志：uncaughtException/unhandledRejection → crash.log（根目录）

## 文件结构
```
server/server.js    # 多人模式薄壳：HTTP + WS 传输 + GameSim 调度
server/data.js      # 存档层：JSON 档案（仓库/货币），M1 起使用
shared/map.js       # 地图数据（IIFE 双兼容，单一数据源）
shared/core.js      # 纯逻辑：物理/碰撞/射线/出生点（IIFE 双兼容）
shared/sim.js       # GameSim 模拟层（IIFE 双兼容，单机/联机共用）
shared/grid.js      # 格子系统纯函数（仓库/装备槽尺寸、占格、堆叠）
shared/containers.js# 装备容器（胸挂/背包内部空间）纯函数
shared/loadout.js   # 档案契约层（stash ↔ grid/equipment 双向同步）
shared/raidinv.js   # 局内背包视图网格（uid→坐标，零改协议载荷）
shared/predict.js   # 客户端预测-和解步进（语义必须与 sim.stepPlayer 一致）
public/             # 客户端（渲染 + 输入 + 音频 + 单机/联机双模式）
maps/*.json         # 地图数据源（生成 shared/map.js 的输入）
test/*.test.js      # 单测（core/sim/浏览器语义）
verify.js           # RVP 验收（24 项）
```

## 弹药口径一致性纪律（2026-08-22 E019 → 09-13 E020 → 09-26 E045）
- **收纳一律放行**（E020/E033）：弹药箱按**自身** `ammoId` 收入，**不按当前武器口径拒收**（UI 不得禁用「使用」；口径匹配**唯一**发生在换弹动作 `reload`）
- **弹药是实体堆叠**（E045，2026-09-26）：弹药在仓库/背包里是 `{itemId: 口径, count}` 的 **1×1 堆叠条目**（占格、占重、受 `tuning.grid.stackMax` 限制，当前 **60 发/叠**）；弹药箱被拿取/使用时**拆包**成散装弹药堆叠入背包（容量不足则拒绝）
- **HUD/整备显示的备弹是派生值**：`profile.ammoLib` / `player.ammoLib` = 持有弹药的口径汇总，由实体堆叠算出（协议字段名未变，联机载荷兼容）
- **备弹不挂在武器上**（E045）：武器实例只带**弹匣**（`ammoId`/`count`）；换弹直接从背包实体堆叠扣（`invAmmoOf` / `takeInvAmmo`），武器条目上的 `reserve` 字段已废弃（老档案会自动迁移成仓库弹药堆叠）
- 违反后果：PM 用 5.45 这类"跨口径混用"会直接破坏核心战斗逻辑——此类缺陷由静态断言 + sim 单测双重防线拦截（见 test/sim.test.js E019 / test/browser-semantic.test.js E019）

## 运行时路径约定（2026-09-30 修正）
- Node.js：**不要硬编码绝对路径**。用「候选列表 + 探活（取第一个存在的）」或环境变量覆盖：
  1. 打包内置 Node 可用 `EXFIL_NODE` 指定；
  2. 本地开发直接 `node --version` 确认版本（本项目在 Node 22 与 24 上验证通过）。
- Python（仅打包与文档生成脚本用）：Python 3.13 + `python-docx`。
- 约定：所有脚本/命令统一从 GAME-APP.md 读取路径，不硬编码到别处；路径失效时先 ls versions/ 目录确认真实版本目录名

## 调参指南（v0.7.0 起：数值与逻辑分离）

### 两个配置文件（唯一数据源，改这里即生效）
| 文件 | 管什么 |
|---|---|
| `config/tuning.json` | **平衡数值**：物理/玩家/战斗/SCAV/搜索距离/客户端表现 |
| `config/content.json` | **内容表**：武器、弹药、改装件、战利品、掉落池、容器、撤离点、商人货表 |
| `maps/factory.json` | **地图**：体素方块布局 |

### 改配置的生效流程
- **客户端表现**（后坐/灵敏度/FOV/分辨率）：改 JSON → **刷新页面** 即生效
- **逻辑层数值**（物理/SCAV/战斗/内容表）：改 JSON → `curl -X POST http://localhost:9090/api/reload-config`（或重启服务器）→ 刷新页面
- 查询当前生效配置：`curl http://localhost:9090/api/config`

### 常用调参速查
| 想改什么 | 改哪个字段 |
|---|---|
| 玩家跑得更快 | `tuning.physics.speed` |
| 跳得更高 | `tuning.physics.jumpV` |
| SCAV 更弱/更强 | `tuning.scav.hp` / `hitChanceBase`（命中率） / `fireCooldownMs`（射速） |
| SCAV 反应更快 | `tuning.scav.alertDelayMs`（越小越快，0 = 发现即开枪） |
| SCAV 数量 | `tuning.scav.count` |
| SCAV 视野/听觉 | `tuning.scav.visionRange` / `hearingRangeGunshot` |
| SCAV 掉枪概率 | `tuning.scav.weaponPool.ak74`（0.3 = 30% 拿 AK） |
| 后坐力更强 | `tuning.client.recoil.pitchPerShot` |
| 鼠标灵敏度 | `tuning.client.mouseSensitivity` |
| 换弹更快 | `tuning.combat.reloadMs` |
| 枪的伤害/射速 | `content.weapons.ak74.dmg` / `.fireRate` |
| 哪把枪能刷出来 | `content.loot.w_ak74` 是否存在于 `content.lootPool.rare` |
| 弹药箱给多少发 | `content.loot.ammo_box_545.ammo.count` |
| 容器位置 | `content.containers[].x/z` |
| 撤离点位置/倒计时 | `content.extracts[].x/z` / `.duration` |
| 背包容量 | `tuning.player.invCap` |

### 架构约定（新增参数必须遵守）
1. **禁止硬编码可调数值**：新参数一律加到 `tuning.json` / `content.json`，代码从 `CFG.<分组>.<字段>` 读取，并带 `|| 默认值` 兜底
2. **默认值三层**：`config/*.json`（权威）→ `shared/config.js` 的 DEFAULTS（兜底）→ 代码内 `|| fallback`（最后防线）；配置文件缺失/损坏时引擎仍可运行
3. **数据一致性**：同一条目在多处出现时必须一致（如 `weapons.ak74` 与 `loot.w_ak74` 的 dmg/fireRate/magSize）——`test/config.test.js` 已加自动校验，防 E017 类不一致复发
4. **不硬编码加载顺序**：`index.html` 的脚本顺序固定为 `tuning → content → config → map → core → sim → items → storage → bt`（config 必须在 core/items 之前）

## 联机同步架构（v0.8.0 / E021，禁止回退到 EMA 掩盖方案）
- **核心：预测-和解（rollback & replay）**，不是"平滑掩盖"
  1. 客户端 60Hz 步进：生成输入 → **立即本地预测一步** → 发送 → 存进待确认队列（`pendingInputs`）
  2. 服务器按**输入队列逐步消费**（每输入 = 一步，单 tick 上限 4 步），快照回传 `lastSeq`（已消费序号）+ `vy`
  3. 客户端收快照：丢弃已确认输入 → **回滚**到服务器权威状态 → **重放**未确认输入 → 预测自洽，偏差趋近 0
- **三条铁律**：
  1. **1 输入 = 1 步**：客户端的"预测 / 发送 / 入队"必须用同一个输入对象（同一 seq）；服务器必须按队列逐步消费。任何"状态式覆盖"都会破坏对称性 → 偏差 → 闪回
  2. **禁止 EMA / 阈值硬校正**（旧方案，会瞬移）：偏差应通过重放自然收敛
  3. **预测与服务器共用同款语义**（`shared/predict.js` 的 step 与 `sim.stepPlayer` 必须一致：滑动物理/碰撞/台阶/落地吸附/跳跃）
- **验收指标**（RVP A5d，程序化，每局必测）：`maxCorrection < 1.0m` 且 `反向跳变 ≤ 2 次`（当前实测 0.204m / 1 次）
- **诊断入口**：浏览器控制台 `window.__lastReconcile` / `window.__maxCorrection`

---

## v0.15.0（2026-09-30 · 接手团队）变更摘要

- **版本号单一数据源**：`package.json.version` 为唯一权威；`server/server.js` require 读取；`public/index.html` 三处用 `{{VERSION}}` 占位，由服务器对 `/`、`/index.html` 现场注入（不缓存）。
- **护甲/穿透/命中部位**（新系统）：`content.json` 的 `ammo[口径]` 带 `dmg`/`pen`，护具带 `armorClass`/`dur`/`cover`；`sim.js` 按「头/胸」部位 + 护甲等级与穿深结算减伤与耐久消耗。配置项在 `tuning.combat`。
- **联机事件归属**：客户端联机分支改本地状态前**必须**判 `m.id === myId`（G7 串台已修复；回归脚本 本地验收脚本 `verify_g7_crosstalk.js`）。
- **联机携带链**：进图携带统一走 `Items.takeCarryFromContainers(profile)`（单机与联机一致），调用后必须落盘。
- **快捷使用**：协议 `{type:"quickUse", index}`，仅 `src === "rig"` 放行；`useItem` 语义不变。
- **打包链**：构建脚本根目录改为 `EXFIL_SRC` / `EXFIL_DIST` / `EXFIL_NODE`（默认=脚本所在仓库）；`build_demo_package.js` 与 `verify_demo_package.js` 均带**逐文件 sha256「源码 ↔ 包内」校验**，不一致即失败（E049）。
- **验收基础设施**：新增 本地验收脚本 `assert-ports-free.js`（fail-open 端口守卫），验收脚本/探针全覆盖；`PORT`/`CDP_PORT` 支持环境变量覆盖。
- 缺陷台账新增 **E049–E052**；勿回退清单见 开发期长期记忆 第十八节。

---

## 过程档案说明

本项目的开发过程档案（错误台账 `E001–E053`、长期记忆、协作板、诊断探针、浏览器验收脚本、验收截图）
保存在**本地开发副本**中，**未随本仓库公开**。因此源码注释里出现的 `E0xx` 编号是历史缺陷编号，
对应条目不在本仓库内。
