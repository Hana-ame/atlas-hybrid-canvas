import type { BaseBlueprint, BlueprintNode, CanvasAnnotation } from './types';

export function createSeedBlueprint(): BaseBlueprint {
  const nodes: Record<string, BlueprintNode> = {
    'node-world-hub': {
      id: 'node-world-hub',
      x: 80,
      y: 120,
      width: 300,
      height: 190,
      title: '核心架构枢纽（Chunk 0,0）',
      body: '点下方按钮可在隔离 Web Worker 中运行脚本；产生的 vars 只存在你的本地叠加层，不会污染后端默认值。',
      category: 'CORE',
      color: '#1D4ED8',
      defaultVars: { visits: 1, stage: 'alpha' },
      buttons: [
        {
          id: 'btn-inc',
          label: '本地计数 +1 (Worker)',
          variant: 'primary',
          actionType: 'script',
          code: `lib.inc('visits', 1);
vars.lastRun = lib.now();
log('本地计数已更新为', vars.visits);`,
        },
        {
          id: 'btn-proxy',
          label: '经服务端代理测试 GET',
          variant: 'secondary',
          actionType: 'proxy_http',
          proxyUrl: 'https://httpbin.org/get?source=atlas-hybrid',
          proxyMethod: 'GET',
        },
      ],
      rev: 1,
      cid: 'server-base',
    },
    'node-lore-north': {
      id: 'node-lore-north',
      x: 560,
      y: 120,
      width: 280,
      height: 175,
      title: '世界观设定模块（Chunk 1,0）',
      body: '在近景下这是完整的 React DOM 节点；把滚轮缩远到 32% 以下，会自动无缝切给底层 512×512 离屏瓦片绘制。',
      category: 'LORE',
      color: '#0F766E',
      defaultVars: { chapters: 12, status: 'reviewing' },
      buttons: [
        {
          id: 'btn-approve',
          label: '本地标记审阅通过',
          variant: 'success',
          actionType: 'script',
          code: `vars.status = 'approved';
vars.checkedAt = lib.now();`,
        },
      ],
      rev: 1,
      cid: 'server-base',
    },
    'node-ops-south': {
      id: 'node-ops-south',
      x: 240,
      y: 580,
      width: 290,
      height: 170,
      title: '跨分区节点（Chunk 0,1）',
      body: '拖拽修改位置或文字只会写入你的个人本地补丁；点击顶栏「重置本地状态」可随时恢复后端默认蓝图。',
      category: 'OPS',
      color: '#B45309',
      defaultVars: { load: 0.42 },
      buttons: [
        {
          id: 'btn-spike',
          label: '模拟负载 +0.1',
          variant: 'danger',
          actionType: 'script',
          code: `lib.inc('load', 0.1);`,
        },
      ],
      rev: 1,
      cid: 'server-base',
    },
  };

  const annotations: Record<string, CanvasAnnotation> = {
    'ann-zone-0': {
      id: 'ann-zone-0',
      x: 40,
      y: 36,
      width: 440,
      text: 'ZONE A · 核心设计区（不可交互背景注释，鼠标点击直接穿透）',
      fontSize: 18,
      color: '#475569',
      weight: 'bold',
      nonInteractive: true,
      rev: 1,
      cid: 'server-base',
    },
    'ann-zone-1': {
      id: 'ann-zone-1',
      x: 540,
      y: 36,
      width: 420,
      text: 'ZONE B · 知识地图与世界观分支（直接烘焙进静态离屏瓦片）',
      fontSize: 18,
      color: '#0F766E',
      weight: 'bold',
      nonInteractive: true,
      rev: 1,
      cid: 'server-base',
    },
    'ann-zone-2': {
      id: 'ann-zone-2',
      x: 40,
      y: 525,
      width: 460,
      text: 'ZONE C · 跨 Chunk 下游区 — 滚轮缩远至 < 32% 观察混合瓦片接管',
      fontSize: 15,
      color: '#64748B',
      weight: 'normal',
      nonInteractive: true,
      rev: 1,
      cid: 'server-base',
    },
  };

  return {
    version: 1,
    chunkSize: 512,
    nodes,
    annotations,
    edges: {
      'edge-hub-lore': {
        id: 'edge-hub-lore',
        source: 'node-world-hub',
        target: 'node-lore-north',
        label: '引用设定',
        color: '#2563EB',
        rev: 1,
        cid: 'server-base',
      },
      'edge-hub-ops': {
        id: 'edge-hub-ops',
        source: 'node-world-hub',
        target: 'node-ops-south',
        label: '跨 Chunk 联动',
        color: '#0F766E',
        dashed: true,
        rev: 1,
        cid: 'server-base',
      },
    },
  };
}

/**
 * 压力测试生成器：在 4x4 个 512x512 分区中铺入 400 个蓝图节点与 16 条区域大标题注释
 * 方便直观体验：近景只挂可见区 DOM、缩远至 < 32% 全切 Canvas 瓦片 60 FPS 漫游
 */
export function spawnStressChunks(base: BaseBlueprint): BaseBlueprint {
  const palette = ['#2563EB', '#0F766E', '#B45309', '#7C3AED', '#BE123C'];
  const nextNodes = { ...base.nodes };
  const nextAnns = { ...base.annotations };

  for (let cy = -2; cy <= 1; cy++) {
    for (let cx = -2; cx <= 1; cx++) {
      if (cx === 0 && cy === 0) continue;
      const annId = `stress-ann-${cx}-${cy}`;
      nextAnns[annId] = {
        id: annId,
        x: cx * 512 + 16,
        y: cy * 512 + 16,
        width: 460,
        text: `SECTOR (${cx}, ${cy}) · 压测分区背景注释`,
        fontSize: 16,
        color: '#475569',
        weight: 'bold',
        nonInteractive: true,
        rev: 1,
        cid: 'stress',
      };

      for (let i = 0; i < 24; i++) {
        const col = i % 4;
        const row = Math.floor(i / 4);
        const id = `stress-${cx}-${cy}-${i}`;
        nextNodes[id] = {
          id,
          x: cx * 512 + 18 + col * 120,
          y: cy * 512 + 48 + row * 74,
          width: 110,
          height: 62,
          title: `节点 ${cx},${cy}#${i + 1}`,
          body: 'Chunk 压测卡片',
          category: '压测',
          color: palette[(Math.abs(cx + cy) + i) % palette.length],
          defaultVars: { idx: i + 1 },
          rev: 1,
          cid: 'stress',
        };
      }
    }
  }

  return {
    ...base,
    version: base.version + 1,
    nodes: nextNodes,
    annotations: nextAnns,
  };
}
