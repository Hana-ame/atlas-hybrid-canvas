// server/mcpServer.ts
import readline from "node:readline";

// src/core/apiPoller.ts
var MAX_BACKOFF_DELAY_MS = 5 * 60 * 1e3;

// src/core/runtimeConfig.ts
var RAW_BACKEND_WS_URL = String((import.meta.env ?? {}).VITE_BACKEND_WS_URL ?? "").trim();
var RAW_FORCE_BACKEND_PROXY = String(
  (import.meta.env ?? {}).VITE_FORCE_BACKEND_PROXY ?? ""
).trim();
function parseForceBackendProxy(raw) {
  const norm = String(raw ?? "").trim().toLowerCase();
  if (norm === "false" || norm === "0" || norm === "off" || norm === "no") {
    return false;
  }
  return true;
}
function forceBackendProxy() {
  return parseForceBackendProxy(RAW_FORCE_BACKEND_PROXY);
}

// src/core/widgetTemplates.ts
var BUILTIN_TEMPLATES = [
  {
    id: "tpl-api-poller",
    name: "API \u8F6E\u8BE2\u6293\u53D6\u5668",
    description: "\u5B9A\u65F6\u8F6E\u8BE2\u6293\u53D6\u63A5\u53E3\u6570\u636E\u3001JSON \u8DEF\u5F84\u63D0\u53D6\u3001\u6307\u6570\u9000\u907F\u4E0E\u79BB\u5C4F\u81EA\u52A8\u6682\u505C",
    group: "\u5DE5\u7A0B\u4E0E\u8FD0\u7EF4",
    kind: "node",
    color: "#0284C7",
    nodePreset: {
      width: 390,
      height: 330,
      title: "API \u8F6E\u8BE2\u6293\u53D6\u5668",
      body: "",
      category: "\u8F6E\u8BE2",
      color: "#0284C7",
      inputPorts: [{ id: "in-1", label: "\u914D\u7F6E\u5165\u53E3" }],
      outputPorts: [{ id: "out-1", label: "\u6293\u53D6\u7ED3\u679C\u8F93\u51FA" }],
      defaultVars: {
        pollUrl: "/api/proxy/status",
        pollMethod: "GET",
        pollIntervalSec: 10,
        pollJsonPath: "",
        pollUseProxy: forceBackendProxy(),
        pollEnabled: false,
        pollLastValue: "",
        pollStatus: "",
        pollUpdatedAt: ""
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
];`
    }
  },
  {
    id: "tpl-pdf-reader",
    name: "PDF \u9605\u8BFB\u5668",
    description: "\u89E3\u5305 PDF \u4E3A\u9010\u9875\u56FE\u7247\uFF0C\u4EFF Windows \u56FE\u7247\u67E5\u770B\u5668\u5DE6\u53F3\u7FFB\u9875\u4E0E\u9875\u7801\u76F4\u8FBE\uFF08fit \u63A7\u4EF6\u5927\u5C0F \xB7 \u4E00\u6B21\u6027\u8F93\u5165\uFF09",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#DC2626",
    nodePreset: {
      width: 440,
      height: 455,
      title: "PDF \u9605\u8BFB\u5668",
      body: "",
      category: "PDF",
      color: "#DC2626",
      defaultVars: { pdfUrl: "", pdfPage: 1, pdfUseProxy: false },
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
];`
    }
  },
  {
    id: "tpl-var-morph",
    name: "vars \u63A7\u5F62\u793A\u4F8B",
    description: "\u811A\u672C\u7528 vars.type / title / width / height / pos \u5B9E\u65F6\u53D8\u5F62\u4E0E\u4F4D\u79FB",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#0D9488",
    nodePreset: {
      title: "vars \u9A71\u52A8\u5F62\u6001\u793A\u4F8B",
      body: "",
      width: 380,
      height: 205,
      category: "\u5F62\u6001",
      color: "#0D9488",
      defaultVars: { modeIdx: 0, expanded: false, titleDraft: "" },
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
});`
    }
  },
  // 一、知识地图
  {
    id: "tpl-knowledge-card",
    name: "\u77E5\u8BC6\u6982\u5FF5\u5361",
    description: "\u8BB0\u5F55\u6838\u5FC3\u6982\u5FF5\u3001\u53C2\u8003\u8981\u70B9\u4E0E\u590D\u4E60\u719F\u7EC3\u5EA6\u8BA1\u6570",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#2563EB",
    nodePreset: {
      width: 280,
      height: 175,
      title: "\u65B0\u77E5\u8BC6\u6982\u5FF5",
      body: "\u6838\u5FC3\u5B9A\u4E49\uFF1A\n\u5173\u952E\u8981\u70B9\uFF1A\n\u5173\u8054\u4E3B\u9898\uFF1A",
      category: "\u77E5\u8BC6",
      color: "#2563EB",
      defaultVars: { reviewCount: 0, mastery: "\u5B66\u4E60\u4E2D" },
      buttons: [
        {
          id: "btn-review",
          label: "\u590D\u4E60 +1",
          variant: "primary",
          actionType: "script",
          code: `const n = lib.inc('reviewCount', 1);
vars.mastery = n >= 3 ? '\u5DF2\u638C\u63E1' : '\u5DE9\u56FA\u4E2D';
vars.lastReview = lib.now();`
        }
      ]
    }
  },
  {
    id: "tpl-milestone",
    name: "\u4EFB\u52A1 / \u91CC\u7A0B\u7891\u5361",
    description: "\u5E26\u5B8C\u6210\u8FDB\u5EA6\u4E0E\u72B6\u6001\u4E00\u952E\u5207\u6362\u7684\u8BA1\u5212\u8282\u70B9",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#059669",
    nodePreset: {
      width: 280,
      height: 175,
      title: "\u9636\u6BB5\u91CC\u7A0B\u7891",
      body: "- [ ] \u76EE\u6807\u62C6\u89E3\n- [ ] \u5173\u952E\u4EA4\u4ED8\u7269\n- [ ] \u9A8C\u6536\u6807\u51C6",
      category: "\u4EFB\u52A1",
      color: "#059669",
      defaultVars: { progress: 0, state: "\u5F85\u5F00\u59CB" },
      buttons: [
        {
          id: "btn-step",
          label: "\u8FDB\u5EA6 +25%",
          variant: "success",
          actionType: "script",
          code: `const p = Math.min(100, lib.inc('progress', 25));
vars.progress = p;
vars.state = p >= 100 ? '\u5DF2\u5B8C\u6210' : '\u8FDB\u884C\u4E2D';`
        },
        {
          id: "btn-reset-p",
          label: "\u6E05\u96F6",
          variant: "secondary",
          actionType: "script",
          code: `vars.progress = 0;
vars.state = '\u5F85\u5F00\u59CB';`
        }
      ]
    }
  },
  {
    id: "tpl-decision",
    name: "\u5BF9\u6BD4\u51B3\u7B56\u5361",
    description: "\u7528\u4E8E\u65B9\u6848\u53D6\u820D\u3001\u5229\u5F0A\u8BB0\u5F55\u4E0E\u56E2\u961F\u6295\u7968\u8BA1\u6570",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#7C3AED",
    nodePreset: {
      width: 290,
      height: 180,
      title: "\u65B9\u6848\u5BF9\u6BD4\u4E0E\u7ED3\u8BBA",
      body: "\u4F18\u70B9\uFF1A\n\u7F3A\u70B9 / \u98CE\u9669\uFF1A\n\u5F53\u524D\u7ED3\u8BBA\uFF1A",
      category: "\u51B3\u7B56",
      color: "#7C3AED",
      defaultVars: { agree: 0, reject: 0 },
      buttons: [
        {
          id: "btn-agree",
          label: "\u8D5E\u6210 +1",
          variant: "success",
          actionType: "script",
          code: `lib.inc('agree', 1);`
        },
        {
          id: "btn-reject",
          label: "\u53CD\u5BF9 +1",
          variant: "danger",
          actionType: "script",
          code: `lib.inc('reject', 1);`
        }
      ]
    }
  },
  // 二、策划与世界观
  {
    id: "tpl-world-zone",
    name: "\u4E16\u754C\u89C2 / \u533A\u57DF\u8BBE\u5B9A",
    description: "\u5927\u5730\u56FE\u7B56\u5212\u533A\u57DF\u3001\u52BF\u529B\u5206\u5E03\u4E0E\u5BA1\u9605\u72B6\u6001",
    group: "\u7B56\u5212\u4E0E\u4E16\u754C\u89C2",
    kind: "node",
    color: "#0F766E",
    nodePreset: {
      width: 290,
      height: 185,
      title: "\u672A\u547D\u540D\u533A\u57DF\u8BBE\u5B9A",
      body: "\u5730\u8C8C\u4E0E\u6C1B\u56F4\uFF1A\n\u4E3B\u5BFC\u52BF\u529B\uFF1A\n\u6838\u5FC3\u51B2\u7A81 / \u63A2\u7D22\u5956\u52B1\uFF1A",
      category: "\u4E16\u754C\u89C2",
      color: "#0F766E",
      defaultVars: { dangerLv: 1, review: "\u8349\u7A3F" },
      buttons: [
        {
          id: "btn-lv",
          label: "\u5371\u9669\u7B49\u7EA7 +1",
          variant: "secondary",
          actionType: "script",
          code: `lib.inc('dangerLv', 1);`
        },
        {
          id: "btn-pass",
          label: "\u6807\u8BB0\u7EC8\u7A3F",
          variant: "success",
          actionType: "script",
          code: `vars.review = '\u7EC8\u7A3F';
vars.approvedAt = lib.now();`
        }
      ]
    }
  },
  {
    id: "tpl-quest-node",
    name: "\u5267\u60C5 / \u5173\u5361\u8282\u70B9",
    description: "\u4E32\u8054\u4E3B\u7EBF\u652F\u7EBF\u3001\u89E6\u53D1\u6761\u4EF6\u4E0E\u901A\u5173\u5956\u52B1",
    group: "\u7B56\u5212\u4E0E\u4E16\u754C\u89C2",
    kind: "node",
    color: "#D97706",
    nodePreset: {
      width: 280,
      height: 180,
      title: "\u7B2C X \u7AE0 \xB7 \u5173\u5361\u4E8B\u4EF6",
      body: "\u89E6\u53D1\u6761\u4EF6\uFF1A\n\u6838\u5FC3\u73A9\u6CD5 / \u5267\u60C5\u8F6C\u6298\uFF1A\n\u5206\u652F\u8D70\u5411\uFF1A",
      category: "\u5267\u60C5",
      color: "#D97706",
      defaultVars: { exp: 500, tested: false },
      buttons: [
        {
          id: "btn-test",
          label: "\u6807\u8BB0\u5DF2\u767D\u76D2\u6D4B\u8BD5",
          variant: "primary",
          actionType: "script",
          code: `vars.tested = true;
vars.testedAt = lib.now();`
        }
      ]
    }
  },
  {
    id: "tpl-character",
    name: "\u89D2\u8272 / NPC \u6863\u6848",
    description: "\u542B\u57FA\u7840\u5C5E\u6027\u53D8\u91CF\u4E0E\u4E00\u952E\u6A21\u62DF\u5347\u7EA7\u8BA1\u7B97",
    group: "\u7B56\u5212\u4E0E\u4E16\u754C\u89C2",
    kind: "node",
    color: "#BE123C",
    nodePreset: {
      width: 280,
      height: 185,
      title: "\u89D2\u8272\u540D \xB7 \u9635\u8425",
      body: "\u6027\u683C\u6807\u7B7E\uFF1A\n\u6838\u5FC3\u52A8\u673A\uFF1A\n\u4E0E\u5176\u4ED6\u89D2\u8272\u5173\u7CFB\uFF1A",
      category: "\u89D2\u8272",
      color: "#BE123C",
      defaultVars: { lv: 1, hp: 100, atk: 18 },
      buttons: [
        {
          id: "btn-levelup",
          label: "\u6A21\u62DF\u5347\u7EA7 +1",
          variant: "primary",
          actionType: "script",
          code: `const lv = lib.inc('lv', 1);
vars.hp = 100 + (lv - 1) * 25;
vars.atk = 18 + (lv - 1) * 5;`
        }
      ]
    }
  },
  // 三、工程与运维
  {
    id: "tpl-api-service",
    name: "\u5FAE\u670D\u52A1 / API \u8282\u70B9",
    description: "\u5E26\u670D\u52A1\u7AEF\u4EE3\u7406\u63A2\u6D3B\u6309\u94AE\u4E0E\u54CD\u5E94\u72B6\u6001\u8BB0\u5F55",
    group: "\u5DE5\u7A0B\u4E0E\u8FD0\u7EF4",
    kind: "node",
    color: "#1D4ED8",
    nodePreset: {
      width: 300,
      height: 185,
      title: "API \u670D\u52A1\u8282\u70B9",
      body: "\u804C\u8D23\u8BF4\u660E\uFF1A\n\u4E0A\u6E38\u4F9D\u8D56 / \u4E0B\u6E38\u8C03\u7528\uFF1A\nSLA \u76EE\u6807\uFF1A99.9%",
      category: "SERVICE",
      color: "#1D4ED8",
      defaultVars: { env: "prod", healthy: true },
      buttons: [
        {
          id: "btn-ping",
          label: "\u4EE3\u7406\u63A2\u6D3B GET",
          variant: "primary",
          actionType: "proxy_http",
          proxyUrl: "https://httpbin.org/get?service=ping",
          proxyMethod: "GET"
        }
      ]
    }
  },
  {
    id: "tpl-metric-card",
    name: "\u76D1\u63A7\u6307\u6807\u5361",
    description: "\u6A21\u62DF\u8D1F\u8F7D\u91C7\u6837\u3001\u5EF6\u8FDF\u544A\u8B66\u9608\u503C\u6F14\u793A",
    group: "\u5DE5\u7A0B\u4E0E\u8FD0\u7EF4",
    kind: "node",
    color: "#B45309",
    nodePreset: {
      width: 270,
      height: 170,
      title: "\u96C6\u7FA4\u8D1F\u8F7D\u76D1\u63A7",
      body: "\u5173\u6CE8\u6307\u6807\uFF1AP99 \u5EF6\u8FDF\u3001\u9519\u8BEF\u7387\u4E0E CPU \u8D1F\u8F7D",
      category: "OPS",
      color: "#B45309",
      defaultVars: { cpu: 0.35, alert: "\u6B63\u5E38" },
      buttons: [
        {
          id: "btn-sample",
          label: "\u8D1F\u8F7D +0.15",
          variant: "danger",
          actionType: "script",
          code: `const c = Math.min(1, lib.inc('cpu', 0.15));
vars.cpu = c;
vars.alert = c >= 0.8 ? '\u544A\u8B66' : '\u6B63\u5E38';`
        }
      ]
    }
  },
  {
    id: "tpl-gateway",
    name: "\u6761\u4EF6\u5206\u652F / \u8DEF\u7531\u7F51\u5173",
    description: "\u7528\u4E8E\u67B6\u6784\u84DD\u56FE\u4E2D\u7684\u6D41\u91CF\u6216\u903B\u8F91\u5206\u6D41\u8BF4\u660E",
    group: "\u5DE5\u7A0B\u4E0E\u8FD0\u7EF4",
    kind: "node",
    color: "#0369A1",
    nodePreset: {
      width: 260,
      height: 165,
      title: "\u8DEF\u7531\u7F51\u5173\u8282\u70B9",
      body: "\u8DEF\u7531\u89C4\u5219\uFF1A\u6309\u533A\u57DF / \u7070\u5EA6\u6BD4\u4F8B\u5206\u53D1",
      category: "GATEWAY",
      color: "#0369A1",
      defaultVars: { canaryRatio: 10 },
      buttons: [
        {
          id: "btn-canary",
          label: "\u7070\u5EA6 +10%",
          variant: "secondary",
          actionType: "script",
          code: `vars.canaryRatio = ((Number(vars.canaryRatio) || 0) + 10) % 110;`
        }
      ]
    }
  },
  {
    id: "tpl-script-spawner",
    name: "\u8DE8\u63A7\u4EF6\u8054\u52A8\u63A7\u5236\u53F0\uFF08\u811A\u672C\uFF09",
    description: "\u5185\u7F6E\u8F93\u5165\u6846+\u56DE\u8F66\u53D1\u9001+\u52A8\u6001\u9020\u5B50\u63A7\u4EF6+emit\u6D88\u606F\u901A\u4FE1",
    group: "\u5DE5\u7A0B\u4E0E\u8FD0\u7EF4",
    kind: "node",
    color: "#2563EB",
    nodePreset: {
      width: 380,
      height: 210,
      title: "\u8054\u52A8\u63A7\u5236\u53F0",
      body: "",
      category: "\u8054\u52A8",
      color: "#2563EB",
      defaultVars: { draft: "", count: 0 },
      script: `vars.contents = [
  { type: 'text', text: '\u8F93\u5165\u6D88\u606F\u540E\u6309\u56DE\u8F66\u5E7F\u64AD\u7ED9\u5168\u753B\u5E03\u811A\u672C\u63A7\u4EF6', align: 'center', color: '#1E40AF', fontSize: 12, bold: true },
  [
    { type: 'input', id: 'bcInput', bind: 'draft', placeholder: '\u8F93\u5165\u5E7F\u64AD\u5185\u5BB9\uFF08\u56DE\u8F66\u53D1\u9001\uFF09...' },
    { type: 'button', id: 'bcSend', label: '\u5E7F\u64AD', width: 64, variant: 'primary' }
  ],
  { type: 'text', text: vars.status || '\u7B49\u5F85\u5E7F\u64AD\u2026', fontSize: 11, color: '#475569' }
];
async function doBroadcast(raw) {
  const txt = String(raw ?? vars.draft ?? '').trim();
  if (!txt) { vars.status = '\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A'; return; }
  await broadcast('ping', { text: txt });
  vars.draft = '';
  vars.count = (Number(vars.count) || 0) + 1;
  vars.status = '\u5DF2\u5E7F\u64AD #' + vars.count + '\uFF1A' + txt;
}
on('bcSend', async () => doBroadcast(vars.draft));
onSubmit('bcInput', async (v) => doBroadcast(v));`
    }
  },
  // 四、注释与基础
  {
    id: "tpl-blank-widget",
    name: "\u7A7A\u767D\u81EA\u7531\u63A7\u4EF6",
    description: "\u65E0\u9884\u8BBE\u6309\u94AE\u7684\u5E72\u51C0\u8282\u70B9\uFF0C\u968F\u65F6\u70B9\u51FB\u7F16\u8F91\u6269\u5C55",
    group: "\u6CE8\u91CA\u4E0E\u57FA\u7840",
    kind: "node",
    color: "#334155",
    nodePreset: {
      width: 260,
      height: 150,
      title: "\u65B0\u63A7\u4EF6",
      body: "\u53CC\u51FB\u6216\u70B9\u51FB\u6B64\u5904\u76F4\u63A5\u8F93\u5165\u6B63\u6587\u5185\u5BB9\u2026",
      category: "\u901A\u7528",
      color: "#334155",
      defaultVars: {},
      buttons: []
    }
  },
  {
    id: "tpl-ann-textbox",
    name: "\u80CC\u666F\u6587\u672C\u6846\uFF08\u8272\u5757\uFF09",
    description: "\u652F\u6301\u8BBE\u6587\u5B57\u989C\u8272\u4E0E\u8272\u5757\u5E95\u8272\uFF0C\u4E5F\u80FD\u88AB\u63A7\u4EF6\u811A\u672C\u52A8\u6001\u53D8\u8272",
    group: "\u6CE8\u91CA\u4E0E\u57FA\u7840",
    kind: "annotation",
    color: "#B45309",
    annotationPreset: {
      kind: "text",
      width: 360,
      height: 110,
      text: "\u8272\u5757\u6587\u672C\u6846\n\u652F\u6301\u591A\u884C\u81EA\u52A8\u6362\u884C\u4E0D\u62C9\u4F38\uFF0C\u5F00\u542F\u6CE8\u91CA\u7F16\u8F91\u53EF\u968F\u65F6\u8C03\u8272",
      fontSize: 16,
      color: "#78350F",
      bgColor: "#FEF3C7",
      bgOpacity: 0.9,
      weight: "bold",
      nonInteractive: true
    }
  },
  {
    id: "tpl-ann-header",
    name: "\u533A\u57DF\u5927\u6807\u9898\uFF08\u900F\u660E\u7A7F\u900F\uFF09",
    description: "30px \u7C97\u4F53\u5730\u56FE\u5206\u533A\u6807\u724C\uFF0C\u7F29\u8FDC\u5168\u666F\u4F9D\u7136\u6E05\u6670",
    group: "\u6CE8\u91CA\u4E0E\u57FA\u7840",
    kind: "annotation",
    color: "#0F766E",
    annotationPreset: {
      kind: "text",
      width: 480,
      height: 68,
      text: "\u65B0\u533A\u57DF\u5927\u6807\u9898 \xB7 \u62D6\u52A8\u5B9A\u4F4D",
      fontSize: 28,
      color: "#0F766E",
      bgColor: "transparent",
      bgOpacity: 0,
      weight: "bold",
      nonInteractive: true
    }
  },
  {
    id: "tpl-image-node",
    name: "\u56FE\u7247\u8282\u70B9",
    description: "\u7EAF\u5916\u94FE\u56FE\u7247\u8282\u70B9\uFF0C\u652F\u6301\u7B49\u6BD4/\u88C1\u5207\u5207\u6362\u3001Portal \u5927\u56FE\u706F\u7BB1\u9884\u89C8\u4E0E\u89C6\u53E3\u88C1\u526A",
    group: "\u6CE8\u91CA\u4E0E\u57FA\u7840",
    kind: "node",
    color: "#4F46E5",
    nodePreset: {
      title: "\u56FE\u7247\u753B\u677F",
      body: "",
      width: 360,
      height: 270,
      category: "\u56FE\u7247",
      color: "#4F46E5",
      defaultVars: {
        imageUrl: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 360 220'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%23EEF2FF'/%3E%3Cstop offset='100%25' stop-color='%23E0E7FF'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='360' height='220' fill='url(%23g)'/%3E%3Ccircle cx='118' cy='86' r='30' fill='%234F46E5' fill-opacity='0.22'/%3E%3Cpath d='M52 174 L142 104 L212 152 L262 118 L314 174 Z' fill='%234F46E5' fill-opacity='0.3'/%3E%3Ctext x='180' y='198' text-anchor='middle' font-family='sans-serif' font-size='13' fill='%23312E81'%3E\u60AC\u505C\u53F3\u4E0A\u89D2\u53EF\u66F4\u6362\u56FE\u7247 \xB7 \u652F\u6301\u672C\u5730\u4E0A\u4F20\u4E0E\u5927\u56FE\u9884\u89C8%3C/text%3E%3C/svg%3E",
        imageFit: "contain",
        imageCaption: "\u793A\u4F8B\u56FE\u7247\uFF08\u60AC\u505C\u53F3\u4E0A\u89D2\u53EF\u6362\u56FE\u6216\u5168\u5C4F\u9884\u89C8\uFF09"
      },
      script: String.raw`vars.contents = [
  { type: 'image', id: 'imgMain', bindUrl: 'imageUrl', bindFit: 'imageFit', bindCaption: 'imageCaption' }
];`,
      inputPorts: [{ id: "in-1", label: "\u8F93\u5165" }],
      outputPorts: [{ id: "out-1", label: "\u8F93\u51FA" }]
    }
  },
  {
    id: "tpl-video-node",
    name: "\u89C6\u9891\u8282\u70B9",
    description: "\u7EAF\u5916\u94FE MP4/WebM \u89C6\u9891\u8282\u70B9\uFF0C\u5E26\u500D\u901F/\u5FAA\u73AF/\u9759\u97F3\u4E0E\u79FB\u51FA\u89C6\u53E3\u81EA\u52A8\u6682\u505C",
    group: "\u6CE8\u91CA\u4E0E\u57FA\u7840",
    kind: "node",
    color: "#E11D48",
    nodePreset: {
      title: "\u89C6\u9891\u64AD\u653E\u5668",
      body: "",
      width: 420,
      height: 300,
      category: "\u89C6\u9891",
      color: "#E11D48",
      defaultVars: {
        videoUrl: "",
        videoLoop: false,
        videoMuted: false
      },
      script: String.raw`vars.contents = [
  { type: 'video', id: 'vidMain', bindUrl: 'videoUrl', bindLoop: 'videoLoop', bindMuted: 'videoMuted' }
];`,
      inputPorts: [{ id: "in-1", label: "\u8F93\u5165" }],
      outputPorts: [{ id: "out-1", label: "\u8F93\u51FA" }]
    }
  },
  {
    id: "tpl-slider-node",
    name: "\u62D6\u52A8\u6761\u63A7\u4EF6",
    description: "\u5B9E\u65F6\u62D6\u52A8\u8C03\u8282\u6570\u503C\u5E76\u89E6\u53D1\u811A\u672C onChange\uFF0C\u53EF\u8FDE\u7EBF\u9A71\u52A8\u4E0B\u6E38\u8282\u70B9\u53C2\u6570",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#2563EB",
    nodePreset: {
      title: "\u53C2\u6570\u62D6\u52A8\u6761",
      body: "",
      width: 320,
      height: 200,
      category: "\u6ED1\u5757",
      color: "#2563EB",
      defaultVars: {
        value: 50,
        scale: 1
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
      outputPorts: [{ id: "out-1", label: "\u6570\u503C\u8F93\u51FA" }]
    }
  },
  {
    id: "tpl-pad2d-node",
    name: "2D Pad \u62D6\u52A8\u677F",
    description: "\u6DF1\u8272\u4E8C\u7EF4\u89E6\u63A7\u677F\uFF08\u5341\u5B57\u51C6\u661F + \u53D1\u5149\u62D6\u62FD\u7403 + \u53CC\u51FB\u5F52\u4E2D\uFF09\uFF0C\u53EF\u5B9E\u65F6\u8F93\u51FA X/Y \u5750\u6807\u8054\u52A8\u4E0B\u6E38",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#D97706",
    nodePreset: {
      title: "2D Pad \u63A7\u5236\u5668",
      body: "",
      width: 310,
      height: 310,
      category: "2D Pad",
      color: "#D97706",
      defaultVars: {
        padX: 0,
        padY: 0
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
      outputPorts: [{ id: "out-1", label: "XY \u8F93\u51FA" }]
    }
  },
  {
    id: "tpl-image-button-node",
    name: "\u56FE\u7247\u6309\u94AE (4\u6001)",
    description: "\u7528\u56FE\u7247\u66FF\u4EE3\u6309\u94AE\uFF0C\u652F\u6301 on / off / hover / click \u56DB\u79CD\u72B6\u6001\u8D34\u56FE\u4E0E\u60AC\u505C\u5FEB\u6377\u6362\u56FE",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#059669",
    nodePreset: {
      title: "\u56DB\u6001\u56FE\u7247\u6309\u94AE",
      body: "",
      width: 300,
      height: 215,
      category: "\u56FE\u94AE",
      color: "#059669",
      defaultVars: {
        powerOn: false,
        clicks: 0,
        btnOffImage: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 88'%3E%3Crect x='4' y='6' width='232' height='76' rx='18' fill='%23334155' stroke='%2364748B' stroke-width='3'/%3E%3Ccircle cx='46' cy='44' r='12' fill='%2394A3B8'/%3E%3Ctext x='136' y='50' text-anchor='middle' font-family='sans-serif' font-size='18' font-weight='700' fill='%23E2E8F0'%3EOFF \xB7 \u5F85\u673A%3C/text%3E%3C/svg%3E",
        btnOnImage: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 88'%3E%3Crect x='4' y='6' width='232' height='76' rx='18' fill='%23059669' stroke='%2334D399' stroke-width='3'/%3E%3Ccircle cx='46' cy='44' r='12' fill='%23A7F3D0'/%3E%3Ctext x='136' y='50' text-anchor='middle' font-family='sans-serif' font-size='18' font-weight='700' fill='%23FFFFFF'%3EON \xB7 \u5DF2\u5F00\u542F%3C/text%3E%3C/svg%3E",
        btnHoverImage: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 88'%3E%3Crect x='4' y='6' width='232' height='76' rx='18' fill='%234F46E5' stroke='%23A5B4FC' stroke-width='3'/%3E%3Ccircle cx='46' cy='44' r='12' fill='%23E0E7FF'/%3E%3Ctext x='136' y='50' text-anchor='middle' font-family='sans-serif' font-size='18' font-weight='700' fill='%23FFFFFF'%3EHOVER \xB7 \u60AC\u505C%3C/text%3E%3C/svg%3E",
        btnClickImage: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 88'%3E%3Crect x='6' y='10' width='228' height='70' rx='16' fill='%23D97706' stroke='%23FDE68A' stroke-width='3'/%3E%3Ccircle cx='46' cy='45' r='12' fill='%23FEF3C7'/%3E%3Ctext x='136' y='51' text-anchor='middle' font-family='sans-serif' font-size='18' font-weight='700' fill='%23FFFFFF'%3ECLICK \xB7 \u6309\u4E0B%3C/text%3E%3C/svg%3E"
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
      inputPorts: [{ id: "in-1", label: "\u8F93\u5165" }],
      outputPorts: [{ id: "out-1", label: "\u72B6\u6001\u8F93\u51FA" }]
    }
  },
  {
    id: "tpl-ann-image",
    name: "\u80CC\u666F\u63D2\u56FE\uFF08\u7B49\u6BD4\u4E0D\u62C9\u4F38\uFF09",
    description: "\u6240\u89C1\u5373\u6240\u5F97\u63D2\u56FE\u7EC4\u4EF6\uFF0C\u652F\u6301\u6362\u672C\u5730\u56FE\u4E0E\u8BBE\u80CC\u666F\u8272\u5757",
    group: "\u6CE8\u91CA\u4E0E\u57FA\u7840",
    kind: "annotation",
    color: "#2563EB",
    annotationPreset: {
      kind: "image",
      width: 320,
      height: 200,
      text: "\u793A\u4F8B\u80CC\u666F\u63D2\u56FE",
      fontSize: 14,
      color: "#1E293B",
      bgColor: "#FFFFFF",
      bgOpacity: 0.9,
      imageUrl: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 200'%3E%3Crect width='320' height='200' rx='14' fill='%23EFF6FF'/%3E%3Ccircle cx='90' cy='78' r='28' fill='%232563EB' fill-opacity='0.2' stroke='%232563EB' stroke-width='3'/%3E%3Crect x='170' y='52' width='104' height='52' rx='8' fill='%230F766E' fill-opacity='0.18' stroke='%230F766E' stroke-width='3'/%3E%3Cpath d='M118 78 L168 78' stroke='%23475569' stroke-width='3' stroke-dasharray='6 4'/%3E%3Ctext x='160' y='156' text-anchor='middle' font-family='sans-serif' font-size='16' font-weight='700' fill='%231E293B'%3E\u793A\u4F8B\u80CC\u666F\u63D2\u56FE\uFF08\u7B49\u6BD4\u7F29\u653E\u4E0D\u62C9\u4F38\uFF09%3C/text%3E%3C/svg%3E",
      weight: "normal",
      nonInteractive: true
    }
  }
];

// src/core/agentOps.ts
function listAgentTemplates() {
  return BUILTIN_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    group: t.group,
    kind: t.kind,
    description: t.description
  }));
}
function getAgentToolSchema() {
  return [
    {
      name: "atlas_inspect_room",
      description: "\u8BFB\u53D6 Atlas Hybrid Canvas \u6307\u5B9A\u623F\u95F4\u7684\u5B9E\u65F6 revision\u3001\u5168\u90E8\u63A7\u4EF6/\u80CC\u666F/\u8FDE\u7EBF\u6458\u8981\u4EE5\u53CA\u53EF\u7528\u6A21\u677F\u6E05\u5355\uFF08\u5148\u540C\u6B65 WS \u5185\u5B58\u6001\uFF0C\u907F\u514D\u8BFB\u5230\u9648\u65E7\u5FEB\u7167\uFF09\u3002",
      parameters: {
        type: "object",
        properties: {
          room: { type: "string", description: '\u623F\u95F4\u8DEF\u5F84\uFF0C\u5982 "team/design"\uFF0C\u9ED8\u8BA4 "atlas-main"' },
          full: { type: "boolean", description: "\u4E3A true \u65F6\u540C\u65F6\u8FD4\u56DE\u5B8C\u6574 blueprint JSON" }
        }
      }
    },
    {
      name: "atlas_canvas_ops",
      description: "\u5728 Atlas Hybrid Canvas \u6307\u5B9A\u623F\u95F4\u5185\u539F\u5B50\u6279\u91CF\u521B\u5EFA\u3001\u4FEE\u6539\u6216\u5220\u9664\u63A7\u4EF6\uFF08\u652F\u6301\u5185\u7F6E\u6A21\u677F\u4E0E\u7ED3\u6784\u5316\u79EF\u6728\uFF09\u3001\u80CC\u666F\u6CE8\u91CA/\u63D2\u56FE\u4E0E\u8FDE\u7EBF\uFF0C\u652F\u6301 expectedRevision \u4E50\u89C2\u9501\u4E0E dryRun \u9884\u6F14\u3002",
      parameters: {
        type: "object",
        required: ["ops"],
        properties: {
          room: { type: "string", description: '\u623F\u95F4\u8DEF\u5F84\uFF0C\u5982 "team/design"' },
          actor: { type: "string", description: "Agent \u6807\u8BC6\uFF0C\u5199\u5165\u4FEE\u6539\u65E5\u5FD7\u4FBF\u4E8E\u5BA1\u8BA1\u4E0E\u56DE\u6863" },
          summary: { type: "string", description: "\u53EF\u9009\u7684\u4EBA\u7C7B\u53EF\u8BFB\u53D8\u66F4\u6458\u8981" },
          expectedRevision: {
            type: "number",
            description: "\u53EF\u9009\u4E50\u89C2\u9501\uFF1A\u82E5\u623F\u95F4\u5F53\u524D revision \u4E0E\u6B64\u503C\u4E0D\u7B26\u5219\u8FD4\u56DE 409 Conflict"
          },
          dryRun: {
            type: "boolean",
            description: "\u4E3A true \u65F6\u4EC5\u6821\u9A8C\u5E76\u8BA1\u7B97\u81EA\u52A8\u5E03\u5C40\u5750\u6807\uFF0C\u4E0D\u843D\u76D8\u3001\u4E0D\u5E7F\u64AD"
          },
          ops: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              required: ["op"],
              properties: {
                op: {
                  type: "string",
                  enum: [
                    "create_from_template",
                    "create_widget",
                    "update_widget",
                    "delete_widget",
                    "create_annotation",
                    "update_annotation",
                    "delete_annotation",
                    "connect_edge",
                    "delete_edge"
                  ]
                },
                templateId: { type: "string" },
                id: { type: "string" },
                title: { type: "string" },
                body: { type: "string" },
                kind: { type: "string", enum: ["text", "image"] },
                text: { type: "string" },
                imageUrl: { type: "string" },
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
                color: { type: "string" },
                bgColor: { type: "string" },
                bgOpacity: { type: "number" },
                script: { type: "string" },
                blocks: { type: "array" },
                defaultVars: { type: "object" },
                mergeVars: { type: "boolean" },
                source: { type: "string" },
                target: { type: "string" },
                bidirectional: { type: "boolean" },
                controlPoints: {
                  type: "array",
                  description: "\u53EF\u9009\u8FDE\u7EBF\u63A7\u5236\u70B9\u6570\u7EC4 [{x, y}]\uFF0C\u6309\u987A\u5E8F\u5E73\u6ED1\u7ED5\u8FC7\u5361\u7247\uFF08\u6700\u591A 12 \u4E2A\uFF09",
                  items: {
                    type: "object",
                    required: ["x", "y"],
                    properties: {
                      x: { type: "number" },
                      y: { type: "number" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  ];
}

// src/core/roomPath.ts
var DEFAULT_ROOM_PATH = "atlas-main";
var MAX_ROOM_PATH_LEN = 120;
function normalizeRoomPath(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return DEFAULT_ROOM_PATH;
  const rawSegments = input.split("/");
  const cleanSegments = [];
  for (const seg of rawSegments) {
    if (!seg) continue;
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      decoded = seg;
    }
    const trimmed = decoded.trim();
    if (!trimmed || trimmed === "." || trimmed === "..") continue;
    const safe = trimmed.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!safe || safe === "." || safe === "..") continue;
    cleanSegments.push(safe);
  }
  if (cleanSegments.length === 0) return DEFAULT_ROOM_PATH;
  const joined = cleanSegments.join("/").slice(0, MAX_ROOM_PATH_LEN).replace(/\/+$/, "");
  return joined || DEFAULT_ROOM_PATH;
}
function encodeRoomPathForUrl(roomPath) {
  return normalizeRoomPath(roomPath).split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

// server/mcpServer.ts
var MCP_PROTOCOL_VERSION = "2024-11-05";
function getMcpToolsDefinition() {
  const baseTools = getAgentToolSchema();
  return [
    {
      name: "atlas_list_templates",
      description: "\u5217\u51FA Atlas Hybrid Canvas \u5185\u7F6E\u7684\u5168\u90E8\u63A7\u4EF6\u4E0E\u80CC\u666F\u6A21\u677F\uFF08\u542B templateId\u3001\u5206\u7C7B\u4E0E\u8BF4\u660E\uFF09\uFF0C\u4F9B create_from_template \u4F7F\u7528\u3002",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "atlas_inspect_room",
      description: baseTools[0].description,
      inputSchema: baseTools[0].parameters
    },
    {
      name: "atlas_apply_ops",
      description: baseTools[1].description,
      inputSchema: baseTools[1].parameters
    },
    {
      name: "atlas_rollback_room",
      description: "\u5C06\u6307\u5B9A\u623F\u95F4\u4E00\u952E\u56DE\u6863\u5230\u5386\u53F2\u7248\u672C\u53F7\uFF08\u7531 historyVersion \u6216\u5386\u53F2\u63A5\u53E3\u63D0\u4F9B\uFF09\uFF0C\u540C\u6B65\u5E7F\u64AD\u7ED9\u5168\u90E8\u5728\u7EBF\u534F\u4F5C\u8005\u3002",
      inputSchema: {
        type: "object",
        required: ["version"],
        properties: {
          room: { type: "string", description: "\u623F\u95F4\u8DEF\u5F84\uFF0C\u9ED8\u8BA4\u4F7F\u7528 ATLAS_DEFAULT_ROOM" },
          version: { type: "number", description: "\u76EE\u6807\u5386\u53F2\u7248\u672C\u53F7\uFF08\u6B63\u6574\u6570\uFF09" }
        }
      }
    }
  ];
}
function asToolTextResult(payload, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)
      }
    ],
    isError
  };
}
async function handleMcpJsonRpcRequest(req, cfg) {
  const id = req.id ?? null;
  const doFetch = cfg.fetcher ?? fetch;
  const baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  if (req.method === "notifications/initialized" || req.method === "notifications/cancelled") {
    return null;
  }
  if (req.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "atlas-hybrid-canvas-mcp", version: "0.88.0" }
      }
    };
  }
  if (req.method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (req.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: getMcpToolsDefinition() }
    };
  }
  if (req.method === "tools/call") {
    const params = req.params || {};
    const toolName = String(params.name || "");
    const args = params.arguments || {};
    try {
      if (toolName === "atlas_list_templates") {
        return {
          jsonrpc: "2.0",
          id,
          result: asToolTextResult({ ok: true, templates: listAgentTemplates() })
        };
      }
      if (toolName === "atlas_inspect_room") {
        const room = normalizeRoomPath(typeof args.room === "string" ? args.room : cfg.defaultRoom);
        const encoded = encodeRoomPathForUrl(room);
        const query = args.full === true ? "?full=1" : "";
        const resp = await doFetch(`${baseUrl}/api/rooms/${encoded}/agent/state${query}`, {
          method: "GET",
          headers: { "X-Agent-Api-Key": cfg.apiKey }
        });
        const data = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
        return {
          jsonrpc: "2.0",
          id,
          result: asToolTextResult(data, !resp.ok)
        };
      }
      if (toolName === "atlas_apply_ops") {
        const room = normalizeRoomPath(typeof args.room === "string" ? args.room : cfg.defaultRoom);
        const encoded = encodeRoomPathForUrl(room);
        const resp = await doFetch(`${baseUrl}/api/rooms/${encoded}/ops`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Agent-Api-Key": cfg.apiKey
          },
          body: JSON.stringify({
            actor: args.actor ?? "mcp-agent",
            summary: args.summary,
            expectedRevision: args.expectedRevision,
            dryRun: args.dryRun,
            ops: args.ops
          })
        });
        const data = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
        return {
          jsonrpc: "2.0",
          id,
          result: asToolTextResult(data, !resp.ok)
        };
      }
      if (toolName === "atlas_rollback_room") {
        const room = normalizeRoomPath(typeof args.room === "string" ? args.room : cfg.defaultRoom);
        const encoded = encodeRoomPathForUrl(room);
        const resp = await doFetch(`${baseUrl}/api/rooms/${encoded}/rollback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Agent-Api-Key": cfg.apiKey,
            "X-Blueprint-Save-Key": cfg.apiKey
          },
          body: JSON.stringify({ version: Number(args.version) })
        });
        const data = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
        return {
          jsonrpc: "2.0",
          id,
          result: asToolTextResult(data, !resp.ok)
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` }
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: asToolTextResult(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          true
        )
      };
    }
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${req.method}` }
  };
}
function isMainEntry() {
  const entry = process.argv[1] || "";
  return entry.endsWith("mcpServer.ts") || entry.endsWith("mcp-server.mjs");
}
if (isMainEntry()) {
  const cfg = {
    baseUrl: (process.env.ATLAS_BASE_URL || "http://127.0.0.1:8787").trim(),
    apiKey: (process.env.AGENT_API_KEY || process.env.BLUEPRINT_SAVE_KEY || "").trim(),
    defaultRoom: normalizeRoomPath(process.env.ATLAS_DEFAULT_ROOM || DEFAULT_ROOM_PATH)
  };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      const resp = await handleMcpJsonRpcRequest(parsed, cfg);
      if (resp) {
        process.stdout.write(`${JSON.stringify(resp)}
`);
      }
    } catch (err) {
      const errResp = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `Parse error: ${err instanceof Error ? err.message : String(err)}` }
      };
      process.stdout.write(`${JSON.stringify(errResp)}
`);
    }
  });
}
export {
  getMcpToolsDefinition,
  handleMcpJsonRpcRequest
};
