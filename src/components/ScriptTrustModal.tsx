/**
 * @file ScriptTrustModal.tsx
 * @description 外部导入 JSON 或远端协同同步脚本的安全审计弹窗（纯展示层）。
 * 审计逻辑本身在 `src/core/scriptAudit.ts`，此处仅做 re-export 保持既有导入路径可用。
 * 凡来自外部文件或远端房间的脚本与外部 HTTP 按钮默认锁死，需人工审阅后显式批准才允许执行。
 */
import { useState } from 'react';
import { ShieldAlert, ShieldCheck, X } from 'lucide-react';
import type { ScriptAuditEntry } from '../core/scriptAudit';

export { auditBlueprintScripts } from '../core/scriptAudit';
export type { ScriptAuditEntry } from '../core/scriptAudit';

interface ScriptTrustModalProps {
  open: boolean;
  sourceLabel: string;
  entries: ScriptAuditEntry[];
  onKeepLocked: () => void;
  onTrustAll: () => void;
}

export function ScriptTrustModal({
  open,
  sourceLabel,
  entries,
  onKeepLocked,
  onTrustAll,
}: ScriptTrustModalProps) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  if (!open) return null;

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[2px]">
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="flex items-center gap-2 text-amber-800">
            <ShieldAlert className="h-5 w-5" />
            <h3 className="text-sm font-bold">外部脚本安全审计（{sourceLabel}）</h3>
          </div>
          <button type="button" onClick={onKeepLocked} className="rounded p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-3 text-xs leading-relaxed text-slate-600">
          检测到 <strong>{entries.length}</strong> 条外部脚本或 HTTP 请求按钮。为防止恶意代码注入，外部脚本默认处于<strong>禁用锁定态</strong>，请审阅后再决定是否启用：
        </div>

        <div className="max-h-72 space-y-2 overflow-y-auto px-5 pb-3">
          {entries.map((item) => (
            <div key={item.key} className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-900">{item.nodeTitle}</span>
                <span className="rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[10px] text-slate-700">
                  {item.kind}
                </span>
              </div>
              <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded border border-slate-700/60 bg-slate-900 dark:bg-slate-950 p-2 font-mono text-[10.5px] text-emerald-300">
                {expandedKeys.has(item.key) && item.fullCode ? item.fullCode : item.preview}
              </pre>
              {item.truncated && item.fullCode && (
                <button
                  type="button"
                  onClick={() =>
                    setExpandedKeys((prev) => {
                      const next = new Set(prev);
                      if (next.has(item.key)) next.delete(item.key);
                      else next.add(item.key);
                      return next;
                    })
                  }
                  className="mt-1 text-[11px] font-medium text-blue-700 hover:underline"
                >
                  {expandedKeys.has(item.key) ? '收起源码' : `展开完整源码（共 ${item.fullCode.length} 字符）`}
                </button>
              )}
              {item.warning && (
                <div className="mt-1.5 rounded bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-700">
                  静态拦截警告：{item.warning}（即使信任也无法执行）
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button
            type="button"
            onClick={onKeepLocked}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            保持禁用（安全只读）
          </button>
          <button
            type="button"
            onClick={onTrustAll}
            className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            我已审阅，信任并启用
          </button>
        </div>
      </div>
    </div>
  );
}
