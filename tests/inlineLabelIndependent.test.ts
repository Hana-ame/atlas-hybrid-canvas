/**
 * @file inlineLabelIndependent.test.ts
 * @description v96（连线标签画布内联编辑 + 控制手柄事件隔离）的独立测试。
 *
 * 不复用 tests/uiComponents.test.ts 的「字符串出现即可」口径，改为：
 * 1. 用固定几何 (0,0)→(400,200) 手算弧长中点 (200,100)，断言「+」手柄因与标签重合
 *    被下移到 (200,122)；无标签时必须仍在 (200,100)——正反两面都断言，避免恒真。
 * 2. 断言编辑态下「+」手柄整体消失，但 SVG 路径与控制点手柄仍保留。
 * 3. 逐个断言 pointer-events 归属：控制手柄 all / 外发光 none / 「+」内十字 none /
 *    起点实心圆 none——防止画布拖拽吞掉控制点操作。
 * 4. EdgeLabelRenderer 在 SSR（仅 ReactFlowProvider、无 ReactFlow domNode）下返回 null，
 *    输入框本身无法从静态标记断言，故对源码做定点守护：无原生 prompt/alert、IME 组合期
 *    不提交、Enter/Blur/Escape 三分支齐全，以及 App 侧「先归一化比对再压撤销栈」的顺序。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { ControllableEdge } from '../src/canvas/ControllableEdge.tsx';

interface RenderOpts {
  label?: string;
  cps?: Array<{ x: number; y: number }>;
  editing?: boolean;
  selected?: boolean;
  writable?: boolean;
  markerStart?: string;
}

function renderEdge(opts: RenderOpts = {}): string {
  const {
    label,
    cps = [],
    editing = false,
    selected = true,
    writable = true,
    markerStart,
  } = opts;
  return renderToStaticMarkup(
    React.createElement(
      ReactFlowProvider,
      null,
      React.createElement(
        'svg',
        null,
        React.createElement(ControllableEdge, {
          id: 'edge-independent-v96',
          source: 'n1',
          target: 'n2',
          sourceX: 0,
          sourceY: 0,
          targetX: 400,
          targetY: 200,
          sourcePosition: 'right',
          targetPosition: 'left',
          selected,
          label,
          markerStart,
          style: { stroke: '#DC2626' },
          data: {
            controlPoints: cps.length > 0 ? cps : undefined,
            isEditingLabel: editing,
            ...(writable ? { onUpdateControlPoints: () => {} } : {}),
          },
        } as any)
      )
    )
  );
}

test('独立①：「+」手柄在标签胶囊处下移 22px，无标签时留在曲线中点', () => {
  // 无控制点：dx = max(48, 400*0.45) = 180；B(0.5) = (200,100)，
  // 与 segmentMidpoints[0] 完全重合，必然触发 LABEL_COLLISION_RADIUS_PX = 28 的避让。
  const labeled = renderEdge({ label: 'rate' });
  assert.ok(labeled.includes('translate(200, 122)'), '有标签时「+」手柄应下移到 y=122');
  assert.equal(labeled.includes('translate(200, 100)'), false, '有标签时不应留在重合位置 y=100');

  const plain = renderEdge();
  assert.ok(plain.includes('translate(200, 100)'), '无标签时「+」手柄应仍在曲线中点');
  assert.equal(plain.includes('translate(200, 122)'), false, '无标签时不应发生避让');

  // 编辑态下「+」手柄整体隐藏，避免输入框下方残留可点区域
  const editing = renderEdge({ label: 'rate', editing: true });
  assert.equal(editing.includes('stroke-dasharray="2 1.5"'), false);
  assert.equal(editing.includes('edge-control-handle'), false);
});

test('独立②：编辑态仍保留既有控制点手柄与连线路径', () => {
  const cps = [{ x: 250, y: 40 }];
  const editing = renderEdge({ label: 'rate', cps, editing: true });
  assert.ok(editing.includes('translate(250, 40)'), '编辑标签不应抹掉已落盘的控制点手柄');
  assert.ok(editing.includes('edge-control-handle'), '保留的控制点手柄仍须带 nodrag nopan 类');
  assert.ok(editing.includes('250.0 40.0'), '连线样条仍须穿过控制点');
});

test('独立③：pointer-events 按命中优先级分层，且起点圆不抢双向箭头', () => {
  const html = renderEdge({ label: 'rate', cps: [{ x: 250, y: 40 }] });

  assert.ok(html.includes('nodrag nopan edge-control-handle'));
  assert.ok(html.includes('touch-action:none'), '手柄须禁用 touch-action 防止移动端拖画布');
  assert.ok(html.includes('pointer-events:all'), '手柄 style 须显式 pointer-events:all');
  assert.ok(html.includes('pointer-events="all"'), '手柄 SVG 属性须显式 pointer-events="all"');

  const glow = html.match(/<path[^>]*stroke-opacity="0\.22"[^>]*>/);
  assert.ok(glow, '选中态应渲染外发光');
  assert.ok(glow[0].includes('pointer-events="none"'), '外发光不得抢命中');

  const cross = html.match(/<path[^>]*d="M -2\.5 0 L 2\.5 0 M 0 -2\.5 L 0 2\.5"[^>]*>/);
  assert.ok(cross, '应渲染「+」内十字');
  assert.ok(cross[0].includes('pointer-events="none"'), '内十字不得抢命中，应由外层圆承担');

  const origin = html.match(/<circle[^>]*cx="0"[^>]*cy="0"[^>]*>/);
  assert.ok(origin, '单向连线应绘制起点实心圆');
  assert.ok(origin[0].includes('pointer-events="none"'), '起点圆不得抢命中');

  const bidirectional = renderEdge({ markerStart: 'url(#arrow-start)' });
  assert.equal(bidirectional.includes('cx="0" cy="0"'), false, '双向连线有起头箭头时不应重复画实心圆');
});

test('独立④：只读连线保留控制点展示但关闭拖拽与「+」插入', () => {
  const html = renderEdge({ cps: [{ x: 250, y: 40 }], writable: false });
  assert.ok(html.includes('<title>路径控制点</title>'), '只读态仍展示已落盘控制点');
  assert.ok(html.includes('cursor:default'), '只读态手柄不得显示 grab 光标');
  assert.equal(html.includes('stroke-dasharray="2 1.5"'), false, '只读态不应出现「+」插入手柄');
  assert.ok(html.includes('250.0 40.0'), '但仍须按控制点绘制样条');
});

test('独立⑤：源码级守护——无原生弹窗、IME 组合期不提交、提交前先比对', () => {
  const edgeSrc = fs.readFileSync(new URL('../src/canvas/ControllableEdge.tsx', import.meta.url), 'utf8');
  const appSrc = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

  // 文件头注释里会出现「绝不调用 window.alert / window.prompt」这段说明，
  // 因此只匹配真正的调用形态 window.prompt( / window.alert(，避免把注释当代码。
  assert.equal(/window\.prompt\s*\(/.test(edgeSrc), false, '组件不得调用 window.prompt');
  assert.equal(/window\.alert\s*\(/.test(edgeSrc), false, '组件不得调用 window.alert');
  assert.ok(edgeSrc.includes('aria-label="编辑连线标签"'), '输入框须有无障碍名称');
  assert.ok(edgeSrc.includes('nativeEvent.isComposing'), '中文输入法组合期必须忽略 Enter');
  assert.ok(edgeSrc.includes('onBlur={commitInlineLabel}'), '失焦须提交');
  assert.ok(edgeSrc.includes("ev.key === 'Enter'"), 'Enter 须提交');
  assert.ok(edgeSrc.includes("ev.key === 'Escape'"), 'Escape 须取消');
  assert.ok(edgeSrc.includes('editClosedRef.current'), '须有一次性关闭标志防止 blur/Enter 双提交');

  assert.equal(appSrc.includes("window.prompt('修改连线标签"), false, 'App 侧不得再弹原生输入框');
  assert.ok(appSrc.includes('setEditingEdgeLabelId(edgeId)'), 'App 须驱动内联编辑态');
  const fnAt = appSrc.indexOf('const handleCommitEdgeLabel');
  assert.ok(fnAt > 0);
  const normalizedAt = appSrc.indexOf('const normalized', fnAt);
  const pushAt = appSrc.indexOf('pushHistory()', fnAt);
  assert.ok(normalizedAt > 0 && pushAt > normalizedAt, '必须先归一化比对，相等时不得压撤销栈');
});
