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
    { type: 'input', id: 'msgInput', bind: 'draft', placeholder: '输入消息回车，沿连线同时发给所有下游子控件...' },
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
  ].join('\\n');

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

// 同一目标控件可能有多条边接过来（一个出口连两条线到同一张卡），
// 统计「几个下游」时按控件去重，否则会重复计数、重复展示。
function uniqueOutputs() {
  const seen = {};
  const list = [];
  for (const o of widgets.outputs()) {
    if (seen[o.id]) continue;
    seen[o.id] = true;
    list.push(o);
  }
  return list;
}

async function sendMessage(rawText) {
  const outs = uniqueOutputs();
  if (outs.length === 0) {
    vars.statusLine = '请先点一次「+ 创建子控件」或连线到下游控件，再发送消息';
    return;
  }
  const text = String(rawText ?? vars.draft ?? '').trim();
  if (!text) {
    vars.statusLine = '请先在输入框输入要发送的内容';
    return;
  }
  const res = await emitDownstream('ping', { text });
  vars.draft = '';
  vars.statusLine = res.ok
    ? '已沿连线并发扇出到 ' + res.count + ' 个下游控件：' + text
    : '发送失败：' + (res.error || '无下游连线');
}

on('send', async () => { await sendMessage(vars.draft); });
onSubmit('msgInput', async (val) => { await sendMessage(val); });

on('readChild', () => {
  const outs = uniqueOutputs();
  if (outs.length === 0) {
    vars.statusLine = '当前出口暂无已连线的下游控件';
    return;
  }
  const summary = outs.map((o) => o.title + '(分数=' + (o.vars && o.vars.score !== undefined ? o.vars.score : 0) + ')').join(' · ');
  vars.statusLine = '已读取 ' + outs.length + ' 个下游：' + summary;
});

on('childReply', (msg) => {
  vars.statusLine = '子控件回信：' + (msg && msg.text ? msg.text : JSON.stringify(msg));
});`,
      rev: 1,
      cid: 'server-base',
    },
    'demo-flow-checklist': {
      id: 'demo-flow-checklist',
      x: 560,
      y: 675,
      width: 310,
      height: 185,
      title: '① 上游数据源：任务清单',
      body: '- [x] 连接上下游端口\n- [ ] 勾选任意待办测试实时同步\n- [ ] 双击可新增 - [] 待办行\n- [ ] 选中连线按 Delete 测试断开',
      category: '数据流',
      color: '#0284C7',
      inputPorts: [],
      outputPorts: [{ id: 'out-1', label: '正文输出' }],
      defaultVars: {},
      rev: 1,
      cid: 'server-base',
    },
    'demo-flow-source': {
      id: 'demo-flow-source',
      x: 560,
      y: 890,
      width: 310,
      height: 175,
      title: '② 上游数据源：数值发生器',
      body: '',
      category: '数据流',
      color: '#7C3AED',
      inputPorts: [],
      outputPorts: [{ id: 'out-1', label: '数值与事件输出' }],
      defaultVars: { score: 40, lastPush: '' },
      script: `const score = Number(vars.score) || 0;
vars.contents = [
  { type: 'text', text: '当前输出数值：' + score, align: 'center', color: '#6D28D9', fontSize: 13, bold: true },
  [
    { type: 'button', id: 'minus', label: '-10', variant: 'secondary' },
    { type: 'button', id: 'plus', label: '+10', variant: 'primary' }
  ],
  { type: 'button', id: 'push', label: '沿连线推送事件 (emitDownstream)', variant: 'success' },
  { type: 'text', text: vars.lastPush || '修改数值或点击推送，右侧下游汇总会实时更新', fontSize: 11, color: '#64748B' }
];
on('minus', () => { vars.score = score - 10; });
on('plus', () => { vars.score = score + 10; });
on('push', async () => {
  const res = await emitDownstream('boost', { delta: 5, score, at: lib.now() });
  vars.lastPush = res.ok ? '已沿连线推送到 ' + res.count + ' 个下游控件 (' + lib.now() + ')' : (res.error || '无下游连线');
});`,
      rev: 1,
      cid: 'server-base',
    },
    'demo-pdf-reader': {
      id: 'demo-pdf-reader',
      x: 1390,
      y: 675,
      width: 440,
      height: 455,
      title: '⑤ PDF 图片查看器（逐页解包 · 一次性加载）',
      body: '',
      category: 'PDF',
      color: '#DC2626',
      inputPorts: [{ id: 'in-1', label: '页码/URL入口' }],
      outputPorts: [{ id: 'out-1', label: '阅读状态输出' }],
      defaultVars: { pdfUrl: '', pdfPage: 1, pdfUseProxy: false },
      script: String.raw`const page = Math.max(1, Math.floor(Number(vars.pdfPage) || 1));
