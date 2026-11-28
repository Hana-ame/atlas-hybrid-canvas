import type { BaseBlueprint, BlueprintNode, CanvasAnnotation } from './types';
import { BUILTIN_TEMPLATES } from './widgetTemplates';

function nodeFromBuiltinTemplate(
  templateId: string,
  id: string,
  x: number,
  y: number,
  overrides: Partial<BlueprintNode> & { defaultVarsPatch?: Record<string, unknown> } = {}
): BlueprintNode {
  const tpl = BUILTIN_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl || tpl.kind !== 'node' || !tpl.nodePreset) {
    throw new Error(`Missing built-in node template: ${templateId}`);
  }
  const p = tpl.nodePreset;
  const { defaultVarsPatch, ...restOverrides } = overrides;
  return {
    id,
    x,
    y,
    width: p.width,
    height: p.height,
    title: p.title,
    body: p.body,
    category: p.category,
    color: p.color,
    script: p.script,
    inputPorts: p.inputPorts ? p.inputPorts.map((port) => ({ ...port })) : undefined,
    outputPorts: p.outputPorts ? p.outputPorts.map((port) => ({ ...port })) : undefined,
    defaultVars: { ...p.defaultVars, ...(defaultVarsPatch ?? {}) },
    buttons: p.buttons ? p.buttons.map((b) => ({ ...b })) : undefined,
    rev: 1,
    cid: 'server-base',
    ...restOverrides,
  };
}

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
  vars.pos = { x: (ctx.entity.x ?? 960) + 80, y: ctx.entity.y ?? 1005 };
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
    'demo-image-node': {
      id: 'demo-image-node',
      x: 560,
      y: 1335,
      width: 340,
      height: 260,
      title: '⑥ 图片节点示例',
      body: '',
      category: '图片',
      color: '#4F46E5',
      inputPorts: [{ id: 'in-1', label: '输入' }],
      outputPorts: [{ id: 'out-1', label: '输出' }],
      defaultVars: {
        imageUrl: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 360 220'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%23EEF2FF'/%3E%3Cstop offset='100%25' stop-color='%23E0E7FF'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='360' height='220' fill='url(%23g)'/%3E%3Ccircle cx='118' cy='86' r='30' fill='%234F46E5' fill-opacity='0.22'/%3E%3Cpath d='M52 174 L142 104 L212 152 L262 118 L314 174 Z' fill='%234F46E5' fill-opacity='0.3'/%3E%3Ctext x='180' y='198' text-anchor='middle' font-family='sans-serif' font-size='13' fill='%23312E81'%3E悬停右上角：切铺满/等比 · 灯箱全屏 · 换图%3C/text%3E%3C/svg%3E",
        imageFit: 'contain',
        imageCaption: '纯外链图片（悬停右上角切铺满/灯箱/换外链）',
      },
      script: String.raw`vars.contents = [
  { type: 'image', id: 'imgMain', bindUrl: 'imageUrl', bindFit: 'imageFit', bindCaption: 'imageCaption' }
];`,
      rev: 1,
      cid: 'server-base',
    },
    'demo-video-node': {
      id: 'demo-video-node',
      x: 930,
      y: 1335,
      width: 380,
      height: 260,
      title: '⑦ 视频节点示例',
      body: '',
      category: '视频',
      color: '#E11D48',
      inputPorts: [{ id: 'in-1', label: '输入' }],
      outputPorts: [{ id: 'out-1', label: '输出' }],
      defaultVars: {
        videoUrl: '',
        videoLoop: false,
        videoMuted: false,
      },
      script: String.raw`vars.contents = [
  { type: 'video', id: 'vidMain', bindUrl: 'videoUrl', bindLoop: 'videoLoop', bindMuted: 'videoMuted' }
];`,
      rev: 1,
      cid: 'server-base',
    },
    'demo-slider-node': {
      id: 'demo-slider-node',
      x: 1340,
      y: 1335,
      width: 310,
      height: 215,
      title: '⑧ 拖动条控件示例',
      body: '',
      category: '滑块',
      color: '#2563EB',
      inputPorts: [],
      outputPorts: [{ id: 'out-1', label: '数值输出' }],
      defaultVars: {
        value: 60,
        scale: 1.5,
      },
      script: String.raw`const v = Number(vars.value ?? 60);
const s = Number(vars.scale ?? 1.5);
const outVal = Math.round(v * s * 10) / 10;

vars.contents = [
  { type: 'slider', id: 'sVal', bind: 'value', label: '强度', min: 0, max: 100, step: 1, unit: '%', accentColor: '#2563EB' },
  { type: 'slider', id: 'sScale', bind: 'scale', label: '倍率', min: 0.5, max: 3, step: 0.1, unit: '×', accentColor: '#0D9488' },
  { type: 'text', text: '输出：' + outVal + '（拖完自动同步下方汇总）', align: 'center', color: '#1E293B', fontSize: 11.5, bold: true }
];

onChange(['value', 'scale'], () => {
  vars.output = Math.round(Number(vars.value ?? 60) * Number(vars.scale ?? 1.5) * 10) / 10;
});`,
      rev: 1,
      cid: 'server-base',
    },
    'demo-pad2d-node': {
      id: 'demo-pad2d-node',
      x: 560,
      y: 1625,
      width: 310,
      height: 315,
      title: '⑨ 2D Pad 拖动板示例',
      body: '',
      category: '2D Pad',
      color: '#D97706',
      inputPorts: [],
      outputPorts: [{ id: 'out-1', label: 'XY 输出' }],
      defaultVars: {
        padX: 25,
        padY: -15,
      },
      script: String.raw`const px = Number(vars.padX ?? 0);
const py = Number(vars.padY ?? 0);

vars.contents = [
  {
    type: 'pad2d',
    id: 'xyPad',
    label: '二维坐标触控板',
    labelX: 'X',
    labelY: 'Y',
    bindX: 'padX',
    bindY: 'padY',
    minX: -100,
    maxX: 100,
    stepX: 1,
    minY: -100,
    maxY: 100,
    stepY: 1,
    height: 176,
    accentColor: '#F59E0B'
  },
  { type: 'text', text: '向量：(' + px + ', ' + py + ')', align: 'center', color: '#334155', fontSize: 12, bold: true }
];

onChange(['padX', 'padY'], () => {
  vars.magnitude = Math.round(Math.hypot(Number(vars.padX ?? 0), Number(vars.padY ?? 0)) * 10) / 10;
});`,
      rev: 1,
      cid: 'server-base',
    },
    'demo-image-button-node': {
      id: 'demo-image-button-node',
      x: 900,
      y: 1625,
      width: 300,
      height: 215,
      title: '⑩ 四态图片按钮示例',
      body: '',
      category: '图钮',
      color: '#059669',
      inputPorts: [{ id: 'in-1', label: '输入' }],
      outputPorts: [{ id: 'out-1', label: '状态输出' }],
      defaultVars: {
        powerOn: false,
        clicks: 0,
        btnOffImage: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 88'%3E%3Crect x='4' y='6' width='232' height='76' rx='18' fill='%23334155' stroke='%2364748B' stroke-width='3'/%3E%3Ccircle cx='46' cy='44' r='12' fill='%2394A3B8'/%3E%3Ctext x='136' y='50' text-anchor='middle' font-family='sans-serif' font-size='18' font-weight='700' fill='%23E2E8F0'%3EOFF · 待机%3C/text%3E%3C/svg%3E",
        btnOnImage: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 88'%3E%3Crect x='4' y='6' width='232' height='76' rx='18' fill='%23059669' stroke='%2334D399' stroke-width='3'/%3E%3Ccircle cx='46' cy='44' r='12' fill='%23A7F3D0'/%3E%3Ctext x='136' y='50' text-anchor='middle' font-family='sans-serif' font-size='18' font-weight='700' fill='%23FFFFFF'%3EON · 已开启%3C/text%3E%3C/svg%3E",
        btnHoverImage: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 88'%3E%3Crect x='4' y='6' width='232' height='76' rx='18' fill='%234F46E5' stroke='%23A5B4FC' stroke-width='3'/%3E%3Ccircle cx='46' cy='44' r='12' fill='%23E0E7FF'/%3E%3Ctext x='136' y='50' text-anchor='middle' font-family='sans-serif' font-size='18' font-weight='700' fill='%23FFFFFF'%3EHOVER · 悬停%3C/text%3E%3C/svg%3E",
        btnClickImage: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 88'%3E%3Crect x='6' y='10' width='228' height='70' rx='16' fill='%23D97706' stroke='%23FDE68A' stroke-width='3'/%3E%3Ccircle cx='46' cy='45' r='12' fill='%23FEF3C7'/%3E%3Ctext x='136' y='51' text-anchor='middle' font-family='sans-serif' font-size='18' font-weight='700' fill='%23FFFFFF'%3ECLICK · 按下%3C/text%3E%3C/svg%3E",
      },
      script: String.raw`const isOn = Boolean(vars.powerOn);
const clicks = Number(vars.clicks ?? 0);

vars.contents = [
  {
    type: 'image_button',
    id: 'imgToggleBtn',
    bind: 'powerOn',
    label: isOn ? '已开启' : '未开启',
    toggle: true,
    bindOffImage: 'btnOffImage',
    bindOnImage: 'btnOnImage',
    bindHoverImage: 'btnHoverImage',
    bindClickImage: 'btnClickImage',
    height: 92,
    showStateBadge: true
  },
  {
    type: 'text',
    text: '状态：' + (isOn ? 'ON' : 'OFF') + ' · 点击 ' + clicks + ' 次（悬停右上角换图）',
    align: 'center',
    color: isOn ? '#047857' : '#475569',
    fontSize: 11.5,
    bold: true
  }
];

on('imgToggleBtn', () => {
  vars.clicks = Number(vars.clicks ?? 0) + 1;
});`,
      rev: 1,
      cid: 'server-base',
    },
    'demo-controls-monitor': {
      id: 'demo-controls-monitor',
      x: 1260,
      y: 1625,
      width: 390,
      height: 220,
      title: '⑪ 交互控件下游实时监视器',
      body: '',
      category: '联动',
      color: '#0F766E',
      inputPorts: [
        { id: 'in-1', label: '连续数值入口' },
        { id: 'in-2', label: '开关状态入口' },
      ],
      outputPorts: [{ id: 'out-1', label: '汇总输出' }],
      defaultVars: {},
      script: String.raw`const numPeers = widgets.inputs('in-1');
const switchPeers = widgets.inputs('in-2');
const lines = [];

for (const p of numPeers) {
  const pv = p.vars || {};
  if (pv.padX !== undefined || pv.padY !== undefined) {
    lines.push('2D Pad：(' + Number(pv.padX ?? 0) + ', ' + Number(pv.padY ?? 0) + ')');
  } else if (pv.value !== undefined) {
    const out = Math.round(Number(pv.value ?? 0) * Number(pv.scale ?? 1) * 10) / 10;
    lines.push('拖动条：' + Number(pv.value ?? 0) + '% × ' + Number(pv.scale ?? 1) + ' = ' + out);
  }
}

let swText = '图片按钮：未接入';
for (const p of switchPeers) {
  const pv = p.vars || {};
  swText = '图片按钮：' + (pv.powerOn ? 'ON（已开启）' : 'OFF（待机）');
}

vars.contents = [
  { type: 'text', text: '已接入交互源：' + (numPeers.length + switchPeers.length) + ' 个', color: '#0F766E', fontSize: 12, bold: true },
  { type: 'text', text: lines.length > 0 ? lines.join('  |  ') : '拖动左侧滑块或 2D Pad 实时查看变化', color: '#0F172A', fontSize: 12 },
  { type: 'text', text: swText, color: '#334155', fontSize: 12 },
  { type: 'text', text: '提示：拖动滑块/2D Pad 松手或点击图片按钮后，本卡片自动同步刷新', color: '#64748B', fontSize: 11 }
];`,
      rev: 1,
      cid: 'server-base',
    },
    'fsm-idle': {
      id: 'fsm-idle',
      x: 560,
      y: 2060,
      width: 280,
      height: 195,
      title: '状态 A：IDLE 待机',
      body: '',
      category: '● ACTIVE',
      color: '#2563EB',
      inputPorts: [
        { id: 'in-1', label: '取消/回退' },
        { id: 'in-2', label: '重置/重启' },
      ],
      outputPorts: [{ id: 'out-1', label: 'start' }],
      defaultVars: { active: true, visits: 1, lastFrom: '初始态' },
      script: String.raw`const isActive = Boolean(vars.active);
const visits = Number(vars.visits ?? 1);
vars.color = isActive ? '#2563EB' : '#94A3B8';
vars.type = isActive ? '● ACTIVE' : 'IDLE';

vars.contents = [
  {
    type: 'text',
    text: isActive ? '当前激活 · 可触发 start 进入运行态' : '未激活（等待 cancel / reset / restart 回到本态）',
    align: 'center',
    color: isActive ? '#1D4ED8' : '#64748B',
    fontSize: 12,
    bold: isActive
  },
  { type: 'text', text: '进入次数：' + visits + ' · 来源：' + (vars.lastFrom || '-'), align: 'center', color: '#475569', fontSize: 11 },
  { type: 'button', id: 'start', label: '▶ 启动 (start → RUNNING)', variant: 'primary', disabled: !isActive }
];

on('start', async () => {
  if (!Boolean(vars.active)) return;
  vars.active = false;
  await emit('fsm-running', 'enter', { from: 'IDLE', event: 'start' });
  await emit('fsm-monitor', 'transition', { from: 'IDLE', to: 'RUNNING', event: 'start', at: lib.now() });
});

on('enter', (msg) => {
  vars.active = true;
  vars.visits = Number(vars.visits ?? 0) + 1;
  vars.lastFrom = (msg && msg.from ? msg.from : '外部') + ' (' + (msg && msg.event ? msg.event : 'enter') + ')';
});`,
      rev: 1,
      cid: 'server-base',
    },
    'fsm-running': {
      id: 'fsm-running',
      x: 920,
      y: 2060,
      width: 310,
      height: 205,
      title: '状态 B：RUNNING 运行中',
      body: '',
      category: 'RUNNING',
      color: '#94A3B8',
      inputPorts: [
        { id: 'in-1', label: 'start 入口' },
        { id: 'in-2', label: 'resume 入口' },
      ],
      outputPorts: [{ id: 'out-1', label: '状态转移出口' }],
      defaultVars: { active: false, visits: 0, lastFrom: '-' },
      script: String.raw`const isActive = Boolean(vars.active);
const visits = Number(vars.visits ?? 0);
vars.color = isActive ? '#059669' : '#94A3B8';
vars.type = isActive ? '● ACTIVE' : 'RUNNING';

vars.contents = [
  {
    type: 'text',
    text: isActive ? '当前激活 · 支持多分支转移（暂停 / 完成 / 取消）' : '未激活（从 IDLE 或 PAUSED 转移进入）',
    align: 'center',
    color: isActive ? '#047857' : '#64748B',
    fontSize: 12,
    bold: isActive
  },
  { type: 'text', text: '进入次数：' + visits + ' · 来源：' + (vars.lastFrom || '-'), align: 'center', color: '#475569', fontSize: 11 },
  [
    { type: 'button', id: 'pause', label: '⏸ 暂停', variant: 'secondary', disabled: !isActive },
    { type: 'button', id: 'finish', label: '✓ 完成', variant: 'success', disabled: !isActive },
    { type: 'button', id: 'cancel', label: '↩ 取消', variant: 'danger', disabled: !isActive }
  ]
];

on('pause', async () => {
  if (!Boolean(vars.active)) return;
  vars.active = false;
  await emit('fsm-paused', 'enter', { from: 'RUNNING', event: 'pause' });
  await emit('fsm-monitor', 'transition', { from: 'RUNNING', to: 'PAUSED', event: 'pause', at: lib.now() });
});

on('finish', async () => {
  if (!Boolean(vars.active)) return;
  vars.active = false;
  await emit('fsm-done', 'enter', { from: 'RUNNING', event: 'finish' });
  await emit('fsm-monitor', 'transition', { from: 'RUNNING', to: 'DONE', event: 'finish', at: lib.now() });
});

on('cancel', async () => {
  if (!Boolean(vars.active)) return;
  vars.active = false;
  await emit('fsm-idle', 'enter', { from: 'RUNNING', event: 'cancel' });
  await emit('fsm-monitor', 'transition', { from: 'RUNNING', to: 'IDLE', event: 'cancel', at: lib.now() });
});

on('enter', (msg) => {
  vars.active = true;
  vars.visits = Number(vars.visits ?? 0) + 1;
  vars.lastFrom = (msg && msg.from ? msg.from : '外部') + ' (' + (msg && msg.event ? msg.event : 'enter') + ')';
});`,
      rev: 1,
      cid: 'server-base',
    },
    'fsm-paused': {
      id: 'fsm-paused',
      x: 920,
      y: 2355,
      width: 310,
      height: 195,
      title: '状态 C：PAUSED 已暂停',
      body: '',
      category: 'PAUSED',
      color: '#94A3B8',
      inputPorts: [{ id: 'in-1', label: 'pause 入口' }],
      outputPorts: [{ id: 'out-1', label: 'resume / reset' }],
      defaultVars: { active: false, visits: 0, lastFrom: '-' },
      script: String.raw`const isActive = Boolean(vars.active);
const visits = Number(vars.visits ?? 0);
vars.color = isActive ? '#D97706' : '#94A3B8';
vars.type = isActive ? '● ACTIVE' : 'PAUSED';

vars.contents = [
  {
    type: 'text',
    text: isActive ? '当前激活 · 可双向恢复 RUNNING 或重置回 IDLE' : '未激活（从 RUNNING 暂停进入）',
    align: 'center',
    color: isActive ? '#B45309' : '#64748B',
    fontSize: 12,
    bold: isActive
  },
  { type: 'text', text: '进入次数：' + visits + ' · 来源：' + (vars.lastFrom || '-'), align: 'center', color: '#475569', fontSize: 11 },
  [
    { type: 'button', id: 'resume', label: '▶ 恢复 (→ RUNNING)', variant: 'primary', disabled: !isActive },
    { type: 'button', id: 'reset', label: '⏹ 重置 (→ IDLE)', variant: 'secondary', disabled: !isActive }
  ]
];

on('resume', async () => {
  if (!Boolean(vars.active)) return;
  vars.active = false;
  await emit('fsm-running', 'enter', { from: 'PAUSED', event: 'resume' });
  await emit('fsm-monitor', 'transition', { from: 'PAUSED', to: 'RUNNING', event: 'resume', at: lib.now() });
});

on('reset', async () => {
  if (!Boolean(vars.active)) return;
  vars.active = false;
  await emit('fsm-idle', 'enter', { from: 'PAUSED', event: 'reset' });
  await emit('fsm-monitor', 'transition', { from: 'PAUSED', to: 'IDLE', event: 'reset', at: lib.now() });
});

on('enter', (msg) => {
  vars.active = true;
  vars.visits = Number(vars.visits ?? 0) + 1;
  vars.lastFrom = (msg && msg.from ? msg.from : '外部') + ' (' + (msg && msg.event ? msg.event : 'enter') + ')';
});`,
      rev: 1,
      cid: 'server-base',
    },
    'fsm-done': {
      id: 'fsm-done',
      x: 1310,
      y: 2060,
      width: 290,
      height: 195,
      title: '状态 D：DONE 已完成',
      body: '',
      category: 'DONE',
      color: '#94A3B8',
      inputPorts: [{ id: 'in-1', label: 'finish 入口' }],
      outputPorts: [{ id: 'out-1', label: 'restart' }],
      defaultVars: { active: false, visits: 0, lastFrom: '-' },
      script: String.raw`const isActive = Boolean(vars.active);
const visits = Number(vars.visits ?? 0);
vars.color = isActive ? '#7C3AED' : '#94A3B8';
vars.type = isActive ? '● ACTIVE' : 'DONE';

vars.contents = [
  {
    type: 'text',
    text: isActive ? '当前激活 · 流程已完成，可闭环重启回 IDLE' : '未激活（从 RUNNING 完成进入）',
    align: 'center',
    color: isActive ? '#6D28D9' : '#64748B',
    fontSize: 12,
    bold: isActive
  },
  { type: 'text', text: '完成次数：' + visits + ' · 来源：' + (vars.lastFrom || '-'), align: 'center', color: '#475569', fontSize: 11 },
  { type: 'button', id: 'restart', label: '↻ 重新开始 (restart → IDLE)', variant: 'primary', disabled: !isActive }
];

on('restart', async () => {
  if (!Boolean(vars.active)) return;
  vars.active = false;
  await emit('fsm-idle', 'enter', { from: 'DONE', event: 'restart' });
  await emit('fsm-monitor', 'transition', { from: 'DONE', to: 'IDLE', event: 'restart', at: lib.now() });
});

on('enter', (msg) => {
  vars.active = true;
  vars.visits = Number(vars.visits ?? 0) + 1;
  vars.lastFrom = (msg && msg.from ? msg.from : '外部') + ' (' + (msg && msg.event ? msg.event : 'enter') + ')';
});`,
      rev: 1,
      cid: 'server-base',
    },
    // ==================== ZONE G：Edge 通道版状态机（不改原 ZONE F，连线即共享消息槽 + flag 视觉反馈） ====================
    'efsm-idle': {
      id: 'efsm-idle',
      x: 560,
      y: 2800,
      width: 300,
      height: 215,
      title: 'Edge 状态 A：IDLE 待机',
      body: '',
      category: '● ACTIVE',
      color: '#2563EB',
      inputPorts: [
        { id: 'in-1', label: 'cancel 入口' },
        { id: 'in-2', label: 'reset/restart 入口' },
      ],
      outputPorts: [{ id: 'out-1', label: 'start 出口' }],
      defaultVars: { active: true, visits: 1, lastFrom: '初始态' },
      script: String.raw`const isActive = Boolean(vars.active);
const visits = Number(vars.visits ?? 1);
const pendingIn = (vars.input || []).find((e) => e.flag);
// 连线 tag 在「待签收」期间会带后缀，比对时只取事件名前缀
const tagOf = (e) => String((e && e.tag) || '').split(' · ')[0];
const outStart = (vars.output || []).find((e) => tagOf(e) === 'start') || (vars.output || [])[0];
vars.color = isActive ? '#2563EB' : (pendingIn ? '#F59E0B' : '#94A3B8');
// 徽标同时交代「状态名」与「运行态」，避免未激活时写成 IDLE/RUNNING 被误读成当前状态
const runtime = isActive ? '激活' : (pendingIn ? '待签收' : '待机');
vars.type = 'IDLE · ' + runtime;

vars.contents = [
  {
    type: 'text',
    text: isActive
      ? (outStart ? '当前激活 · 点击将令牌写入 [' + (outStart.tag || outStart.name) + '] 连线' : '当前激活 · 尚未连出 start 边')
      : ('未激活 · 上游写入后连线会亮起流动，点下方「签收连线」读取'),
    align: 'center',
    color: isActive ? '#1D4ED8' : (pendingIn ? '#B45309' : '#64748B'),
    fontSize: 12,
    bold: isActive || Boolean(pendingIn)
  },
  { type: 'text', text: '进入次数：' + visits + ' · 来源：' + (vars.lastFrom || '-'), align: 'center', color: '#475569', fontSize: 11 },
  [
    { type: 'button', id: 'sendStart', label: '▶ 写入 start 连线', variant: 'primary', disabled: !isActive || !outStart },
    { type: 'button', id: 'accept', label: '✓ 签收连线', variant: 'success', disabled: isActive }
  ]
];

on('sendStart', () => {
  if (!Boolean(vars.active)) return;
  const edge = (vars.output || []).find((e) => tagOf(e) === 'start') || (vars.output || [])[0];
  if (!edge) return;
  vars.active = false;
  edge.msg = { from: 'IDLE', event: 'start', at: lib.now() };
  edge.flag = true;
  edge.dashed = true;      // 发送时切为流动虚线
  edge.color = '#F59E0B';  // 亮琥珀色提示有待签收令牌
  edge.tag = 'start · 待签收';
});

on('accept', () => {
  const edge = (vars.input || []).find((e) => e.flag);
  if (!edge) return;
  const msg = edge.msg || {};
  edge.flag = false;
  edge.dashed = false;     // 签收后切回静态实线
  edge.color = '';         // 清空覆盖，恢复默认线色
  edge.tag = msg.event || 'done';
  vars.active = true;
  vars.visits = Number(vars.visits ?? 0) + 1;
  vars.lastFrom = (msg.from || '上游') + ' (' + (msg.event || edge.tag || 'edge') + ')';
});`,
      rev: 1,
      cid: 'server-base',
    },
    'efsm-running': {
      id: 'efsm-running',
      x: 940,
      y: 2800,
      width: 320,
      height: 225,
      title: 'Edge 状态 B：RUNNING 运行中',
      body: '',
      category: 'RUNNING',
      color: '#94A3B8',
      inputPorts: [
        { id: 'in-1', label: 'start 入口' },
        { id: 'in-2', label: 'resume 入口' },
      ],
      outputPorts: [
        { id: 'out-1', label: 'finish 出口' },
        { id: 'out-2', label: 'pause 出口' },
        { id: 'out-3', label: 'cancel 出口' },
      ],
      defaultVars: { active: false, visits: 0, lastFrom: '-' },
      script: String.raw`const isActive = Boolean(vars.active);
const visits = Number(vars.visits ?? 0);
const pendingIn = (vars.input || []).find((e) => e.flag);
// 连线 tag 在「待签收」期间会带后缀，比对时只取事件名前缀
const tagOf = (e) => String((e && e.tag) || '').split(' · ')[0];
const pickOut = (tag, idx) => (vars.output || []).find((e) => tagOf(e) === tag) || (vars.output || [])[idx];
vars.color = isActive ? '#059669' : (pendingIn ? '#F59E0B' : '#94A3B8');
const runtime = isActive ? '激活' : (pendingIn ? '待签收' : '待机');
vars.type = 'RUNNING · ' + runtime;

vars.contents = [
  {
    type: 'text',
    text: isActive ? '运行中 · 选择一条出边写入令牌' : ('未激活 · 连线亮起流动时点下方「签收连线」读取'),
    align: 'center',
    color: isActive ? '#047857' : (pendingIn ? '#B45309' : '#64748B'),
    fontSize: 12,
    bold: isActive || Boolean(pendingIn)
  },
  { type: 'text', text: '进入次数：' + visits + ' · 来源：' + (vars.lastFrom || '-'), align: 'center', color: '#475569', fontSize: 11 },
  { type: 'button', id: 'accept', label: '✓ 签收连线进入 RUNNING', variant: 'success', disabled: isActive },
  [
    { type: 'button', id: 'pause', label: '⏸ 暂停', variant: 'secondary', disabled: !isActive || !pickOut('pause', 1) },
    { type: 'button', id: 'finish', label: '✓ 完成', variant: 'primary', disabled: !isActive || !pickOut('finish', 0) },
    { type: 'button', id: 'cancel', label: '✕ 取消', variant: 'danger', disabled: !isActive || !pickOut('cancel', 2) }
  ]
];

on('accept', () => {
  const edge = (vars.input || []).find((e) => e.flag);
  if (!edge) return;
  const msg = edge.msg || {};
  edge.flag = false;
  edge.dashed = false;     // 签收后切回静态实线，别把「待签收」样式留在线
  edge.color = '';         // 清空覆盖，恢复默认线色
  edge.tag = msg.event || edge.tag || 'edge';
  vars.active = true;
  vars.visits = Number(vars.visits ?? 0) + 1;
  vars.lastFrom = (msg.from || '上游') + ' (' + (msg.event || edge.tag || 'edge') + ')';
});

const sendVia = (tag, idx) => {
  if (!Boolean(vars.active)) return;
  const edge = pickOut(tag, idx);
  if (!edge) return;
  vars.active = false;
  edge.msg = { from: 'RUNNING', event: tag, at: lib.now() };
  edge.flag = true;
  edge.dashed = true;      // 下游连线亮起流动，提示有待签收令牌
  edge.color = '#F59E0B';
  edge.tag = tag + ' · 待签收';
};
on('finish', () => sendVia('finish', 0));
on('pause', () => sendVia('pause', 1));
on('cancel', () => sendVia('cancel', 2));`,
      rev: 1,
      cid: 'server-base',
    },
    'efsm-paused': {
      id: 'efsm-paused',
      x: 940,
      y: 3090,
      width: 320,
      height: 215,
      title: 'Edge 状态 C：PAUSED 已暂停',
      body: '',
      category: 'PAUSED',
      color: '#94A3B8',
      inputPorts: [{ id: 'in-1', label: 'pause 入口' }],
      outputPorts: [
        { id: 'out-1', label: 'resume 出口' },
        { id: 'out-2', label: 'reset 出口' },
      ],
      defaultVars: { active: false, visits: 0, lastFrom: '-' },
      script: String.raw`const isActive = Boolean(vars.active);
const visits = Number(vars.visits ?? 0);
const pendingIn = (vars.input || []).find((e) => e.flag);
// 连线 tag 在「待签收」期间会带后缀，比对时只取事件名前缀
const tagOf = (e) => String((e && e.tag) || '').split(' · ')[0];
const pickOut = (tag, idx) => (vars.output || []).find((e) => tagOf(e) === tag) || (vars.output || [])[idx];
vars.color = isActive ? '#D97706' : (pendingIn ? '#F59E0B' : '#94A3B8');
const runtime = isActive ? '激活' : (pendingIn ? '待签收' : '待机');
vars.type = 'PAUSED · ' + runtime;

vars.contents = [
  {
    type: 'text',
    text: isActive ? '已暂停 · 可写入 resume 或 reset 连线' : ('未激活 · 连线亮起流动时点下方「签收连线」读取'),
    align: 'center',
    color: isActive ? '#B45309' : '#64748B',
    fontSize: 12,
    bold: isActive || Boolean(pendingIn)
  },
  { type: 'text', text: '暂停次数：' + visits + ' · 来源：' + (vars.lastFrom || '-'), align: 'center', color: '#475569', fontSize: 11 },
  { type: 'button', id: 'accept', label: '✓ 签收连线进入 PAUSED', variant: 'success', disabled: isActive },
  [
    { type: 'button', id: 'resume', label: '▶ 恢复', variant: 'primary', disabled: !isActive || !pickOut('resume', 0) },
    { type: 'button', id: 'reset', label: '↺ 重置', variant: 'secondary', disabled: !isActive || !pickOut('reset', 1) }
  ]
];

on('accept', () => {
  const edge = (vars.input || []).find((e) => e.flag);
  if (!edge) return;
  const msg = edge.msg || {};
  edge.flag = false;
  edge.dashed = false;     // 签收后切回静态实线，别把「待签收」样式留在线
  edge.color = '';         // 清空覆盖，恢复默认线色
  edge.tag = msg.event || edge.tag || 'edge';
  vars.active = true;
  vars.visits = Number(vars.visits ?? 0) + 1;
  vars.lastFrom = (msg.from || '上游') + ' (' + (msg.event || edge.tag || 'edge') + ')';
});

const sendVia = (tag, idx) => {
  if (!Boolean(vars.active)) return;
  const edge = pickOut(tag, idx);
  if (!edge) return;
  vars.active = false;
  edge.msg = { from: 'PAUSED', event: tag, at: lib.now() };
  edge.flag = true;
  edge.dashed = true;      // 下游连线亮起流动，提示有待签收令牌
  edge.color = '#F59E0B';
  edge.tag = tag + ' · 待签收';
};
on('resume', () => sendVia('resume', 0));
on('reset', () => sendVia('reset', 1));`,
      rev: 1,
      cid: 'server-base',
    },
    'efsm-done': {
      id: 'efsm-done',
      x: 1340,
      y: 2800,
      width: 300,
      height: 215,
      title: 'Edge 状态 D：DONE 已完成',
      body: '',
      category: 'DONE',
      color: '#94A3B8',
      inputPorts: [{ id: 'in-1', label: 'finish 入口' }],
      outputPorts: [{ id: 'out-1', label: 'restart 出口' }],
      defaultVars: { active: false, visits: 0, lastFrom: '-' },
      script: String.raw`const isActive = Boolean(vars.active);
const visits = Number(vars.visits ?? 0);
const pendingIn = (vars.input || []).find((e) => e.flag);
const outRestart = (vars.output || []).find((e) => String((e && e.tag) || '').split(' · ')[0] === 'restart') || (vars.output || [])[0];
vars.color = isActive ? '#7C3AED' : (pendingIn ? '#F59E0B' : '#94A3B8');
const runtime = isActive ? '激活' : (pendingIn ? '待签收' : '待机');
vars.type = 'DONE · ' + runtime;

vars.contents = [
  {
    type: 'text',
    text: isActive ? '已完成 · 点击写入 restart 连线闭环回 IDLE' : ('未激活 · 连线亮起流动时点下方「签收连线」读取'),
    align: 'center',
    color: isActive ? '#6D28D9' : (pendingIn ? '#B45309' : '#64748B'),
    fontSize: 12,
    bold: isActive || Boolean(pendingIn)
  },
  { type: 'text', text: '完成次数：' + visits + ' · 来源：' + (vars.lastFrom || '-'), align: 'center', color: '#475569', fontSize: 11 },
  [
    { type: 'button', id: 'accept', label: '✓ 签收完成', variant: 'success', disabled: isActive },
    { type: 'button', id: 'restart', label: '↻ 写入 restart', variant: 'primary', disabled: !isActive || !outRestart }
  ]
];

on('accept', () => {
  const edge = (vars.input || []).find((e) => e.flag);
  if (!edge) return;
  const msg = edge.msg || {};
  edge.flag = false;
  edge.dashed = false;     // 签收后切回静态实线，别把「待签收」样式留在线
  edge.color = '';         // 清空覆盖，恢复默认线色
  edge.tag = msg.event || edge.tag || 'edge';
  vars.active = true;
  vars.visits = Number(vars.visits ?? 0) + 1;
  vars.lastFrom = (msg.from || '上游') + ' (' + (msg.event || edge.tag || 'edge') + ')';
});

on('restart', () => {
  if (!Boolean(vars.active)) return;
  const edge = (vars.output || []).find((e) => String((e && e.tag) || '').split(' · ')[0] === 'restart') || (vars.output || [])[0];
  if (!edge) return;
  vars.active = false;
  edge.msg = { from: 'DONE', event: 'restart', at: lib.now() };
  edge.flag = true;
  edge.dashed = true;      // 闭环回 IDLE 时同样点亮 restart 连线
  edge.color = '#F59E0B';
  edge.tag = 'restart · 待签收';
});`,
      rev: 1,
      cid: 'server-base',
    },
    'fsm-monitor': {
      id: 'fsm-monitor',
      x: 1310,
      y: 2355,
      width: 320,
      height: 195,
      title: '状态机监视器 · 转移日志',
      body: '',
      category: 'FSM',
      color: '#0F172A',
      inputPorts: [],
      outputPorts: [],
      defaultVars: { currentState: 'IDLE', stepCount: 0, logText: '尚未发生状态转移（点左侧「▶ 启动」开始体验）' },
      script: String.raw`const cur = String(vars.currentState || 'IDLE');
const steps = Number(vars.stepCount ?? 0);
const logText = String(vars.logText || '');

vars.contents = [
  { type: 'text', text: '当前状态：' + cur + '  ·  累计转移 ' + steps + ' 次', align: 'center', color: '#0F172A', fontSize: 12.5, bold: true },
  { type: 'text', text: logText, color: '#334155', fontSize: 11.5 },
  { type: 'button', id: 'clearLog', label: '清空日志', variant: 'secondary' }
];

on('transition', (msg) => {
  const from = msg && msg.from ? msg.from : '?';
  const to = msg && msg.to ? msg.to : '?';
  const ev = msg && msg.event ? msg.event : 'go';
  const nextStep = Number(vars.stepCount ?? 0) + 1;
  vars.currentState = to;
  vars.stepCount = nextStep;
  const line = '#' + nextStep + ' ' + from + ' --(' + ev + ')--> ' + to;
  const prevLines = String(vars.logText || '').startsWith('#') ? String(vars.logText).split(' | ') : [];
  vars.logText = [line, ...prevLines].slice(0, 3).join(' | ');
});

on('clearLog', () => {
  vars.stepCount = 0;
  vars.logText = '日志已清空 · 当前状态：' + String(vars.currentState || 'IDLE');
});`,
      rev: 1,
      cid: 'server-base',
    },
    // ==================== ZONE H：全量控件用法 e.g. 百科与工程卡 ====================
    'eg-all-in-one': nodeFromBuiltinTemplate('tpl-usage-cheatsheet', 'eg-all-in-one', 40, 865, {
      width: 435,
      height: 440,
      title: 'e.g. 全能控件用法百科（点页签切换）',
    }),
    'eg-markdown-buttons': {
      id: 'eg-markdown-buttons',
      x: 40,
      y: 1330,
      width: 435,
      height: 280,
      title: 'e.g. 纯正文 Markdown + buttons[] 静态按钮卡',
      body: [
        '不写 script 的 vars.contents 时，卡片展示正文 + 下方 buttons[]：',
        '- [x] 支持点击勾选任务行（- [ ] / - [x]）实时同步',
        '- [ ] button actionType="script"：在隔离沙箱跑 lib/vars/canvas',
        '- [ ] button actionType="proxy_http"：经服务端代理发 GET/POST',
        '💡 点右上角 ⚙ 可直接编辑本卡 defaultVars / buttons[] 源码',
      ].join('\n'),
      category: '正文/按钮',
      color: '#0369A1',
      defaultVars: { egClicks: 0, lastClick: '-' },
      buttons: [
        {
          id: 'eg-btn-script',
          label: 'script 按钮 (+1 & 改区色)',
          variant: 'primary',
          actionType: 'script',
          code: `lib.inc('egClicks', 1);
vars.lastClick = lib.now();
canvas.setAnnotationBg('ann-zone-examples', '#FEF3C7', 0.9);
log('Markdown+Buttons clicked', vars.egClicks);`,
        },
        {
          id: 'eg-btn-http',
          label: 'proxy_http GET 测试',
          variant: 'secondary',
          actionType: 'proxy_http',
          proxyUrl: 'https://httpbin.org/get?source=atlas-eg',
          proxyMethod: 'GET',
        },
      ],
      rev: 1,
      cid: 'server-base',
    },
    'eg-reactive-onchange': nodeFromBuiltinTemplate('tpl-reactive-onchange', 'eg-reactive-onchange', 40, 1635, {
      width: 435,
      height: 285,
      title: 'e.g. textarea + onChange + onValidateConnect + broadcast',
    }),
    'eg-edge-channel': nodeFromBuiltinTemplate('tpl-edge-channel-demo', 'eg-edge-channel', 40, 1945, {
      width: 435,
      height: 230,
      title: 'e.g. 边通道 vars.input / vars.output 状态流',
    }),
    'eg-api-poller': nodeFromBuiltinTemplate('tpl-api-poller', 'eg-api-poller', 40, 2200, {
      width: 435,
      height: 325,
      title: 'e.g. API 轮询抓取器（api_poller）',
      defaultVarsPatch: { pollUrl: '/api/health', pollJsonPath: 'status', pollIntervalSec: 15 },
    }),
    'eg-git-gateway': nodeFromBuiltinTemplate('tpl-git-gateway', 'eg-git-gateway', 40, 2550, {
      width: 435,
      height: 380,
      title: 'e.g. git-gateway 仓库看板（git_gateway）',
    }),
    'eg-elyfn-runner': nodeFromBuiltinTemplate('tpl-elyfn-runner', 'eg-elyfn-runner', 40, 2955, {
      width: 435,
      height: 355,
      title: 'e.g. elyfn 函数调用卡（elyfn_runner）',
      defaultVarsPatch: { fnSelected: 'setup/check-pi-env', fnPayload: '{"dryRun": true}' },
    }),
    'eg-pi-agent': nodeFromBuiltinTemplate('tpl-pi-agent', 'eg-pi-agent', 40, 3380, {
      width: 435,
      height: 400,
      title: 'e.g. Pi Agent 运行卡（pi_agent）',
    }),
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
    'ann-zone-media': {
      id: 'ann-zone-media',
      kind: 'text',
      x: 540,
      y: 1270,
      width: 1120,
      height: 46,
      text: 'ZONE E · 媒体与交互控件示例（图片 / 视频 / 拖动条 / 2D Pad / 四态图片按钮 → 下游实时联动）',
      fontSize: 15,
      color: '#4338CA',
      bgColor: '#E0E7FF',
      bgOpacity: 0.85,
      weight: 'bold',
      nonInteractive: true,
      rev: 1,
      cid: 'server-base',
    },
    'ann-zone-fsm': {
      id: 'ann-zone-fsm',
      kind: 'text',
      x: 540,
      y: 1945,
      width: 1090,
      height: 44,
      text: 'ZONE F · 交互式有限状态机示例（IDLE ↔ RUNNING ↔ PAUSED → DONE → IDLE，点激活态按钮即可流转）',
      fontSize: 15,
      color: '#1E293B',
      bgColor: '#FEF3C7',
      bgOpacity: 0.88,
      weight: 'bold',
      nonInteractive: true,
      rev: 1,
      cid: 'server-base',
    },
    'ann-zone-examples': {
      id: 'ann-zone-examples',
      kind: 'text',
      x: 40,
      y: 800,
      width: 435,
      height: 48,
      text: 'ZONE H · 控件全量用法示例（所有 e.g.：点击交互 · 点 ⚙ 查看脚本/配置）',
      fontSize: 14,
      color: '#1E3A8A',
      bgColor: '#DBEAFE',
      bgOpacity: 0.9,
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
      'edge-ctrl-slider': {
        id: 'edge-ctrl-slider',
        source: 'demo-slider-node',
        target: 'demo-controls-monitor',
        sourceHandle: 'out-1',
        targetHandle: 'in-1',
        label: '滑块数值',
        color: '#2563EB',
        rev: 1,
        cid: 'server-base',
      },
      'edge-ctrl-pad2d': {
        id: 'edge-ctrl-pad2d',
        source: 'demo-pad2d-node',
        target: 'demo-controls-monitor',
        sourceHandle: 'out-1',
        targetHandle: 'in-1',
        label: '2D 坐标',
        color: '#D97706',
        rev: 1,
        cid: 'server-base',
      },
      'edge-ctrl-imgbtn': {
        id: 'edge-ctrl-imgbtn',
        source: 'demo-image-button-node',
        target: 'demo-controls-monitor',
        sourceHandle: 'out-1',
        targetHandle: 'in-2',
        label: '四态开关',
        color: '#059669',
        rev: 1,
        cid: 'server-base',
      },
      'edge-fsm-idle-run': {
        id: 'edge-fsm-idle-run',
        source: 'fsm-idle',
        target: 'fsm-running',
        sourceHandle: 'out-1',
        targetHandle: 'in-1',
        label: 'start',
        color: '#2563EB',
        rev: 1,
        cid: 'server-base',
      },
      'edge-fsm-run-idle': {
        id: 'edge-fsm-run-idle',
        source: 'fsm-running',
        target: 'fsm-idle',
        sourceHandle: 'out-1',
        targetHandle: 'in-1',
        label: 'cancel',
        color: '#DC2626',
        dashed: true,
        controlPoints: [
          { x: 1265, y: 2024 },
          { x: 900, y: 2024 },
          { x: 520, y: 2024 },
        ],
        rev: 1,
        cid: 'server-base',
      },
      'edge-fsm-run-pause': {
        id: 'edge-fsm-run-pause',
        source: 'fsm-running',
        target: 'fsm-paused',
        sourceHandle: 'out-1',
        targetHandle: 'in-1',
        label: 'pause',
        color: '#D97706',
        controlPoints: [
          { x: 1262, y: 2290 },
          { x: 1075, y: 2290 },
          { x: 888, y: 2290 },
        ],
        rev: 1,
        cid: 'server-base',
      },
      'edge-fsm-pause-run': {
        id: 'edge-fsm-pause-run',
        source: 'fsm-paused',
        target: 'fsm-running',
        sourceHandle: 'out-1',
        targetHandle: 'in-2',
        label: 'resume',
        color: '#059669',
        dashed: true,
        controlPoints: [
          { x: 1278, y: 2332 },
          { x: 1075, y: 2332 },
          { x: 872, y: 2332 },
        ],
        rev: 1,
        cid: 'server-base',
      },
      'edge-fsm-pause-idle': {
        id: 'edge-fsm-pause-idle',
        source: 'fsm-paused',
        target: 'fsm-idle',
        sourceHandle: 'out-1',
        targetHandle: 'in-2',
        label: 'reset',
        color: '#64748B',
        dashed: true,
        controlPoints: [
          { x: 1265, y: 2585 },
          { x: 860, y: 2585 },
          { x: 520, y: 2380 },
        ],
        rev: 1,
        cid: 'server-base',
      },
      'edge-fsm-run-done': {
        id: 'edge-fsm-run-done',
        source: 'fsm-running',
        target: 'fsm-done',
        sourceHandle: 'out-1',
        targetHandle: 'in-1',
        label: 'finish',
        color: '#7C3AED',
        rev: 1,
        cid: 'server-base',
      },
      'edge-fsm-done-idle': {
        id: 'edge-fsm-done-idle',
        source: 'fsm-done',
        target: 'fsm-idle',
        sourceHandle: 'out-1',
        targetHandle: 'in-2',
        label: 'restart',
        color: '#4F46E5',
        dashed: true,
        controlPoints: [
          { x: 1670, y: 2240 },
          { x: 1670, y: 2630 },
          { x: 1080, y: 2630 },
          { x: 488, y: 2630 },
          { x: 488, y: 2200 },
        ],
        rev: 1,
        cid: 'server-base',
      },
      // ZONE G：Edge 通道版状态机连线（删线即断流，写 msg/flag 边自动高亮流动，手动签收后熄灭）
      'edge-efsm-start': {
        id: 'edge-efsm-start',
        source: 'efsm-idle',
        target: 'efsm-running',
        sourceHandle: 'out-1',
        targetHandle: 'in-1',
        label: 'start',
        color: '#2563EB',
        rev: 1,
        cid: 'server-base',
      },
      'edge-efsm-finish': {
        id: 'edge-efsm-finish',
        source: 'efsm-running',
        target: 'efsm-done',
        sourceHandle: 'out-1',
        targetHandle: 'in-1',
        label: 'finish',
        color: '#059669',
        rev: 1,
        cid: 'server-base',
      },
      'edge-efsm-pause': {
        id: 'edge-efsm-pause',
        source: 'efsm-running',
        target: 'efsm-paused',
        sourceHandle: 'out-2',
        targetHandle: 'in-1',
        label: 'pause',
        color: '#D97706',
        controlPoints: [{ x: 1295, y: 2945 }, { x: 1295, y: 3180 }],
        rev: 1,
        cid: 'server-base',
      },
      'edge-efsm-resume': {
        id: 'edge-efsm-resume',
        source: 'efsm-paused',
        target: 'efsm-running',
        sourceHandle: 'out-1',
        targetHandle: 'in-2',
        label: 'resume',
        color: '#059669',
        controlPoints: [{ x: 895, y: 3165 }, { x: 895, y: 2945 }],
        rev: 1,
        cid: 'server-base',
      },
      'edge-efsm-cancel': {
        id: 'edge-efsm-cancel',
        source: 'efsm-running',
        target: 'efsm-idle',
        sourceHandle: 'out-3',
        targetHandle: 'in-1',
        label: 'cancel',
        color: '#DC2626',
        controlPoints: [{ x: 1280, y: 3045 }, { x: 890, y: 3045 }, { x: 520, y: 2880 }],
        rev: 1,
        cid: 'server-base',
      },
      'edge-efsm-reset': {
        id: 'edge-efsm-reset',
        source: 'efsm-paused',
        target: 'efsm-idle',
        sourceHandle: 'out-2',
        targetHandle: 'in-2',
        label: 'reset',
        color: '#64748B',
        controlPoints: [{ x: 760, y: 3225 }, { x: 520, y: 2955 }],
        rev: 1,
        cid: 'server-base',
      },
      'edge-efsm-restart': {
        id: 'edge-efsm-restart',
        source: 'efsm-done',
        target: 'efsm-idle',
        sourceHandle: 'out-1',
        targetHandle: 'in-2',
        label: 'restart',
        color: '#4F46E5',
        controlPoints: [{ x: 1690, y: 2910 }, { x: 1690, y: 3360 }, { x: 488, y: 3360 }, { x: 488, y: 2955 }],
        rev: 1,
        cid: 'server-base',
      },
      'edge-eg-elyfn-pi': {
        id: 'edge-eg-elyfn-pi',
        source: 'eg-elyfn-runner',
        target: 'eg-pi-agent',
        sourceHandle: 'out-1',
        targetHandle: 'prompt',
        label: '函数结果 → Agent prompt',
        color: '#7C3AED',
        controlPoints: [{ x: 482, y: 3132 }, { x: 482, y: 3345 }, { x: 20, y: 3345 }, { x: 20, y: 3580 }],
        animated: true,
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
