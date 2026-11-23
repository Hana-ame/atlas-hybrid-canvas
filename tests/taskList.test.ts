import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskLine, toggleTaskLine, formatTaskTextForCanvas } from '../src/core/taskList.ts';

test('parseTaskLine() supports - [], - [ ], - [x], - [X], and indented subtasks', () => {
  assert.deepEqual(parseTaskLine('- [] 紧凑写法'), { indent: '', marker: '- ', checked: false, label: '紧凑写法' });
  assert.deepEqual(parseTaskLine('- [ ] 标准待办'), { indent: '', marker: '- ', checked: false, label: '标准待办' });
  assert.deepEqual(parseTaskLine('  * [x] 子任务'), { indent: '  ', marker: '* ', checked: true, label: '子任务' });
  assert.deepEqual(parseTaskLine('+ [X] 大写完成'), { indent: '', marker: '+ ', checked: true, label: '大写完成' });
  assert.equal(parseTaskLine('普通文本行'), null);
});

test('toggleTaskLine() flips only the targeted line and preserves indentation', () => {
  const src = '- [] 第一项\n  - [x] 子项\n普通行';
  const step1 = toggleTaskLine(src, 0);
  assert.equal(step1, '- [x] 第一项\n  - [x] 子项\n普通行');
  const step2 = toggleTaskLine(step1, 1);
  assert.equal(step2, '- [x] 第一项\n  - [ ] 子项\n普通行');
});

test('formatTaskTextForCanvas() renders crisp ☐ and ☑ symbols', () => {
  const out = formatTaskTextForCanvas('- [] 未完成\n- [x] 已完成\n普通行');
  assert.equal(out, '☐ 未完成\n☑ 已完成\n普通行');
});
