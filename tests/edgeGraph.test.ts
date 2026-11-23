import test from 'node:test';
import assert from 'node:assert/strict';
import { getReactiveTargetNodeIds } from '../src/core/edgeGraph.ts';
import type { BlueprintEdge } from '../src/core/types.ts';

function makeEdge(
  id: string,
  source: string,
  target: string,
  bidirectional = false
): BlueprintEdge {
  return { id, source, target, bidirectional, rev: 1, cid: 't' };
}

test('getReactiveTargetNodeIds() follows directed edges only forward', () => {
  const edges = {
    e1: makeEdge('e1', 'A', 'B', false),
    e2: makeEdge('e2', 'A', 'C', false),
  };
  assert.deepEqual(getReactiveTargetNodeIds(edges, 'A').sort(), ['B', 'C']);
  assert.deepEqual(getReactiveTargetNodeIds(edges, 'B'), []);
});

test('getReactiveTargetNodeIds() follows bidirectional edges in both directions and deduplicates', () => {
  const edges = {
    e1: makeEdge('e1', 'A', 'B', true),
    e2: makeEdge('e2', 'A', 'B', false), // 重复边应去重
    e3: makeEdge('e3', 'A', 'A', true),  // 自环应排除
  };
  assert.deepEqual(getReactiveTargetNodeIds(edges, 'A'), ['B']);
  assert.deepEqual(getReactiveTargetNodeIds(edges, 'B'), ['A']);
});

test('getReactiveTargetNodeIds() respects visited set to prevent bidirectional ping-pong loops', () => {
  const edges = {
    e1: makeEdge('e1', 'A', 'B', true),
    e2: makeEdge('e2', 'B', 'C', true),
  };
  assert.deepEqual(getReactiveTargetNodeIds(edges, 'B', new Set(['A'])), ['C']);
});
