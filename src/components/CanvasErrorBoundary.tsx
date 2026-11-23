/**
 * @file CanvasErrorBoundary.tsx
 * @description 画布与单节点级 React 错误边界，防止单个损坏控件或异常渲染导致整个画布白屏。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  variant?: 'app' | 'node';
  label?: string;
}

interface State {
  hasError: boolean;
  message: string;
}

export class CanvasErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : String(error || '未知渲染错误');
    return { hasError: true, message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[CanvasErrorBoundary:${this.props.variant ?? 'app'}]`, this.props.label ?? '', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, message: '' });
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    if (this.props.variant === 'node') {
      return (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag nopan flex flex-col gap-1.5 rounded-md border border-rose-200 bg-rose-50/90 p-2 text-[11px] text-rose-800"
        >
          <div className="font-semibold">
            {this.props.label ? `「${this.props.label}」渲染异常` : '节点内容渲染异常'}
          </div>
          <div className="line-clamp-2 break-all font-mono text-[10px] text-rose-700/90">
            {this.state.message}
          </div>
          <div>
            <button
              type="button"
              onClick={this.handleReset}
              className="rounded border border-rose-300 bg-white px-2 py-0.5 text-[10px] font-medium text-rose-700 hover:bg-rose-100"
            >
              重试渲染
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-50 p-6 text-slate-800">
        <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-lg">
          <h2 className="text-base font-bold text-slate-900">画布渲染遇到异常</h2>
          <p className="mt-2 break-all rounded-md bg-rose-50 p-2.5 font-mono text-xs text-rose-700">
            {this.state.message}
          </p>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={this.handleReset}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              尝试恢复画布
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              刷新页面
            </button>
          </div>
        </div>
      </div>
    );
  }
}
