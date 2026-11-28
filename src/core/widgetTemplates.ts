/**
 * @file widgetTemplates.ts
 * @description 内置 13+ 蓝图控件/注释模板库与 IndexedDB 自定义模板持久化管理。
 * 涵盖知识地图、策划与世界观、工程与运维、注释与基础四大分类，支持用户将任意控件一键存为自定义模板。
 */

import { idbGet, idbSet } from './idbStorage';
import { forceBackendProxy } from './runtimeConfig';
import type { BlueprintNode, BlueprintTemplate } from './types';

const CUSTOM_TEMPLATES_KEY = 'atlas-hybrid-custom-templates-v1';

export const USAGE_CHEATSHEET_SCRIPT = String.raw`const tab = String(vars.tab || 'blocks');
const count = Number(vars.demoCount || 0);
const sliderVal = Number(vars.demoSlider ?? 60);
const tabs = [
  { id: 'blocks', label: 'UI 块' },
  { id: 'script', label: '脚本 API' },
  { id: 'graph', label: '联动/边' },
  { id: 'agent', label: '正文/MCP' }
];

const sections = {
  blocks: [
    {
      title: '1) 文本 / 按钮 / 输入框 / 横向行 [...]',
      code: [
        "{ type: 'text', text: '标题', bold: true, color: '#3B82F6' }",
        "[",
        "  { type: 'input', id: 'inp', bind: 'draft', placeholder: '回车提交' },",
        "  { type: 'button', id: 'go', label: '确定', variant: 'primary' }",
        "]",
        "{ type: 'textarea', id: 'memo', bind: 'memoText' }"
      ].join('\n')
    },
    {
      title: '2) 滑块 / 2D面板 / 四态图片按钮',
      code: [
        "{ type: 'slider', id: 's1', bind: 'val', min: 0, max: 100, step: 5, unit: '%' }",
        "{ type: 'pad2d', id: 'p1', bindX: 'px', bindY: 'py', minX: -10, maxX: 10 }",
        "{ type: 'image_button', id: 'ib', bind: 'on', toggle: true, offImage: '...', onImage: '...' }"
      ].join('\n')
    },
    {
      title: '3) 媒体块：图片 / 视频 / PDF',
      code: [
        "{ type: 'image', id: 'im', bindUrl: 'imgUrl', fit: 'contain' }",
        "{ type: 'video', id: 'vd', bindUrl: 'vidUrl', loop: true, muted: true }",
        "{ type: 'pdf', id: 'pf', bindUrl: 'pdfUrl', bindPage: 'pdfPage', height: 300 }"
      ].join('\n')
    },
    {
      title: '4) 工程服务块：轮询 / elyfn / Git / Pi Agent',
      code: [
        "{ type: 'api_poller', id: 'ap', bindUrl: 'pollUrl', bindJsonPath: 'status' }",
        "{ type: 'elyfn_runner', id: 'fn', bindSelectedFn: 'fnSelected', bindPayload: 'fnPayload' }",
        "{ type: 'git_gateway', id: 'gg', bindSelectedRepo: 'gitRepo', bindTab: 'gitTab' }",
        "{ type: 'pi_agent', id: 'pi', bindBaseUrl: 'piBaseUrl' }"
      ].join('\n')
    }
  ],
  script: [
    {
      title: '1) 上下文 & 实时改卡外观（保留 vars 字段）',
      code: [
        "const { id, title, x, y, width, height } = ctx.entity;",
        "vars.title = '新标题';  vars.type = 'TAG';  vars.color = '#DC2626';",
        "vars.width = 460;      vars.height = 320;  vars.pos = { x: 100, y: 200 };"
      ].join('\n')
    },
    {
      title: '2) 内置工具 & 按钮 / 回车事件',
      code: [
        "const n = lib.inc('demoCount', 1);",
        "log('更新时间:', lib.now(), 'count=', n);",
        "on('btnId', async () => { vars.demoStatus = 'clicked'; });",
        "onSubmit('inpId', (val) => { vars.draft = ''; log('提交:', val); });"
      ].join('\n')
    },
    {
      title: '3) 响应式监听 & 自定义连线校验',
      code: [
        "onChange(['valA', 'valB'], () => {",
        "  vars.sum = (Number(vars.valA) || 0) + (Number(vars.valB) || 0);",
        "});",
        "onValidateConnect((info) => (",
        "  info.source === info.target ? { ok: false, reason: '禁止自环' } : { ok: true }",
        "));"
      ].join('\n')
    }
  ],
  graph: [
    {
      title: '1) 读取周围控件 & 端口连线',
      code: [
        "const peer = widgets.get('target-id');",
        "const ins  = widgets.inputs('in-1');   // 上游列表",
        "const outs = widgets.outputs('out-1'); // 下游列表",
        "widgets.checkDag(fromId, toId);        // 判环检测"
      ].join('\n')
    },
    {
      title: '2) 动态创建子卡 & 跨控件发消息',
      code: [
        "await widgets.create({ title: '子卡', dx: 480, dy: 0, connect: '连线标签', vars: {} });",
        "await emit('target-id', 'evt', { x: 1 });",
        "await emitDownstream('ping', { text: 'hi' }, 'out-1');",
        "await broadcast('sync', { at: lib.now() });"
      ].join('\n')
    },
    {
      title: '3) 边通道状态流 (vars.output / vars.input) & 背景注释',
      code: [
        "const out = (vars.output || [])[0];",
        "if (out) { out.msg = { ok: true }; out.flag = true; out.dashed = true; out.color = '#F59E0B'; out.tag = '待签收'; }",
        "const ack = (vars.input || []).find((e) => e.flag);",
        "if (ack) { ack.flag = false; ack.dashed = false; ack.color = ''; }",
        "canvas.setAnnotationBg('ann-zone-0', '#DBEAFE', 0.9);"
      ].join('\n')
    }
  ],
  agent: [
    {
      title: '1) 纯正文 Markdown 卡（不写 vars.contents 时显示 body）',
      code: [
        "- [ ] 未完成任务（画布可直接点击勾选并实时同步）",
        "- [x] 已完成任务"
      ].join('\n')
    },
    {
      title: '2) buttons[] 静态按钮：沙箱脚本 / 安全 HTTP 代理',
      code: [
        "{ id: 'b1', label: '+1', actionType: 'script', code: \"lib.inc('c', 1);\" }",
        "{ id: 'b2', label: 'GET', actionType: 'proxy_http', proxyMethod: 'GET', proxyUrl: 'https://httpbin.org/get' }"
      ].join('\n')
    },
    {
      title: '3) 外部 Agent REST API & 内置 stdio MCP',
      code: [
        "GET  /api/agent/schema",
        "GET  /api/agent/state?room=default   (Header: X-Agent-Api-Key)",
        "POST /api/ops  { dryRun, expectedRevision, ops: [create_from_template | patch_vars | connect_edge] }",
        "MCP: server/mcpServer.ts -> list_templates / get_state / apply_ops"
      ].join('\n')
    }
  ]
};

const activeSections = sections[tab] || sections.blocks;
const docBlocks = [];
for (const sec of activeSections) {
  docBlocks.push({ type: 'text', text: sec.title, fontSize: 11.5, bold: true, color: '#3B82F6' });
  docBlocks.push({ type: 'text', text: sec.code, box: true, mono: true, fontSize: 10.5 });
}

vars.contents = [
  {
    type: 'text',
    text: '点页签切换速查 · 点右上角 ⚙ 可看本卡完整 script · 代码框可直接划选复制',
    align: 'center',
    color: '#3B82F6',
    fontSize: 11,
    bold: true
  },
  tabs.map((t) => ({
    type: 'button',
    id: 'tab_' + t.id,
    label: t.label,
    variant: tab === t.id ? 'primary' : 'secondary'
  })),
  ...docBlocks,
  [
    { type: 'input', id: 'egInput', bind: 'demoDraft', placeholder: '试一下 onSubmit：输入后按回车…' },
    { type: 'button', id: 'egInc', label: '测试 +1 (' + count + ')', width: 108, variant: 'success' }
  ],
  { type: 'slider', id: 'egSlider', bind: 'demoSlider', label: 'onChange 滑动试跑', min: 0, max: 100, step: 5, value: sliderVal, unit: '%' },
  { type: 'text', text: vars.demoStatus || '就绪 · 滑动/输入/点按钮都会在右侧「脚本日志」打印 trace', fontSize: 10.5 }
];

for (const t of tabs) {
  on('tab_' + t.id, () => {
    vars.tab = t.id;
    vars.demoStatus = '已切换速查页签：' + t.label;
  });
}
on('egInc', () => {
  const next = lib.inc('demoCount', 1);
  vars.demoStatus = 'on("egInc") 触发 -> demoCount=' + next + ' @ ' + lib.now();
  log('egInc triggered', { count: next });
});
onSubmit('egInput', (val) => {
  const txt = String(val || '').trim();
  if (!txt) return;
  vars.demoDraft = '';
  vars.demoStatus = 'onSubmit("egInput") 收到：' + txt + ' @ ' + lib.now();
  log('egInput submit:', txt);
});
onChange('demoSlider', (info) => {
  vars.demoStatus = 'onChange("demoSlider") -> ' + info.value + '%';
});`;

