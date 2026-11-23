/**
 * @file taskList.ts
 * @description 轻量级 Markdown 待办复选框解析与切换工具。
 * 同时兼容 `- []`、`- [ ]`、`- [x]`、`- [X]`、`* []`、`+ [ ]`、`-[ ]` 以及带缩进的子任务行。
 */

export interface ParsedTaskLine {
  /** 行首缩进空格 */
  indent: string;
  /** 列表标记前缀（如 "- " / "* "） */
  marker: string;
  /** 是否已勾选 */
  checked: boolean;
  /** 复选框后的文本内容 */
  label: string;
}

const TASK_LINE_RE = /^(\s*)([-*+]\s*)\[([ xX]?)\](\s*)(.*)$/;

/**
 * 解析单行文本是否为待办复选框语法。
 */
export function parseTaskLine(line: string): ParsedTaskLine | null {
  const m = TASK_LINE_RE.exec(line);
  if (!m) return null;
  return {
    indent: m[1],
    marker: m[2],
    checked: m[3].toLowerCase() === 'x',
    label: m[5],
  };
}

/**
 * 切换指定行号的复选框勾选状态，保留原缩进与列表符号。
 */
export function toggleTaskLine(text: string, lineIndex: number): string {
  const lines = text.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return text;
  const m = TASK_LINE_RE.exec(lines[lineIndex]);
  if (!m) return text;
  const nextMark = m[3].toLowerCase() === 'x' ? ' ' : 'x';
  const gap = m[4] || (m[5] ? ' ' : '');
  lines[lineIndex] = `${m[1]}${m[2]}[${nextMark}]${gap}${m[5]}`;
  return lines.join('\n');
}

/**
 * 将文本中的 `- []` / `- [ ]` / `- [x]` 转换为适合底层 Canvas 2D 渲染的 `☐` / `☑` 符号。
 */
export function formatTaskTextForCanvas(text: string): string {
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => {
      const task = parseTaskLine(line);
      if (!task) return line;
      return `${task.indent}${task.checked ? '☑' : '☐'} ${task.label}`;
    })
    .join('\n');
}
