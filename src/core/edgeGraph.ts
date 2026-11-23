/**
 * @file edgeGraph.ts
 * @description 连线图遍历与双向连线（bidirectional）邻居解析纯函数：
 * - 单向边：仅沿 source -> target 通知下游；
 * - 双向边（bidirectional: true）：source 与 target 互为对端，任一端变更都可通知另一端；
 * - 内置去重与排除自身，配合外层传播深度限制防止 A <-> B 无限 ping-pong。
 */

import type { BlueprintEdge } from './types';

/** 获取某节点变更时需要联动刷新的对端节点 ID 列表（含单向下游与双向边对端，已去重且不含自身）。 */
export function getReactiveTargetNodeIds(
  edges: Record<string, BlueprintEdge>,
  sourceNodeId: string,
  visited?: ReadonlySet<string>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const edge of Object.values(edges)) {
    let targetId: string | null = null;
    if (edge.source === sourceNodeId && edge.target !== sourceNodeId) {
      targetId = edge.target;
    } else if (edge.bidirectional && edge.target === sourceNodeId && edge.source !== sourceNodeId) {
      targetId = edge.source;
    }
    if (!targetId) continue;
    if (visited?.has(targetId)) continue;
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    out.push(targetId);
  }
  return out;
}
