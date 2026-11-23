/**
 * @file scriptAudit.ts
 * @description 外部导入 JSON 或远端协同同步脚本的静态审计（纯函数，无 DOM / React 依赖）。
 * 凡来自外部文件或远端房间的脚本与外部 HTTP 按钮默认锁死，需人工审阅后显式批准才允许执行。
 * UI 弹窗见 `src/components/ScriptTrustModal.tsx`。
 */
import type { BaseBlueprint } from './types';
import { validateScriptSafety } from './scriptSandbox';

export interface ScriptAuditEntry {
  key: string;
  nodeId: string;
  nodeTitle: string;
  kind: 'unified_script' | 'button_script' | 'proxy_http';
  preview: string;
  warning?: string;
}

export function auditBlueprintScripts(bp: BaseBlueprint): ScriptAuditEntry[] {
  const entries: ScriptAuditEntry[] = [];
  for (const node of Object.values(bp.nodes || {})) {
    if (node.script && node.script.trim()) {
      const check = validateScriptSafety(node.script);
      entries.push({
        key: `${node.id}:__script__`,
        nodeId: node.id,
        nodeTitle: node.title,
        kind: 'unified_script',
        preview: node.script.trim().slice(0, 180),
        warning: check.ok ? undefined : check.reason,
      });
    }
    for (const btn of node.buttons ?? []) {
      if (btn.actionType === 'script' && btn.code?.trim()) {
        const check = validateScriptSafety(btn.code);
        entries.push({
          key: `${node.id}:${btn.id}`,
          nodeId: node.id,
          nodeTitle: `${node.title} / ${btn.label}`,
          kind: 'button_script',
          preview: btn.code.trim().slice(0, 180),
          warning: check.ok ? undefined : check.reason,
        });
      } else if (btn.actionType === 'proxy_http' && btn.proxyUrl) {
        entries.push({
          key: `${node.id}:${btn.id}`,
          nodeId: node.id,
          nodeTitle: `${node.title} / ${btn.label}`,
          kind: 'proxy_http',
          preview: `${btn.proxyMethod || 'GET'} ${btn.proxyUrl}`,
        });
      }
    }
  }
  return entries;
}
