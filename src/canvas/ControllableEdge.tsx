/**
 * @file ControllableEdge.tsx
 * @description 支持任意数量可拖拽控制点的自定义 React Flow 连线组件：
 * - 起点处绘制显式实心圆点，配合终点箭头清晰标识「从哪连向哪」；
 * - 选中或悬停连线时显示全部控制点手柄（拖动实时弯曲）与每段中点「+」手柄（点击或拖出新增弯折点）；
 * - 双击连线任意处直接插入新控制点；双击或右键任意控制点删除该控制点；
 * - 拖动中仅走本地状态 60fps 顺滑更新，松手时一次性提交给 base（触发撤销栈与 CRDT 协同广播）。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type EdgeProps } from '@xyflow/react';
import type { EdgeControlPoint } from '../core/types';
import {
  buildControlPointEdgePath,
  findBestInsertIndex,
  insertControlPoint,
  MAX_EDGE_CONTROL_POINTS,
  removeControlPoint,
  sanitizeControlPoints,
} from '../core/edgePath';

export interface ControllableEdgeData extends Record<string, unknown> {
  controlPoints?: EdgeControlPoint[];
  sourceTitle?: string;
  targetTitle?: string;
  onUpdateControlPoints?: (edgeId: string, nextPoints: EdgeControlPoint[]) => void;
}

export const ControllableEdge = React.memo(function ControllableEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    label,
    style,
    markerStart,
    markerEnd,
    selected,
    data,
  } = props;

  const rf = useReactFlow();
  const edgeData = (data || {}) as ControllableEdgeData;
  const committedPoints = sanitizeControlPoints(edgeData.controlPoints);
  const onUpdate = edgeData.onUpdateControlPoints;

  const [hovered, setHovered] = useState(false);
  const [draftPoints, setDraftPoints] = useState<EdgeControlPoint[] | null>(null);
  const draftRef = useRef<EdgeControlPoint[] | null>(null);
  const draggingIdxRef = useRef<number | null>(null);

  const activePoints = draftPoints ?? committedPoints;
  const stroke = String((style as React.CSSProperties | undefined)?.stroke || '#64748B');
  const isActive = Boolean(selected || hovered || draftPoints !== null);

  const { path, labelX, labelY, segmentMidpoints } = buildControlPointEdgePath(
    sourceX,
    sourceY,
    targetX,
    targetY,
    activePoints
  );

  // 拖动过程中绑定全局 window pointermove / pointerup，确保快速拖动不脱手
  const startDragControlPoint = useCallback(
    (idx: number, initialPoints: EdgeControlPoint[], ev: React.PointerEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      draggingIdxRef.current = idx;
      draftRef.current = initialPoints;
      setDraftPoints(initialPoints);

      const handleMove = (moveEv: PointerEvent) => {
        if (draggingIdxRef.current === null || !draftRef.current) return;
        const pos = rf.screenToFlowPosition({ x: moveEv.clientX, y: moveEv.clientY });
        const next = draftRef.current.slice();
        next[draggingIdxRef.current] = { x: Math.round(pos.x), y: Math.round(pos.y) };
        draftRef.current = next;
        setDraftPoints(next);
      };

      const handleUp = () => {
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        window.removeEventListener('pointercancel', handleUp);
        const finalPoints = draftRef.current;
        draggingIdxRef.current = null;
        draftRef.current = null;
        setDraftPoints(null);
        if (finalPoints && onUpdate) {
          onUpdate(id, finalPoints);
        }
      };

      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
      window.addEventListener('pointercancel', handleUp);
    },
    [id, onUpdate, rf]
  );

  // 卸载时兜底清理 draft
  useEffect(() => {
    return () => {
      draggingIdxRef.current = null;
      draftRef.current = null;
    };
  }, []);

  const handleEdgeDoubleClick = useCallback(
    (ev: React.MouseEvent) => {
      if (!onUpdate) return;
      ev.stopPropagation();
      ev.preventDefault();
      const pos = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      const insertIdx = findBestInsertIndex(
        { x: sourceX, y: sourceY },
        { x: targetX, y: targetY },
        committedPoints,
        pos
      );
      const next = insertControlPoint(committedPoints, insertIdx, pos);
      onUpdate(id, next);
    },
    [committedPoints, id, onUpdate, rf, sourceX, sourceY, targetX, targetY]
  );

  const handleDeleteControlPoint = useCallback(
    (idx: number, ev: React.MouseEvent) => {
      if (!onUpdate) return;
      ev.stopPropagation();
      ev.preventDefault();
      onUpdate(id, removeControlPoint(committedPoints, idx));
    },
    [committedPoints, id, onUpdate]
  );

  const routeTooltip =
    edgeData.sourceTitle && edgeData.targetTitle
      ? `${edgeData.sourceTitle} → ${edgeData.targetTitle}（双击连线添加控制点，双击控制点删除）`
      : '双击连线添加控制点，拖拽调整路径，双击控制点删除';

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDoubleClick={handleEdgeDoubleClick}
    >
      {/* 透明加粗命中热区，方便选中与双击插入控制点 */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        className="react-flow__edge-interaction"
      />

      {/* 选中/悬停时的柔和外发光，方便一眼看出整条连线来路 */}
      {isActive && (
        <path
          d={path}
          fill="none"
          stroke={stroke}
          strokeOpacity={0.22}
          strokeWidth={8}
          strokeLinecap="round"
        />
      )}

      <BaseEdge
        id={id}
        path={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke,
          strokeWidth: isActive ? 3 : 2.2,
        }}
      />

      {/* 起点锚点实心圆点：清晰标识连线从哪端发出 */}
      <circle
        cx={sourceX}
        cy={sourceY}
        r={isActive ? 5 : 3.8}
        fill={stroke}
        stroke="#FFFFFF"
        strokeWidth={1.6}
        pointerEvents="none"
      />

      {/* 控制点与中点 "+" 插入手柄（在选中/悬停/拖拽时渲染） */}
      {isActive &&
        activePoints.map((pt, idx) => (
          <g
            key={`${id}-cp-${idx}`}
            transform={`translate(${pt.x}, ${pt.y})`}
            style={{ cursor: 'grab' }}
            onPointerDown={(ev) => startDragControlPoint(idx, activePoints, ev)}
            onDoubleClick={(ev) => handleDeleteControlPoint(idx, ev)}
            onContextMenu={(ev) => handleDeleteControlPoint(idx, ev)}
          >
            <title>拖动调整弯曲路径 · 双击或右键删除此控制点</title>
            <circle r={11} fill="transparent" />
            <circle
              r={6}
              fill="#FFFFFF"
              stroke={stroke}
              strokeWidth={2.4}
            />
            <circle r={2.2} fill={stroke} />
          </g>
        ))}

      {isActive &&
        onUpdate &&
        activePoints.length < MAX_EDGE_CONTROL_POINTS &&
        draftPoints === null &&
        segmentMidpoints.map((mid) => (
          <g
            key={`${id}-add-${mid.insertIndex}`}
            transform={`translate(${mid.x}, ${mid.y})`}
            style={{ cursor: 'copy' }}
            onPointerDown={(ev) => {
              const inserted = insertControlPoint(committedPoints, mid.insertIndex, {
                x: mid.x,
                y: mid.y,
              });
              startDragControlPoint(mid.insertIndex, inserted, ev);
            }}
          >
            <title>点击或拖出新增控制点</title>
            <circle r={9} fill="transparent" />
            <circle
              r={5.5}
              fill="#FFFFFF"
              fillOpacity={0.92}
              stroke={stroke}
              strokeWidth={1.5}
              strokeDasharray="2 1.5"
            />
            <path
              d="M -2.5 0 L 2.5 0 M 0 -2.5 L 0 2.5"
              stroke={stroke}
              strokeWidth={1.4}
              strokeLinecap="round"
            />
          </g>
        ))}

      {/* 连线标签（放在曲线弧长中点，带清晰白底与来路提示） */}
      {label && (
        <EdgeLabelRenderer>
          <div
            title={routeTooltip}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onDoubleClick={handleEdgeDoubleClick}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
              borderColor: isActive ? stroke : '#CBD5E1',
              color: isActive ? stroke : '#334155',
            }}
            className="nodrag nopan select-none rounded-full border bg-white/95 px-2 py-0.5 text-[11px] font-semibold shadow-sm transition-colors"
          >
            {String(label)}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
});
