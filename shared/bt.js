'use strict';
(function () {
  /*
   * EXFIL ZONE · shared/bt.js — 行为树迷你框架（IIFE 双兼容）
   * 纯函数式节点：每 tick 全量评估，返回 'success' | 'failure'
   * （M2 无 running 态——SCAV 用 state 字段驱动长时行为，树做决策分派）
   */
  // 顺序节点：全部成功才成功，遇失败/非 success 短路
  function Sequence(...children) {
    return (ctx) => {
      for (const c of children) {
        const s = c(ctx);
        if (s !== 'success') return s;
      }
      return 'success';
    };
  }
  // 选择节点：任一成功即成功，全部失败才失败
  function Selector(...children) {
    return (ctx) => {
      for (const c of children) {
        const s = c(ctx);
        if (s !== 'failure') return s;
      }
      return 'failure';
    };
  }
  // 条件节点：fn(ctx) 真值 → success
  function Condition(fn) {
    return (ctx) => (fn(ctx) ? 'success' : 'failure');
  }
  // 动作节点：fn(ctx) 返回 false → failure，其余 → success（true/undefined 均成功）
  function Action(fn) {
    return (ctx) => (fn(ctx) === false ? 'failure' : 'success');
  }
  // 取反
  function Invert(node) {
    return (ctx) => (node(ctx) === 'success' ? 'failure' : 'success');
  }
  // 打印调试（开发辅助）
  function debug(node, label) {
    return (ctx) => {
      const s = node(ctx);
      if (ctx.debug && ctx.debug.includes(label)) console.log(`[BT:${label}] -> ${s}`);
      return s;
    };
  }

  const BT = { Sequence, Selector, Condition, Action, Invert, debug };
  if (typeof module !== 'undefined' && module.exports) module.exports = BT;
  if (typeof window !== 'undefined') window.EXFIL_BT = BT;
})();
