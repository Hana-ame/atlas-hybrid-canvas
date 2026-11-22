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
          id: 'btn-bg-cycle',
          label: '切换 ZONE A 背景色',
          variant: 'success',
          actionType: 'script',
          code: `const colors = ['#DBEAFE', '#CCFBF1', '#FEF3C7', '#FCE7F3', '#EDE9FE'];
const idx = (lib.inc('bgIdx', 1) - 1) % colors.length;
canvas.setAnnotationBg('ann-zone-0', colors[idx], 0.9);
log('已切换 ZONE A 背景色块为', colors[idx]);`,
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
    'example-spawner': {
      id: 'example-spawner',
      x: 560,
      y: 350,
      width: 420,
      height: 235,
      title: '示例：一键创建并联动控件',
      body: '',
      category: '联动',
      color: '#2563EB',
      defaultVars: { spawnedCount: 0, lastChildId: '', draft: '', statusLine: '' },
      script: `const spawned = Number(vars.spawnedCount) || 0;
const latestId = vars.lastChildId || '';
const latestPeer = latestId ? widgets.get(latestId) : null;
const headerText = latestPeer
  ? '已创建 ' + spawned + ' 个子控件 · 最新：' + latestPeer.title + '（分数=' + (latestPeer.vars.score ?? 0) + '）'
  : '① 点「+ 创建子控件」在右侧自动生成并连线  ② 输入消息按回车联动';

vars.contents = [
  { type: 'text', text: headerText, align: 'center', color: '#1E40AF', fontSize: 12, bold: true },
  [
    { type: 'button', id: 'spawn', label: '+ 创建子控件', variant: 'primary' },
    { type: 'button', id: 'readChild', label: '读子控件变量', variant: 'secondary' }
  ],
  [
    { type: 'input', id: 'msgInput', bind: 'draft', placeholder: '输入消息发给最新子控件（回车发送）...' },
    { type: 'button', id: 'send', label: '发送', width: 68, variant: 'success' }
  ],
  { type: 'text', text: vars.statusLine || '提示：点右上角 ⚙ 可查看完整 widgets.create / emit / onSubmit 源码', fontSize: 11, color: '#475569' }
];

on('spawn', async () => {
  const n = spawned + 1;
  const palette = ['#059669', '#D97706', '#7C3AED', '#DC2626', '#2563EB'];
  const color = palette[(n - 1) % palette.length];
  const childScript = [
    'const score = Number(vars.score) || 0;',
    'const inbox = vars.inbox || "等待主控件发来消息...";',
    'vars.contents = [',
    '  { type: "text", text: "分数：" + score + " · 来自主控件创建", align: "center", color: "' + color + '", fontSize: 12.5, bold: true },',
    '  { type: "text", text: inbox, fontSize: 11.5, color: "#334155" },',
    '  [',
    '    { type: "button", id: "addScore", label: "分数 +10", variant: "primary" },',
    '    { type: "button", id: "reply", label: "回复主控件", variant: "secondary" }',
    '  ]',
    '];',
    'on("addScore", async () => {',
    '  vars.score = score + 10;',
    '  if (vars.parentId) await emit(vars.parentId, "childReply", { text: ctx.entity.title + " 分数变为 " + vars.score, score: vars.score });',
    '});',
    'on("reply", async () => {',
    '  if (vars.parentId) await emit(vars.parentId, "childReply", { text: "收到！我是 " + ctx.entity.title + "，当前分数=" + score, score });',
    '});',
    'on("ping", (msg, meta) => {',
    '  const txt = msg && msg.text ? msg.text : String(msg || "");',
    '  vars.inbox = "收到[" + meta.fromTitle + "]：" + txt;',
    '});'
  ].join('\n');

  const res = await widgets.create({
    title: '子控件 #' + n,
    dx: 470,
    dy: (n - 1) * 195,
    w: 320,
    h: 175,
    color,
    connect: '联动 #' + n,
    vars: { parentId: ctx.entity.id, seq: n, score: n * 10, inbox: '等待主控件发来消息...' },
    script: childScript
  });
  if (res.ok && res.id) {
    vars.spawnedCount = n;
    vars.lastChildId = res.id;
    vars.statusLine = '已在右侧创建「' + res.title + '」并连线，试着输入消息发给它！';
  }
});

async function sendMessage(rawText) {
  if (!vars.lastChildId) {
    vars.statusLine = '请先点一次「+ 创建子控件」，再给它发消息';
    return;
  }
  const text = String(rawText ?? vars.draft ?? '').trim();
  if (!text) {
    vars.statusLine = '请先在输入框输入要发送的内容';
    return;
  }
  const res = await emit(vars.lastChildId, 'ping', { text });
  vars.draft = '';
  vars.statusLine = res.ok ? '已发送到 ' + vars.lastChildId + '：' + text : '发送失败：' + (res.error || '目标不存在');
}

on('send', async () => { await sendMessage(vars.draft); });
onSubmit('msgInput', async (val) => { await sendMessage(val); });

on('readChild', () => {
  if (!vars.lastChildId) {
    vars.statusLine = '请先点一次「+ 创建子控件」';
    return;
  }
  const childVars = widgets.vars(vars.lastChildId);
  vars.statusLine = '读取到 ' + vars.lastChildId + '：score=' + (childVars.score ?? 0) + ' · inbox=' + (childVars.inbox ?? '-');
});

on('childReply', (msg) => {
  vars.statusLine = '子控件回信：' + (msg && msg.text ? msg.text : JSON.stringify(msg));
});`,
      rev: 1,
      cid: 'server-base',
    },
  };

  const annotations: Record<string, CanvasAnnotation> = {
    'ann-zone-0': {
      id: 'ann-zone-0',
      kind: 'text',
      x: 40,
      y: 28,
      width: 440,
      height: 56,
      text: 'ZONE A · 核心设计区（带色块背景，可被下方控件按钮变色）',
      fontSize: 16,
      color: '#1E3A8A',
      bgColor: '#DBEAFE',
      bgOpacity: 0.85,
      weight: 'bold',
      nonInteractive: true,
      rev: 1,
      cid: 'server-base',
    },
    'ann-zone-1': {
      id: 'ann-zone-1',
      kind: 'text',
      x: 540,
      y: 28,
      width: 420,
      height: 56,
      text: 'ZONE B · 知识地图与世界观分支（锁定态直接烘焙进瓦片）',
      fontSize: 16,
      color: '#115E59',
      bgColor: '#CCFBF1',
      bgOpacity: 0.8,
      weight: 'bold',
      nonInteractive: true,
      rev: 1,
      cid: 'server-base',
    },
    'ann-zone-2': {
      id: 'ann-zone-2',
      kind: 'text',
      x: 40,
      y: 520,
      width: 460,
      height: 46,
      text: 'ZONE C · 跨 Chunk 下游区 — 滚轮缩远至 < 32% 观察全景瓦片',
      fontSize: 15,
      color: '#475569',
      bgColor: 'transparent',
      bgOpacity: 0,
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
        sourceHandle: 'out-1',
        targetHandle: 'in-1',
        label: '引用设定',
        color: '#2563EB',
        rev: 1,
        cid: 'server-base',
      },
      'edge-hub-ops': {
        id: 'edge-hub-ops',
        source: 'node-world-hub',
        target: 'node-ops-south',
        sourceHandle: 'out-1',
        targetHandle: 'in-1',
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
        kind: 'text',
        x: cx * 512 + 16,
        y: cy * 512 + 12,
        width: 460,
        height: 36,
        text: `SECTOR (${cx}, ${cy}) · 压测分区`,
        fontSize: 15,
        color: '#334155',
        bgColor: '#E2E8F0',
        bgOpacity: 0.65,
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