vars.contents = [
  {
    type: 'pdf',
    id: 'pdfView',
    bindUrl: 'pdfUrl',
    bindPage: 'pdfPage',
    bindProxy: 'pdfUseProxy',
    height: 300
  }
];`,
      rev: 1,
      cid: 'server-base',
    },
    'demo-var-morph': {
      id: 'demo-var-morph',
      x: 960,
      y: 1005,
      width: 380,
      height: 205,
      title: '④ vars 驱动形态演示',
      body: '',
      category: '形态',
      color: '#0D9488',
      inputPorts: [{ id: 'in-1', label: '触发入口' }],
      outputPorts: [{ id: 'out-1', label: '状态输出' }],
      defaultVars: { modeIdx: 0, expanded: false, titleDraft: '' },
      script: String.raw`const modes = [
  { type: '形态', title: '④ vars 驱动形态演示', color: '#0D9488' },
  { type: 'ALERT', title: '告警模式（vars.type / title）', color: '#DC2626' },
  { type: 'TERM', title: '终端模式（vars.color 变色）', color: '#1E293B' }
];
const idx = Number(vars.modeIdx) || 0;
const expanded = Boolean(vars.expanded);
const w = ctx.entity.width;
const h = ctx.entity.height;
const x = ctx.entity.x;
const y = ctx.entity.y;

vars.contents = [
  { type: 'text', text: '当前：' + w + '×' + h + ' · 坐标 (' + x + ', ' + y + ')', align: 'center', color: '#0F766E', fontSize: 12, bold: true },
  [
    { type: 'input', id: 'titleInp', bind: 'titleDraft', placeholder: '输入新标题按回车直接改 vars.title…' },
    { type: 'button', id: 'applyTitle', label: '改标题', width: 68, variant: 'primary' }
  ],
  [
    { type: 'button', id: 'cycleMode', label: '切 type/色', variant: 'primary' },
    { type: 'button', id: 'toggleSize', label: expanded ? '还原宽高' : '放大宽高', variant: 'secondary' },
    { type: 'button', id: 'nudgeRight', label: 'pos.x +80', variant: 'success' },
    { type: 'button', id: 'resetAll', label: '重置', variant: 'secondary' }
  ]
];

onSubmit('titleInp', (val) => {
  const t = String(val || '').trim();
  if (t) { vars.title = t; vars.titleDraft = ''; }
});
on('applyTitle', () => {
  const t = String(vars.titleDraft || '').trim();
  if (t) { vars.title = t; vars.titleDraft = ''; }
});
on('cycleMode', () => {
  const next = (idx + 1) % modes.length;
  vars.modeIdx = next;
  vars.type = modes[next].type;
  vars.title = modes[next].title;
  vars.color = modes[next].color;
});
on('toggleSize', () => {
  const nextExp = !expanded;
  vars.expanded = nextExp;
  vars.width = nextExp ? 480 : 380;
  vars.height = nextExp ? 270 : 205;
});
on('nudgeRight', () => {
  vars.pos = { x: (ctx.entity.x || 960) + 80, y: ctx.entity.y || 1005 };
});
on('resetAll', () => {
  vars.modeIdx = 0;
  vars.expanded = false;
  vars.titleDraft = '';
  delete vars.type;
  delete vars.title;
  delete vars.color;
  delete vars.width;
  delete vars.height;
  delete vars.pos;
  delete vars.x;
  delete vars.y;
});`,
      rev: 1,
      cid: 'server-base',
    },
    'demo-flow-aggregator': {
      id: 'demo-flow-aggregator',
      x: 960,
      y: 745,
      width: 380,
      height: 235,
      title: '③ 下游消费者：连线数据汇总',
      body: '',
      category: '数据流',
      color: '#059669',
      inputPorts: [
        { id: 'in-1', label: '清单入口' },
        { id: 'in-2', label: '数值入口' },
      ],
      outputPorts: [{ id: 'out-1', label: '汇总输出' }],
      defaultVars: { bonus: 0, lastEvent: '尚未收到上游推送事件' },
      script: String.raw`const allIn = widgets.inputs();
