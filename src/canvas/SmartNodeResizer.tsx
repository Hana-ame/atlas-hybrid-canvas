/**
 * @file SmartNodeResizer.tsx
 * @description 增强版节点缩放器：
 * - 四角手柄（top-left / top-right / bottom-left / bottom-right）严格保持宽高比（keepAspectRatio = true）；
 * - 四边控制线（top / right / bottom / left）自由拉伸宽或高（keepAspectRatio = false）；
 * - 配合 index.css 扩展超大透明碰撞箱（边线 16px、角点 32px+），并保持连线端口优先命中。
 */

import { memo } from 'react';
import {
  NodeResizeControl,
  ResizeControlVariant,
  type ControlLinePosition,
  type ControlPosition,
  type OnResize,
  type OnResizeEnd,
} from '@xyflow/react';

const LINE_POSITIONS: ControlLinePosition[] = ['top', 'right', 'bottom', 'left'];
const CORNER_POSITIONS: ControlPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

export interface SmartNodeResizerProps {
  isVisible: boolean;
  minWidth?: number;
  minHeight?: number;
  lineClassName?: string;
  handleClassName?: string;
  onResize?: OnResize;
  onResizeEnd?: OnResizeEnd;
}

function SmartNodeResizerInner({
  isVisible,
  minWidth = 100,
  minHeight = 60,
  lineClassName,
  handleClassName,
  onResize,
  onResizeEnd,
}: SmartNodeResizerProps) {
  if (!isVisible) return null;

  return (
    <>
      {LINE_POSITIONS.map((position) => (
        <NodeResizeControl
          key={`line-${position}`}
          position={position}
          variant={ResizeControlVariant.Line}
          keepAspectRatio={false}
          minWidth={minWidth}
          minHeight={minHeight}
          className={lineClassName}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
        />
      ))}
      {CORNER_POSITIONS.map((position) => (
        <NodeResizeControl
          key={`corner-${position}`}
          position={position}
          variant={ResizeControlVariant.Handle}
          keepAspectRatio={true}
          minWidth={minWidth}
          minHeight={minHeight}
          className={handleClassName}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
        />
      ))}
    </>
  );
}

export const SmartNodeResizer = memo(SmartNodeResizerInner);