export const USAGE_CHEATSHEET_DEFAULT_VARS: Record<string, unknown> = {
  tab: 'blocks',
  demoCount: 0,
  demoDraft: '',
  demoSlider: 60,
  demoStatus: '',
};

export const REACTIVE_ONCHANGE_SCRIPT = String.raw`const valA = Number(vars.valA ?? 12);
const valB = Number(vars.valB ?? 8);
const sum = Number(vars.sum ?? (valA + valB));
const wireCheck = vars.allowConnect !== false;

vars.contents = [
  { type: 'text', text: 'e.g. textarea + onChange(["valA","valB"]) + onValidateConnect + broadcast', align: 'center', color: '#6366F1', fontSize: 11.5, bold: true },
  { type: 'slider', id: 'sA', bind: 'valA', label: '变量 A', min: 0, max: 50, step: 1, value: valA },
  { type: 'slider', id: 'sB', bind: 'valB', label: '变量 B', min: 0, max: 50, step: 1, value: valB },
  { type: 'text', text: '自动派生结果：A + B = ' + sum + ' · ' + (wireCheck ? '连线放行中' : '拒绝新入线'), fontSize: 11.5, color: '#10B981', bold: true },
  { type: 'textarea', id: 'noteArea', bind: 'memo', placeholder: 'textarea 多行输入绑定 vars.memo…' },
  [
    { type: 'button', id: 'toggleWire', label: wireCheck ? '切为拒接连线' : '恢复允许连线', variant: 'secondary' },
    { type: 'button', id: 'bcMemo', label: 'broadcast 广播', variant: 'primary' }
  ],
  { type: 'text', text: vars.statusLine || '拖动 A/B 实时触发 onChange 派生求和；点右侧按钮测连线校验与全画布广播', fontSize: 10.5 }
];

onChange(['valA', 'valB'], () => {
  const nextSum = (Number(vars.valA) || 0) + (Number(vars.valB) || 0);
  vars.sum = nextSum;
  vars.statusLine = 'onChange(["valA","valB"]) 自动算出 sum=' + nextSum;
});

on('toggleWire', () => {
  vars.allowConnect = !Boolean(vars.allowConnect !== false);
  vars.statusLine = vars.allowConnect ? 'onValidateConnect 已切换为放行' : 'onValidateConnect 将拦截新连线';
});

on('bcMemo', async () => {
  const text = String(vars.memo || ('A+B=' + sum)).trim();
  await broadcast('ping', { text });
  vars.statusLine = 'broadcast("ping") 已广播：' + text;
  log('broadcast:', text);
});

onValidateConnect((info) => {
  if (vars.allowConnect === false) {
    return { ok: false, reason: '该控件已通过 onValidateConnect 开关拦截连线' };
  }
  const dag = widgets.checkDag(info.source, info.target);
  if (!dag.ok) {
    return { ok: false, reason: '检测到有向环：' + dag.cyclePath.join(' → ') };
  }
  return { ok: true };
});`;

