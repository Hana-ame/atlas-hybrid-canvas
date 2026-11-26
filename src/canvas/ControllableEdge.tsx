/**
 * @file ControllableEdge.tsx
 * @description 支持任意数量可拖拽控制点的自定义 React Flow 连线组件：
 * - 单向连线在起点绘制带白边实心圆点（双向连线已有 markerStart 箭头时不重复叠画）；
 * - 双击连线本体或双击标签胶囊均正常触发标签编辑（不吞掉 React Flow 的 onEdgeDoubleClick）；
 * - 悬停或选中连线时显示全部控制点手柄（仅左键 + 4px 阈值启动拖拽）与每段曲线中点「+」手柄（左键点击或拖出新增弯折点，亦支持 Alt+双击连线插入）；
 * - 双击或右键控制点直接删除；pointercancel 严格回滚不落盘；组件卸载时通过 dragCleanupRef 自动移除全部 window 监听。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type EdgeProps } from '@xyflow/react';
import type { EdgeControlPoint } from '../core/types';
import {
  buildControlPointEdgePath,
  createControlPointDragSession,
  decideEdgeDoubleClickAction,
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
  onEditLabel?: (edgeId: string) => void;
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
  const onEditLabel = edgeData.onEditLabel;

  const [hovered, setHovered] = useState(false);
  const [draftPoints, setDraftPoints] = useState<EdgeControlPoint[] | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

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

  const startDragControlPoint = useCallback(
    (idx: number, initialPoints: EdgeControlPoint[], ev: React.PointerEvent, isNewInsert = false) => {
      if (!onUpdate || ev.button !== 0) return;
      ev.stopPropagation();
      ev.preventDefault();

      dragCleanupRef.current?.();
      if (!isNewInsert) setDraftPoints(null);
      dragCleanupRef.current = createControlPointDragSession({
        index: idx,
        initialPoints,
        isNewInsert,
        startEvent: {
          button: ev.button,
          pointerId: ev.pointerId,
          clientX: ev.clientX,
          clientY: ev.clientY,
        },
        screenToFlow: (pt) => rf.screenToFlowPosition(pt),
        onDraftChange: setDraftPoints,
        onCommit: (finalPoints) => onUpdate(id, finalPoints),
        addWindowListener: (type, fn) => window.addEventListener(type, fn as unknown as EventListener),
        removeWindowListener: (type, fn) => window.removeEventListener(type, fn as unknown as EventListener),
      });
    },
    [id, onUpdate, rf]
  );

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };
  }, []);

  // 普通双击与 Shift+双击冒泡给 React Flow（编辑标签/框选）；仅 Alt+双击插入控制点
  const handleEdgeDoubleClick = useCallback(
    (ev: React.MouseEvent) => {
      if (decideEdgeDoubleClickAction({ altKey: ev.altKey, hasOnUpdate: Boolean(onUpdate) }) !== 'insert_control_point' || !onUpdate) {
        return;
      }
      ev.stopPropagation();
      ev.preventDefault();
      const pos = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      const insertIdx = findBestInsertIndex(
        { x: sourceX, y: sourceY },
        { x: targetX, y: targetY },
        committedPoints,
        pos
      );
      onUpdate(id, insertControlPoint(committedPoints, insertIdx, pos));
    },
    [committedPoints, id, onUpdate, rf, sourceX, sourceY, targetX, targetY]
  );

  const handleLabelDoubleClick = useCallback(
    (ev: React.MouseEvent) => {
      if (!onEditLabel) return;
      ev.stopPropagation();
      ev.preventDefault();
      onEditLabel(id);
    },
    [id, onEditLabel]
  );

  const handleDeleteControlPoint = useCallback(
    (idx: number, ev: React.MouseEvent) => {
      if (!onUpdate) return;
      ev.stopPropagation();
      ev.preventDefault();
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      setDraftPoints(null);
      onUpdate(id, removeControlPoint(committedPoints, idx));
    },
    [committedPoints, id, onUpdate]
  );

  const routeTooltip =
    edgeData.sourceTitle && edgeData.targetTitle
      ? `${edgeData.sourceTitle} → ${edgeData.targetTitle}（双击编辑标签 · 拖出「+」或 Alt+双击添加控制点 · 右键/双击控制点删除）`
      : '双击编辑标签 · 拖出「+」或 Alt+双击添加控制点 · 右键/双击控制点删除';

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDoubleClick={handleEdgeDoubleClick}
    >
      {/* 透明加粗命中热区，方便选中与双击编辑标签 */}
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

      {/* 起点锚点实心圆点：仅在单向连线（无 markerStart 箭头）时绘制，避免与双向起头箭头重叠 */}
      {!markerStart && (
        <circle
          cx={sourceX}
          cy={sourceY}
          r={isActive ? 5 : 3.8}
          fill={stroke}
          stroke="#FFFFFF"
          strokeWidth={1.6}
          pointerEvents="none"
        />
      )}

      {/* 控制点手柄（仅在可写模式提供拖拽与删除） */}
      {isActive &&
        activePoints.map((pt, idx) => (
          <g
            key={`${id}-cp-${idx}`}
            transform={`translate(${pt.x}, ${pt.y})`}
            style={{ cursor: onUpdate ? 'grab' : 'default' }}
            onPointerDown={onUpdate ? (ev) => startDragControlPoint(idx, activePoints, ev, false) : undefined}
            onDoubleClick={onUpdate ? (ev) => handleDeleteControlPoint(idx, ev) : undefined}
            onContextMenu={onUpdate ? (ev) => handleDeleteControlPoint(idx, ev) : undefined}
          >
            <title>{onUpdate ? '左键拖动调整弯曲路径 · 双击或右键删除此控制点' : '路径控制点'}</title>
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

      {/* 每段曲线真实 B(0.5) 中点 "+" 插入手柄 */}
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
              if (ev.button !== 0) return;
              const inserted = insertControlPoint(committedPoints, mid.insertIndex, {
                x: mid.x,
                y: mid.y,
              });
              startDragControlPoint(mid.insertIndex, inserted, ev, true);
            }}
          >
            <title>左键点击或拖出新增控制点</title>
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

      {/* 连线标签（放在真实曲线弧长中点，双击直接编辑标签） */}
      {label && (
        <EdgeLabelRenderer>
          <div
            title={routeTooltip}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onDoubleClick={handleLabelDoubleClick}
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