const checklistIn = widgets.inputs('in-1');
const numIn = widgets.inputs('in-2');

// 解析 in-1 连入的所有上游清单正文里的 - [] / - [ ] / - [x]
let done = 0;
let total = 0;
for (const src of checklistIn) {
  const lines = String(src.body || '').split('\n');
  for (const line of lines) {
    const m = /^\s*[-*+]\s*\[([ xX]?)\]/.exec(line);
    if (m) {
      total += 1;
      if (m[1].toLowerCase() === 'x') done += 1;
    }
  }
}
const pct = total > 0 ? Math.round((done / total) * 100) : 0;

// 汇总 in-2 连入的所有上游数值变量（兼容 score / visits / count）
let sum = 0;
const numNames = [];
for (const src of numIn) {
  const v = Number(src.vars && (src.vars.score ?? src.vars.visits ?? src.vars.count));
  if (Number.isFinite(v)) {
    sum += v;
    numNames.push(src.title + '=' + v);
  }
}
const totalWithBonus = sum + (Number(vars.bonus) || 0);

vars.contents = [
  { type: 'text', text: '已接入上游：' + allIn.length + ' 个（删线或连入新卡片立即生效）', color: '#047857', fontSize: 12, bold: true },
  { type: 'text', text: total > 0 ? ('in-1 清单进度：' + done + ' / ' + total + '（' + pct + '%）') : 'in-1 清单入口：未接入清单', color: '#0F172A', fontSize: 12 },
  { type: 'text', text: numIn.length > 0 ? ('in-2 数值汇总：' + sum + ' + 推送加成 ' + (Number(vars.bonus) || 0) + ' = ' + totalWithBonus) : 'in-2 数值入口：未接入数值源', color: '#0F172A', fontSize: 12 },
  { type: 'text', text: '最近推送：' + (vars.lastEvent || '-'), color: '#475569', fontSize: 11 },
  [
    { type: 'button', id: 'refresh', label: '手动刷新上游', variant: 'secondary' },
    { type: 'button', id: 'resetBonus', label: '清零推送加成', variant: 'secondary' }
  ]
];

on('boost', (payload, meta) => {
  const delta = Number(payload && payload.delta) || 1;
  vars.bonus = (Number(vars.bonus) || 0) + delta;
  vars.lastEvent = '收到[' + meta.fromTitle + '] +' + delta + '（源值=' + (payload && payload.score) + '，' + (payload && payload.at || lib.now()) + '）';
});
on('refresh', () => {
  vars.lastEvent = '已手动重新拉取 ' + allIn.length + ' 个上游 (' + lib.now() + ')';
});
on('resetBonus', () => {
  vars.bonus = 0;
  vars.lastEvent = '已清零推送加成';
});
// 控件自带连线校验：由本控件脚本自主禁止成环连线，画布其余控件仍可自由连环
onValidateConnect((conn) => {
  if (conn.wouldCycle) {
    return { ok: false, reason: '「汇总控件」自带脚本拦截了成环连线：' + conn.cyclePath.join(' → ') };
  }
  return { ok: true };
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
    'ann-zone-flow': {
      id: 'ann-zone-flow',
      kind: 'text',
      x: 540,
      y: 615,
      width: 820,
      height: 46,
      text: 'ZONE D · 连线数据通路演示（勾选左侧清单、点 +10 / 沿连线推送，或删线重连，右侧实时响应）',
      fontSize: 15,
      color: '#065F46',
      bgColor: '#DCFCE7',
      bgOpacity: 0.85,
      weight: 'bold',
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
      'edge-flow-1': {
        id: 'edge-flow-1',
        source: 'demo-flow-checklist',
        target: 'demo-flow-aggregator',
        sourceHandle: 'out-1',
        targetHandle: 'in-1',
        label: '读取正文 body',
        color: '#0284C7',
        rev: 1,
        cid: 'server-base',
      },
      'edge-flow-2': {
        id: 'edge-flow-2',
        source: 'demo-flow-source',
        target: 'demo-flow-aggregator',
        sourceHandle: 'out-1',
        targetHandle: 'in-2',
        label: '读取 vars + 推送事件',
        color: '#7C3AED',
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