export const REACTIVE_ONCHANGE_DEFAULT_VARS: Record<string, unknown> = {
  valA: 12,
  valB: 8,
  sum: 20,
  memo: '多行 textarea 示例内容',
  allowConnect: true,
  statusLine: '',
};

export const BUILTIN_TEMPLATES: BlueprintTemplate[] = [
  {
    id: 'tpl-pi-agent',
    name: 'Pi Agent 运行卡',
    description: '连接 pi-runner 桥接服务，支持公开受限输入口模式与管理员完全权限（多轮/插话/中断/审批）模式',
    group: '工程与运维',
    kind: 'node',
    color: '#2563EB',
    nodePreset: {
      width: 410,
      height: 410,
      title: 'Pi Agent 运行卡',
      body: '',
      category: 'Agent',
      color: '#2563EB',
      inputPorts: [{ id: 'prompt', label: '指定输入口 (prompt)' }],
      outputPorts: [{ id: 'out-1', label: 'Agent 输出' }],
      defaultVars: {
        piBaseUrl: '',
        piPublicEnabled: false,
        piAllowedInputPorts: ['prompt'],
        piPromptTemplate: '{{prompt}}',
        piToolProfile: 'readonly',
        piProvider: '',
        piModel: '',
        piLastStatus: 'idle',
        piLastOutput: '',
        piUpdatedAt: '',
      },
      script: String.raw`vars.contents = [
  {
    type: 'pi_agent',
    id: 'piAgent',
    bindBaseUrl: 'piBaseUrl'
  }
];`,
    },
  },
  {
    id: 'tpl-elyfn-runner',
    name: 'elyfn 函数调用卡',
    description: '自动拉取 /catalog 只读函数目录、选择函数、传 JSON 入参一键执行并将结果输出给下游节点',
    group: '工程与运维',
    kind: 'node',
    color: '#7C3AED',
    nodePreset: {
      width: 390,
      height: 360,
      title: 'elyfn 函数调用卡',
      body: '',
      category: 'FaaS',
      color: '#7C3AED',
      inputPorts: [{ id: 'in-1', label: '触发 / 入参' }],
      outputPorts: [{ id: 'out-1', label: '返回结果输出' }],
      defaultVars: {
        fnBaseUrl: '',
        fnSelected: '',
        fnPayload: '{"x": 5}',
        fnAutoRefreshSec: 0,
        fnLastStatus: '',
        fnLastResult: '',
        fnUpdatedAt: '',
      },
      script: String.raw`vars.contents = [
  {
    type: 'elyfn_runner',
    id: 'elyfnRunner',
    bindBaseUrl: 'fnBaseUrl',
    bindSelectedFn: 'fnSelected',
    bindPayload: 'fnPayload',
    bindAutoRefresh: 'fnAutoRefreshSec'
  }
];`,
    },
  },
  {
    id: 'tpl-git-gateway',
    name: 'git-gateway 仓库看板',
    description: '自动拉取 /repos 仓库目录，实时浏览各仓库 Open PR、CI 状态/失败日志与 TODO 列表',
    group: '工程与运维',
    kind: 'node',
    color: '#059669',
    nodePreset: {
      width: 410,
      height: 390,
      title: 'git-gateway 仓库看板',
      body: '',
      category: 'Git',
      color: '#059669',
      outputPorts: [{ id: 'out-1', label: '看板状态输出' }],
      defaultVars: {
        gitBaseUrl: '',
        gitRepo: '',
        gitTab: 'prs',
        gitAutoRefreshSec: 30,
        gitOpenPrCount: 0,
        gitTodoPreview: '',
        gitUpdatedAt: '',
      },
      script: String.raw`vars.contents = [
  {
    type: 'git_gateway',
    id: 'gitGatewayBoard',
    bindBaseUrl: 'gitBaseUrl',
    bindSelectedRepo: 'gitRepo',
    bindTab: 'gitTab',
    bindAutoRefresh: 'gitAutoRefreshSec'
  }
];`,
    },
  },
  {
    id: 'tpl-api-poller',
    name: 'API 轮询抓取器',
    description: '定时轮询抓取接口数据、JSON 路径提取、指数退避与离屏自动暂停',
    group: '工程与运维',
    kind: 'node',
    color: '#0284C7',
    nodePreset: {
      width: 390,
      height: 330,
      title: 'API 轮询抓取器',
      body: '',
      category: '轮询',
      color: '#0284C7',
      inputPorts: [{ id: 'in-1', label: '配置入口' }],
      outputPorts: [{ id: 'out-1', label: '抓取结果输出' }],
      defaultVars: {
        pollUrl: '/api/proxy/status',
        pollMethod: 'GET',
        pollIntervalSec: 10,
        pollJsonPath: '',
        pollUseProxy: forceBackendProxy(),
        pollEnabled: false,
        pollLastValue: '',
        pollStatus: '',
        pollUpdatedAt: '',
      },
      script: String.raw`vars.contents = [
  {
    type: 'api_poller',
    id: 'pollerView',
    bindUrl: 'pollUrl',
    bindMethod: 'pollMethod',
    bindInterval: 'pollIntervalSec',
    bindJsonPath: 'pollJsonPath',
    bindProxy: 'pollUseProxy',
    bindEnabled: 'pollEnabled'
  }
];`,
    },
  },
  {
    id: 'tpl-pdf-reader',
    name: 'PDF 阅读器',
    description: '解包 PDF 为逐页图片，仿 Windows 图片查看器左右翻页与页码直达（fit 控件大小 · 一次性输入）',
    group: '知识地图',
    kind: 'node',
    color: '#DC2626',
    nodePreset: {
      width: 440,
      height: 455,
      title: 'PDF 阅读器',
      body: '',
      category: 'PDF',
      color: '#DC2626',
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
    },
  },
  {
    id: 'tpl-var-morph',
    name: 'vars 控形示例',
    description: '脚本用 vars.type / title / width / height / pos 实时变形与位移',
    group: '知识地图',
    kind: 'node',
    color: '#0D9488',
    nodePreset: {
      title: 'vars 驱动形态示例',
      body: '',
      width: 380,
      height: 205,
      category: '形态',
      color: '#0D9488',
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
    },
  },
  // 一、知识地图
  {
    id: 'tpl-knowledge-card',
    name: '知识概念卡',
    description: '记录核心概念、参考要点与复习熟练度计数',
    group: '知识地图',
    kind: 'node',
    color: '#2563EB',
    nodePreset: {
      width: 280,
      height: 175,
      title: '新知识概念',
      body: '核心定义：\n关键要点：\n关联主题：',
      category: '知识',
      color: '#2563EB',
      defaultVars: { reviewCount: 0, mastery: '学习中' },
      buttons: [
        {
          id: 'btn-review',
          label: '复习 +1',
          variant: 'primary',
          actionType: 'script',
          code: `const n = lib.inc('reviewCount', 1);\nvars.mastery = n >= 3 ? '已掌握' : '巩固中';\nvars.lastReview = lib.now();`,
        },
      ],
    },
  },
  {
    id: 'tpl-milestone',
    name: '任务 / 里程碑卡',
    description: '带完成进度与状态一键切换的计划节点',
    group: '知识地图',
    kind: 'node',
    color: '#059669',
    nodePreset: {
      width: 280,
      height: 175,
      title: '阶段里程碑',
      body: '- [ ] 目标拆解\n- [ ] 关键交付物\n- [ ] 验收标准',
      category: '任务',
      color: '#059669',
      defaultVars: { progress: 0, state: '待开始' },
      buttons: [
        {
          id: 'btn-step',
          label: '进度 +25%',
          variant: 'success',
          actionType: 'script',
          code: `const p = Math.min(100, lib.inc('progress', 25));\nvars.progress = p;\nvars.state = p >= 100 ? '已完成' : '进行中';`,
        },
        {
          id: 'btn-reset-p',
          label: '清零',
          variant: 'secondary',
          actionType: 'script',
          code: `vars.progress = 0;\nvars.state = '待开始';`,
        },
      ],
    },
  },
  {
    id: 'tpl-decision',
    name: '对比决策卡',
    description: '用于方案取舍、利弊记录与团队投票计数',
    group: '知识地图',
    kind: 'node',
    color: '#7C3AED',
    nodePreset: {
      width: 290,
      height: 180,
      title: '方案对比与结论',
      body: '优点：\n缺点 / 风险：\n当前结论：',
      category: '决策',
      color: '#7C3AED',
      defaultVars: { agree: 0, reject: 0 },
      buttons: [
        {
          id: 'btn-agree',
          label: '赞成 +1',
          variant: 'success',
          actionType: 'script',
          code: `lib.inc('agree', 1);`,
        },
        {
          id: 'btn-reject',
          label: '反对 +1',
          variant: 'danger',
          actionType: 'script',
          code: `lib.inc('reject', 1);`,
        },
      ],
    },
  },

  // 二、策划与世界观
  {
    id: 'tpl-world-zone',
    name: '世界观 / 区域设定',
    description: '大地图策划区域、势力分布与审阅状态',
    group: '策划与世界观',
    kind: 'node',
    color: '#0F766E',
    nodePreset: {
      width: 290,
      height: 185,
      title: '未命名区域设定',
      body: '地貌与氛围：\n主导势力：\n核心冲突 / 探索奖励：',
      category: '世界观',
      color: '#0F766E',
      defaultVars: { dangerLv: 1, review: '草稿' },
      buttons: [
        {
          id: 'btn-lv',
          label: '危险等级 +1',
          variant: 'secondary',
          actionType: 'script',
          code: `lib.inc('dangerLv', 1);`,
        },
        {
          id: 'btn-pass',
          label: '标记终稿',
          variant: 'success',
          actionType: 'script',
          code: `vars.review = '终稿';\nvars.approvedAt = lib.now();`,
        },
      ],
    },
  },
  {
    id: 'tpl-quest-node',
    name: '剧情 / 关卡节点',
    description: '串联主线支线、触发条件与通关奖励',
    group: '策划与世界观',
    kind: 'node',
    color: '#D97706',
    nodePreset: {
      width: 280,
      height: 180,
      title: '第 X 章 · 关卡事件',
      body: '触发条件：\n核心玩法 / 剧情转折：\n分支走向：',
      category: '剧情',
      color: '#D97706',
      defaultVars: { exp: 500, tested: false },
      buttons: [
        {
          id: 'btn-test',
          label: '标记已白盒测试',
          variant: 'primary',
          actionType: 'script',
          code: `vars.tested = true;\nvars.testedAt = lib.now();`,
        },
      ],
    },
  },
  {
    id: 'tpl-character',
    name: '角色 / NPC 档案',
    description: '含基础属性变量与一键模拟升级计算',
    group: '策划与世界观',
    kind: 'node',
    color: '#BE123C',
    nodePreset: {
      width: 280,
      height: 185,
      title: '角色名 · 阵营',
      body: '性格标签：\n核心动机：\n与其他角色关系：',
      category: '角色',
      color: '#BE123C',
      defaultVars: { lv: 1, hp: 100, atk: 18 },
      buttons: [
        {
          id: 'btn-levelup',
          label: '模拟升级 +1',
          variant: 'primary',
          actionType: 'script',
          code: `const lv = lib.inc('lv', 1);\nvars.hp = 100 + (lv - 1) * 25;\nvars.atk = 18 + (lv - 1) * 5;`,
        },
      ],
    },
  },

  // 三、工程与运维
  {
    id: 'tpl-api-service',
    name: '微服务 / API 节点',
    description: '带服务端代理探活按钮与响应状态记录',
    group: '工程与运维',
    kind: 'node',
    color: '#1D4ED8',
    nodePreset: {
      width: 300,
      height: 185,
      title: 'API 服务节点',
      body: '职责说明：\n上游依赖 / 下游调用：\nSLA 目标：99.9%',
      category: 'SERVICE',
      color: '#1D4ED8',
      defaultVars: { env: 'prod', healthy: true },
      buttons: [
        {
          id: 'btn-ping',
          label: '代理探活 GET',
          variant: 'primary',
          actionType: 'proxy_http',
          proxyUrl: 'https://httpbin.org/get?service=ping',
          proxyMethod: 'GET',
        },
      ],
    },
  },
  {
    id: 'tpl-metric-card',
    name: '监控指标卡',
    description: '模拟负载采样、延迟告警阈值演示',
    group: '工程与运维',
    kind: 'node',
    color: '#B45309',
    nodePreset: {
      width: 270,
      height: 170,
      title: '集群负载监控',
      body: '关注指标：P99 延迟、错误率与 CPU 负载',
      category: 'OPS',
      color: '#B45309',
      defaultVars: { cpu: 0.35, alert: '正常' },
      buttons: [
        {
          id: 'btn-sample',
          label: '负载 +0.15',
          variant: 'danger',
          actionType: 'script',
          code: `const c = Math.min(1, lib.inc('cpu', 0.15));\nvars.cpu = c;\nvars.alert = c >= 0.8 ? '告警' : '正常';`,
        },
      ],
    },
  },
  {
    id: 'tpl-gateway',
    name: '条件分支 / 路由网关',
    description: '用于架构蓝图中的流量或逻辑分流说明',
    group: '工程与运维',
    kind: 'node',
    color: '#0369A1',
    nodePreset: {
      width: 260,
      height: 165,
      title: '路由网关节点',
      body: '路由规则：按区域 / 灰度比例分发',
      category: 'GATEWAY',
      color: '#0369A1',
      defaultVars: { canaryRatio: 10 },
      buttons: [
        {
          id: 'btn-canary',
          label: '灰度 +10%',
          variant: 'secondary',
          actionType: 'script',
          code: `vars.canaryRatio = ((Number(vars.canaryRatio) || 0) + 10) % 110;`,
        },
      ],
    },
  },

  {
    id: 'tpl-script-spawner',
    name: '跨控件联动控制台（脚本）',
    description: '内置输入框+回车发送+动态造子控件+emit消息通信',
    group: '工程与运维',
    kind: 'node',
    color: '#2563EB',
    nodePreset: {
      width: 380,
      height: 210,
      title: '联动控制台',
      body: '',
      category: '联动',
      color: '#2563EB',
      defaultVars: { draft: '', count: 0 },
      script: `vars.contents = [
  { type: 'text', text: '输入消息后按回车广播给全画布脚本控件', align: 'center', color: '#1E40AF', fontSize: 12, bold: true },
  [
    { type: 'input', id: 'bcInput', bind: 'draft', placeholder: '输入广播内容（回车发送）...' },
    { type: 'button', id: 'bcSend', label: '广播', width: 64, variant: 'primary' }
  ],
  { type: 'text', text: vars.status || '等待广播…', fontSize: 11, color: '#475569' }
];
async function doBroadcast(raw) {
  const txt = String(raw ?? vars.draft ?? '').trim();
  if (!txt) { vars.status = '内容不能为空'; return; }
  await broadcast('ping', { text: txt });
  vars.draft = '';
  vars.count = (Number(vars.count) || 0) + 1;
  vars.status = '已广播 #' + vars.count + '：' + txt;
}
on('bcSend', async () => doBroadcast(vars.draft));
onSubmit('bcInput', async (v) => doBroadcast(v));`,
    },
  },
  {
    id: 'tpl-usage-cheatsheet',
    name: '全能控件用法示例卡 (e.g.)',
    description: '一卡切换速查所有 14 种 vars.contents 声明块、沙箱事件 API、跨控件通信与 Agent/MCP 用法',
    group: '知识地图',
    kind: 'node',
    color: '#1D4ED8',
    nodePreset: {
      width: 470,
      height: 520,
      title: 'e.g. 全能控件用法百科',
      body: '',
      category: 'e.g.',
      color: '#1D4ED8',
      defaultVars: { ...USAGE_CHEATSHEET_DEFAULT_VARS },
      script: USAGE_CHEATSHEET_SCRIPT,
    },
  },
  {
    id: 'tpl-reactive-onchange',
    name: '响应式与校验示例 (onChange / onValidateConnect)',
    description: '演示 textarea 多行输入、onChange 多键派生、broadcast 全局广播与 onValidateConnect 连线拦截',
    group: '工程与运维',
    kind: 'node',
    color: '#4338CA',
    nodePreset: {
      width: 410,
      height: 285,
      title: '响应式与连线校验示例',
      body: '',
      category: '脚本API',
      color: '#4338CA',
      inputPorts: [{ id: 'in-1', label: '校验入口' }],
      outputPorts: [{ id: 'out-1', label: '派生出口' }],
      defaultVars: { ...REACTIVE_ONCHANGE_DEFAULT_VARS },
      script: REACTIVE_ONCHANGE_SCRIPT,
    },
  },
  {
    id: 'tpl-edge-channel-demo',
    name: '连线通道消息示例 (vars.input / vars.output)',
    description: '演示直接读写边寄存器 edge.msg / flag / dashed / color / tag 实现有向带样式状态流转',
    group: '工程与运维',
    kind: 'node',
    color: '#0F766E',
    nodePreset: {
      width: 380,
      height: 230,
      title: '连线通道收发示例',
      body: '',
      category: '边通道',
      color: '#0F766E',
      inputPorts: [{ id: 'in-1', label: '令牌入口' }],
      outputPorts: [{ id: 'out-1', label: '令牌出口' }],
      defaultVars: { lastReceived: '' },
      script: String.raw`const outs = vars.output || [];
const pendingIn = (vars.input || []).find((e) => e.flag);
vars.contents = [
  { type: 'text', text: pendingIn ? '收到待签收令牌：' + JSON.stringify(pendingIn.msg) : '出线数=' + outs.length + ' · 入线无待签收令牌', fontSize: 11.5, color: pendingIn ? '#F59E0B' : '#10B981', bold: true },
  { type: 'text', text: vars.lastReceived || '写法：const e = vars.output[0]; e.msg = {...}; e.flag = true; e.dashed = true; e.color = "#F59E0B";', fontSize: 10.5 },
  [
    { type: 'button', id: 'sendEdge', label: '写入出线令牌', variant: 'primary', disabled: outs.length === 0 },
    { type: 'button', id: 'ackEdge', label: '签收入线令牌', variant: 'success', disabled: !pendingIn }
  ]
];
on('sendEdge', () => {
  const edge = (vars.output || [])[0];
  if (!edge) return;
  edge.msg = { from: ctx.entity.title, at: lib.now() };
  edge.flag = true;
  edge.dashed = true;
  edge.color = '#F59E0B';
  edge.tag = '待签收';
});
on('ackEdge', () => {
  const edge = (vars.input || []).find((e) => e.flag);
  if (!edge) return;
  vars.lastReceived = '已签收 @ ' + lib.now() + '：' + JSON.stringify(edge.msg);
  edge.flag = false;
  edge.dashed = false;
  edge.color = '';
  edge.tag = '已签收';
});`,
    },
  },

  // 四、注释与基础
  {
    id: 'tpl-blank-widget',
    name: '空白自由控件',
    description: '无预设按钮的干净节点，随时点击编辑扩展',
    group: '注释与基础',
    kind: 'node',
    color: '#334155',
    nodePreset: {
      width: 260,
      height: 150,
      title: '新控件',
      body: '双击或点击此处直接输入正文内容…',
      category: '通用',
      color: '#334155',
      defaultVars: {},
      buttons: [],
    },
  },
  {
    id: 'tpl-ann-textbox',
    name: '背景文本框（色块）',
    description: '支持设文字颜色与色块底色，也能被控件脚本动态变色',
    group: '注释与基础',
    kind: 'annotation',
    color: '#B45309',
    annotationPreset: {
      kind: 'text',
      width: 360,
      height: 110,
      text: '色块文本框\n支持多行自动换行不拉伸，开启注释编辑可随时调色',
      fontSize: 16,
      color: '#78350F',
      bgColor: '#FEF3C7',
      bgOpacity: 0.9,
      weight: 'bold',
      nonInteractive: true,
    },
  },
  {
    id: 'tpl-ann-header',
    name: '区域大标题（透明穿透）',
    description: '30px 粗体地图分区标牌，缩远全景依然清晰',
    group: '注释与基础',
    kind: 'annotation',
    color: '#0F766E',
    annotationPreset: {
      kind: 'text',
      width: 480,
      height: 68,
      text: '新区域大标题 · 拖动定位',
      fontSize: 28,
      color: '#0F766E',
      bgColor: 'transparent',
      bgOpacity: 0,
      weight: 'bold',
      nonInteractive: true,
    },
  },
  {
    id: 'tpl-image-node',
    name: '图片节点',
    description: '纯外链图片节点，支持等比/裁切切换、Portal 大图灯箱预览与视口裁剪',
    group: '注释与基础',
    kind: 'node',
    color: '#4F46E5',
    nodePreset: {
      title: '图片画板',
      body: '',
      width: 360,
      height: 270,
      category: '图片',
      color: '#4F46E5',
      defaultVars: {
        imageUrl: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 360 220'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%23EEF2FF'/%3E%3Cstop offset='100%25' stop-color='%23E0E7FF'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='360' height='220' fill='url(%23g)'/%3E%3Ccircle cx='118' cy='86' r='30' fill='%234F46E5' fill-opacity='0.22'/%3E%3Cpath d='M52 174 L142 104 L212 152 L262 118 L314 174 Z' fill='%234F46E5' fill-opacity='0.3'/%3E%3Ctext x='180' y='198' text-anchor='middle' font-family='sans-serif' font-size='13' fill='%23312E81'%3E悬停右上角可更换图片 · 支持本地上传与大图预览%3C/text%3E%3C/svg%3E",
        imageFit: 'contain',
        imageCaption: '示例图片（悬停右上角可换图或全屏预览）',
      },
      script: String.raw`vars.contents = [
  { type: 'image', id: 'imgMain', bindUrl: 'imageUrl', bindFit: 'imageFit', bindCaption: 'imageCaption' }
];`,
      inputPorts: [{ id: 'in-1', label: '输入' }],
      outputPorts: [{ id: 'out-1', label: '输出' }],
    },
  },
  {
    id: 'tpl-video-node',
    name: '视频节点',
    description: '纯外链 MP4/WebM 视频节点，带倍速/循环/静音与移出视口自动暂停',
    group: '注释与基础',
    kind: 'node',
    color: '#E11D48',
    nodePreset: {
      title: '视频播放器',
      body: '',
      width: 420,
      height: 300,
      category: '视频',
      color: '#E11D48',
      defaultVars: {
        videoUrl: '',
        videoLoop: false,
        videoMuted: false,
      },
      script: String.raw`vars.contents = [
  { type: 'video', id: 'vidMain', bindUrl: 'videoUrl', bindLoop: 'videoLoop', bindMuted: 'videoMuted' }
];`,
      inputPorts: [{ id: 'in-1', label: '输入' }],
      outputPorts: [{ id: 'out-1', label: '输出' }],
    },
  },
  {
    id: 'tpl-slider-node',
    name: '拖动条控件',
    description: '实时拖动调节数值并触发脚本 onChange，可连线驱动下游节点参数',
    group: '知识地图',
    kind: 'node',
    color: '#2563EB',
    nodePreset: {
      title: '参数拖动条',
      body: '',
      width: 320,
      height: 200,
      category: '滑块',
      color: '#2563EB',
      defaultVars: {
        value: 50,
        scale: 1.0,
      },
      script: String.raw`const v = Number(vars.value ?? 50);
const s = Number(vars.scale ?? 1.0);
const result = Math.round(v * s * 10) / 10;

vars.contents = [
  { type: 'slider', id: 'sVal', bind: 'value', label: '主参数', min: 0, max: 100, step: 1, unit: '%', accentColor: '#2563EB' },
  { type: 'slider', id: 'sScale', bind: 'scale', label: '倍率系数', min: 0.5, max: 3, step: 0.1, unit: '×', accentColor: '#0D9488' },
  { type: 'text', text: '综合输出：' + result, align: 'center', color: '#1E293B', fontSize: 12, bold: true }
];

onChange(['value', 'scale'], () => {
  const nextVal = Number(vars.value ?? 50);
  const nextScale = Number(vars.scale ?? 1.0);
  vars.output = Math.round(nextVal * nextScale * 10) / 10;
});`,
      inputPorts: [],
      outputPorts: [{ id: 'out-1', label: '数值输出' }],
    },
  },
  {
    id: 'tpl-pad2d-node',
    name: '2D Pad 拖动板',
    description: '深色二维触控板（十字准星 + 发光拖拽球 + 双击归中），可实时输出 X/Y 坐标联动下游',
    group: '知识地图',
    kind: 'node',
    color: '#D97706',
    nodePreset: {
      title: '2D Pad 控制器',
      body: '',
      width: 310,
      height: 310,
      category: '2D Pad',
      color: '#D97706',
      defaultVars: {
        padX: 0,
        padY: 0,
      },
      script: String.raw`const x = Number(vars.padX ?? 0);
const y = Number(vars.padY ?? 0);

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
  {
    type: 'text',
    text: '当前向量：(' + x + ', ' + y + ')',
    align: 'center',
    color: '#334155',
    fontSize: 12,
    bold: true
  }
];

onChange(['padX', 'padY'], () => {
  const vx = Number(vars.padX ?? 0);
  const vy = Number(vars.padY ?? 0);
  vars.magnitude = Math.round(Math.hypot(vx, vy) * 10) / 10;
});`,
      inputPorts: [],
      outputPorts: [{ id: 'out-1', label: 'XY 输出' }],
    },
  },
  {
    id: 'tpl-image-button-node',
    name: '图片按钮 (4态)',
    description: '用图片替代按钮，支持 on / off / hover / click 四种状态贴图与悬停快捷换图',
    group: '知识地图',
    kind: 'node',
    color: '#059669',
    nodePreset: {
      title: '四态图片按钮',
      body: '',
      width: 300,
      height: 215,
      category: '图钮',
      color: '#059669',
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
    text: '状态：' + (isOn ? 'ON' : 'OFF') + ' · 累计点击 ' + clicks + ' 次',
    align: 'center',
    color: isOn ? '#047857' : '#475569',
    fontSize: 12,
    bold: true
  }
];

on('imgToggleBtn', () => {
  vars.clicks = Number(vars.clicks ?? 0) + 1;
});`,
      inputPorts: [{ id: 'in-1', label: '输入' }],
      outputPorts: [{ id: 'out-1', label: '状态输出' }],
    },
  },
  {
    id: 'tpl-ann-image',
    name: '背景插图（等比不拉伸）',
    description: '所见即所得插图组件，支持换本地图与设背景色块',
    group: '注释与基础',
    kind: 'annotation',
    color: '#2563EB',
    annotationPreset: {
      kind: 'image',
      width: 320,
      height: 200,
      text: '示例背景插图',
      fontSize: 14,
      color: '#1E293B',
      bgColor: '#FFFFFF',
      bgOpacity: 0.9,
      imageUrl: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 200'%3E%3Crect width='320' height='200' rx='14' fill='%23EFF6FF'/%3E%3Ccircle cx='90' cy='78' r='28' fill='%232563EB' fill-opacity='0.2' stroke='%232563EB' stroke-width='3'/%3E%3Crect x='170' y='52' width='104' height='52' rx='8' fill='%230F766E' fill-opacity='0.18' stroke='%230F766E' stroke-width='3'/%3E%3Cpath d='M118 78 L168 78' stroke='%23475569' stroke-width='3' stroke-dasharray='6 4'/%3E%3Ctext x='160' y='156' text-anchor='middle' font-family='sans-serif' font-size='16' font-weight='700' fill='%231E293B'%3E示例背景插图（等比缩放不拉伸）%3C/text%3E%3C/svg%3E",
      weight: 'normal',
      nonInteractive: true,
    },
  },
];

export async function loadCustomTemplates(): Promise<BlueprintTemplate[]> {
  const saved = await idbGet<unknown>(CUSTOM_TEMPLATES_KEY);
  if (!Array.isArray(saved)) return [];
  return saved.filter((item): item is BlueprintTemplate => {
    if (!item || typeof item !== 'object') return false;
    const t = item as Partial<BlueprintTemplate>;
    if (typeof t.id !== 'string' || !t.id.trim()) return false;
    if (typeof t.name !== 'string' || !t.name.trim()) return false;
    if (typeof t.color !== 'string') return false;
    if (t.kind === 'node') {
      return Boolean(t.nodePreset && typeof t.nodePreset === 'object' && typeof t.nodePreset.title === 'string');
    }
    if (t.kind === 'annotation') {
      return Boolean(t.annotationPreset && typeof t.annotationPreset === 'object');
    }
    return false;
  });
}

export async function saveCustomTemplates(templates: BlueprintTemplate[]): Promise<void> {
  await idbSet(CUSTOM_TEMPLATES_KEY, templates);
}

export function nodeToCustomTemplate(node: BlueprintNode, name: string): BlueprintTemplate {
  return {
    id: `custom-tpl-${Date.now()}`,
    name: name.trim() || node.title,
    description: `基于「${node.title}」保存的自定义模板`,
    group: '我的模板',
    kind: 'node',
    color: node.color,
    nodePreset: {
      width: node.width,
      height: node.height,
      title: node.title,
      body: node.body,
      category: node.category,
      color: node.color,
      script: node.script,
      defaultVars: { ...node.defaultVars },
      buttons: node.buttons ? node.buttons.map((b) => ({ ...b })) : [],
      inputPorts: node.inputPorts ? node.inputPorts.map((p) => ({ ...p })) : undefined,
      outputPorts: node.outputPorts ? node.outputPorts.map((p) => ({ ...p })) : undefined,
    },
  };
}
