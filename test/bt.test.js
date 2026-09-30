'use strict';
const test = require('node:test');
const assert = require('node:assert');
const BT = require('../shared/bt');

test('BT: Sequence 全部成功才 success', () => {
  const tree = BT.Sequence(
    BT.Condition(() => true),
    BT.Action(() => true)
  );
  assert.equal(tree({}), 'success');
});
test('BT: Sequence 遇 failure 短路', () => {
  let ran = false;
  const tree = BT.Sequence(
    BT.Condition(() => false),
    BT.Action(() => { ran = true; return true; })
  );
  assert.equal(tree({}), 'failure');
  assert.equal(ran, false, '短路后动作不应执行');
});
test('BT: Selector 任一 success 即成功', () => {
  const tree = BT.Selector(
    BT.Condition(() => false),
    BT.Condition(() => true)
  );
  assert.equal(tree({}), 'success');
});
test('BT: Selector 全 failure 才 failure', () => {
  const tree = BT.Selector(
    BT.Condition(() => false),
    BT.Condition(() => false)
  );
  assert.equal(tree({}), 'failure');
});
test('BT: Action 返回 false → failure', () => {
  const tree = BT.Action(() => false);
  assert.equal(tree({}), 'failure');
});
test('BT: Invert 反转结果', () => {
  assert.equal(BT.Invert(BT.Condition(() => true))({}), 'failure');
  assert.equal(BT.Invert(BT.Condition(() => false))({}), 'success');
});
test('BT: ctx 上下文传递', () => {
  const tree = BT.Sequence(
    BT.Condition(ctx => ctx.hp > 0),
    BT.Action(ctx => { ctx.hits = (ctx.hits || 0) + 1; return true; })
  );
  const ctx = { hp: 50 };
  tree(ctx);
  assert.equal(ctx.hits, 1);
});
