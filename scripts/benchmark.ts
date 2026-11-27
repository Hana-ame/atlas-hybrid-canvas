/**
 * @file benchmark.ts
 * @description 可复现的画布空间索引、视口裁剪与蓝图序列化基准脚本（1,000 / 3,000 / 5,000 节点）。
 */

import { ChunkManager } from '../src/core/chunkManager';
import { computeThreeRingBounds, filterVisibleEdges } from '../src/core/viewportCulling';
import { summarizeBlueprintForAgent } from '../src/core/agentOps';
import type { BaseBlueprint, BlueprintEdge, BlueprintNode } from '../src/core/types';

function generateSyntheticBlueprint(nodeCount: number): BaseBlueprint {
  const nodes: Record<string, BlueprintNode> = {};
  const edges: Record<string, BlueprintEdge> = {};
  const cols = Math.ceil(Math.sqrt(nodeCount));

  for (let i = 0; i < nodeCount; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const id = `bench-n-${i}`;
    nodes[id] = {
      id,
      title: `Node #${i}`,
      body: `Benchmark synthetic node ${i} at (${col}, ${row})`,
      category: 'Bench',
      color: '#2563EB',
      x: col * 360,
      y: row * 240,
      width: 280,
      height: 160,
      defaultVars: { index: i, active: true },
      buttons: [],
      rev: 1,
      cid: 'bench',
    };
    if (i > 0 && col > 0) {
      const eid = `bench-e-${i}`;
      edges[eid] = {
        id: eid,
        source: `bench-n-${i - 1}`,
        target: id,
        pathType: 'smooth',
        strokeStyle: 'solid',
        rev: 1,
        cid: 'bench',
      };
    }
  }

  return {
    version: 1,
    chunkSize: 512,
    nodes,
    annotations: {},
    edges,
  };
}

function runScenario(nodeCount: number) {
  const bp = generateSyntheticBlueprint(nodeCount);
  const jsonBytes = Buffer.byteLength(JSON.stringify(bp), 'utf8');

  const cm = new ChunkManager(512);
  const tRebuild0 = performance.now();
  cm.rebuild(bp.nodes, bp.annotations);
  const rebuildMs = performance.now() - tRebuild0;

  // 1920x1080 近景视口（zoom = 1.0）
  const microViewport = { minX: 0, minY: 0, maxX: 1920, maxY: 1080 };
  const ring = computeThreeRingBounds(microViewport, 512, 1, 0);

  const queryIterations = 1000;
  const tQuery0 = performance.now();
  let mountedNodeCount = 0;
  let visibleEdgeCount = 0;
  for (let i = 0; i < queryIterations; i++) {
    const chunks = cm.queryVisibleChunks(ring.domPreloadBounds);
    const idSet = new Set<string>();
    for (const c of chunks) {
      for (const nid of c.nodeIds) idSet.add(nid);
    }
    const visEdges = filterVisibleEdges(bp.edges, idSet);
    if (i === 0) {
      mountedNodeCount = idSet.size;
      visibleEdgeCount = visEdges.length;
    }
  }
  const queryAvgMs = (performance.now() - tQuery0) / queryIterations;

  // 单节点局部变更后增量 rebuild（验证签名跳过未变区块）
  bp.nodes['bench-n-0'] = { ...bp.nodes['bench-n-0'], title: 'Node #0 Updated' };
  const tInc0 = performance.now();
  cm.rebuild(bp.nodes, bp.annotations);
  const incRebuildMs = performance.now() - tInc0;

  const tSum0 = performance.now();
  const summary = summarizeBlueprintForAgent(bp);
  const summaryMs = performance.now() - tSum0;
  const summaryBytes = Buffer.byteLength(JSON.stringify(summary), 'utf8');

  const rssMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);

  return {
    nodeCount,
    edgeCount: Object.keys(bp.edges).length,
    totalChunks: cm.getTotalChunks(),
    microMountedDomNodes: mountedNodeCount,
    microVisibleEdges: visibleEdgeCount,
    macroMountedDomNodes: 0,
    rebuildMs: Number(rebuildMs.toFixed(2)),
    incRebuildMs: Number(incRebuildMs.toFixed(2)),
    queryAndEdgeCullAvgMs: Number(queryAvgMs.toFixed(3)),
    agentSummaryMs: Number(summaryMs.toFixed(2)),
    blueprintJsonKB: Number((jsonBytes / 1024).toFixed(1)),
    agentSummaryKB: Number((summaryBytes / 1024).toFixed(1)),
    processRssMB: Number(rssMb),
  };
}

const results = [1000, 3000, 5000].map(runScenario);
console.log(JSON.stringify(results, null, 2));
