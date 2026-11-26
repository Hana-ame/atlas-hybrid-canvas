/**
 * @file widgetTemplates.ts
 * @description 内置 13+ 蓝图控件/注释模板库与 IndexedDB 自定义模板持久化管理。
 * 涵盖知识地图、策划与世界观、工程与运维、注释与基础四大分类，支持用户将任意控件一键存为自定义模板。
 */

import { idbGet, idbSet } from './idbStorage';
import { forceBackendProxy } from './runtimeConfig';
import type { BlueprintNode, BlueprintTemplate } from './types';

const CUSTOM_TEMPLATES_KEY = 'atlas-hybrid-custom-templates-v1';

export const BUILTIN_TEMPLATES: BlueprintTemplate[] = [
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
