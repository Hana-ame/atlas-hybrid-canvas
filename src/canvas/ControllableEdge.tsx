/**
 * @file ControllableEdge.tsx
 * @description 支持任意数量可拖拽控制点与画布内联标签编辑的自定义 React Flow 连线组件：
 * - 单向连线在起点绘制带白边实心圆点（双向连线已有 markerStart 箭头时不重复叠画）；
 * - 双击连线本体或双击标签胶囊均在画布标签位置 (labelX, labelY) 原地弹出内联输入框（绝不调用 window.alert / window.prompt）；
 * - 悬停或选中连线时显示全部控制点手柄（显式 pointer-events: all + nodrag nopan 隔离画布拖拽，仅左键 + 4px 阈值启动拖拽）与每段曲线中点「+」手柄（自动避让标签胶囊）；
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
  isEditingLabel?: boolean;
  edgeFlag?: boolean;
  edgeMsg?: unknown;
  onUpdateControlPoints?: (edgeId: string, nextPoints: EdgeControlPoint[]) => void;
  onEditLabel?: (edgeId: string) => void;
  onCommitLabel?: (edgeId: string, nextLabel: string) => void;
  onCancelEditLabel?: (edgeId: string) => void;
}

const HOVER_LEAVE_DELAY_MS = 120;
const LABEL_COLLISION_RADIUS_PX = 28;
const ADD_HANDLE_LABEL_OFFSET_Y = 22;

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
  const onCommitLabel = edgeData.onCommitLabel;
  const onCancelEditLabel = edgeData.onCancelEditLabel;
  const isEditingLabel = Boolean(edgeData.isEditingLabel);
  const edgeFlag = Boolean(edgeData.edgeFlag);
  const edgeMsgPreview =
    edgeData.edgeMsg === undefined || edgeData.edgeMsg === null
      ? ''
      : typeof edgeData.edgeMsg === 'string'
        ? edgeData.edgeMsg.slice(0, 24)
        : (() => { try { return JSON.stringify(edgeData.edgeMsg).slice(0, 28); } catch { return 'msg'; } })();

  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [draftPoints, setDraftPoints] = useState<EdgeControlPoint[] | null>(null);
  const [draftLabel, setDraftLabel] = useState<string>(() => (label == null ? '' : String(label)));
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const hoverLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const labelInputRef = useRef<HTMLInputElement | null>(null);
  const editClosedRef = useRef(false);

  const activePoints = draftPoints ?? committedPoints;
  const stroke = String((style as React.CSSProperties | undefined)?.stroke || '#64748B');
  const isActive = Boolean(selected || hovered || dragging || draftPoints !== null || isEditingLabel);

  const { path, labelX, labelY, segmentMidpoints } = buildControlPointEdgePath(
    sourceX,
    sourceY,
    targetX,
    targetY,
    activePoints
  );

  const handleMouseEnter = useCallback(() => {
    if (hoverLeaveTimerRef.current !== null) {
      clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = null;
    }
    setHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverLeaveTimerRef.current !== null) {
      clearTimeout(hoverLeaveTimerRef.current);
    }
    hoverLeaveTimerRef.current = setTimeout(() => {
      hoverLeaveTimerRef.current = null;
      setHovered(false);
    }, HOVER_LEAVE_DELAY_MS);
  }, []);

  // 进入标签内联编辑态时同步初值并自动聚焦全选
  useEffect(() => {
    if (!isEditingLabel) return;
    editClosedRef.current = false;
    setDraftLabel(label == null ? '' : String(label));
    const focusTimer = setTimeout(() => {
      const el = labelInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }, 0);
    return () => clearTimeout(focusTimer);
  }, [isEditingLabel, label]);

  const commitInlineLabel = useCallback(() => {
    if (editClosedRef.current) return;
    editClosedRef.current = true;
    onCommitLabel?.(id, draftLabel);
  }, [draftLabel, id, onCommitLabel]);

  const cancelInlineLabel = useCallback(() => {
    if (editClosedRef.current) return;
    editClosedRef.current = true;
    onCancelEditLabel?.(id);
  }, [id, onCancelEditLabel]);

  const startDragControlPoint = useCallback(
    (idx: number, initialPoints: EdgeControlPoint[], ev: React.PointerEvent, isNewInsert = false) => {
      if (!onUpdate || ev.button !== 0) return;
      ev.stopPropagation();
      ev.preventDefault();

      dragCleanupRef.current?.();
      if (!isNewInsert) setDraftPoints(null);
      setDragging(true);

      const rawCleanup = createControlPointDragSession({
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
        onDraftChange: (draft) => {
          setDraftPoints(draft);
          if (draft === null) {
            setDragging(false);
          }
        },
        onCommit: (finalPoints) => {
          setDragging(false);
          onUpdate(id, finalPoints);
        },
        addWindowListener: (type, fn) => window.addEventListener(type, fn as unknown as EventListener, true),
        removeWindowListener: (type, fn) => window.removeEventListener(type, fn as unknown as EventListener, true),
      });

      if (!rawCleanup) {
        setDragging(false);
        dragCleanupRef.current = null;
        return;
      }

      dragCleanupRef.current = () => {
        rawCleanup();
        setDragging(false);
      };
    },
    [id, onUpdate, rf]
  );

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      if (hoverLeaveTimerRef.current !== null) {
        clearTimeout(hoverLeaveTimerRef.current);
        hoverLeaveTimerRef.current = null;
      }
    };
  }, []);

  // 普通双击与 Shift+双击冒泡给 React Flow（画布内联编辑标签）；仅 Alt+双击插入控制点
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
      setDragging(false);
      onUpdate(id, removeControlPoint(committedPoints, idx));
    },
    [committedPoints, id, onUpdate]
  );

  const stopCanvasPanPropagation = useCallback((ev: React.MouseEvent | React.TouchEvent) => {
    ev.stopPropagation();
  }, []);

  const routeTooltip =
    edgeData.sourceTitle && edgeData.targetTitle
      ? `${edgeData.sourceTitle} → ${edgeData.targetTitle}（双击编辑标签 · 拖出「+」或 Alt+双击添加控制点 · 右键/双击控制点删除）`
      : '双击编辑标签 · 拖出「+」或 Alt+双击添加控制点 · 右键/双击控制点删除';

  const hasVisibleLabel = Boolean(label) || isEditingLabel || edgeFlag;

  return (
    <g
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
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
          pointerEvents="none"
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

      {/* 控制点手柄（显式 pointerEvents="all" + nodrag nopan，避免被 React Flow 拖拽画布吞掉事件） */}
      {isActive &&
        activePoints.map((pt, idx) => (
          <g
            key={`${id}-cp-${idx}`}
            className="nodrag nopan edge-control-handle"
            transform={`translate(${pt.x}, ${pt.y})`}
            pointerEvents="all"
            style={{
              cursor: onUpdate ? (dragging ? 'grabbing' : 'grab') : 'default',
              pointerEvents: 'all',
              touchAction: 'none',
            }}
            onMouseDown={onUpdate ? stopCanvasPanPropagation : undefined}
            onTouchStart={onUpdate ? stopCanvasPanPropagation : undefined}
            onPointerDown={onUpdate ? (ev) => startDragControlPoint(idx, activePoints, ev, false) : undefined}
            onDoubleClick={onUpdate ? (ev) => handleDeleteControlPoint(idx, ev) : undefined}
            onContextMenu={onUpdate ? (ev) => handleDeleteControlPoint(idx, ev) : undefined}
          >
            <title>{onUpdate ? '左键拖动调整弯曲路径 · 双击或右键删除此控制点' : '路径控制点'}</title>
            <circle r={12} fill="transparent" pointerEvents="all" />
            <circle
              r={6}
              fill="#FFFFFF"
              stroke={stroke}
              strokeWidth={2.4}
              pointerEvents="all"
            />
            <circle r={2.2} fill={stroke} pointerEvents="all" />
          </g>
        ))}

      {/* 每段曲线真实 B(0.5) 中点 "+" 插入手柄（若与标签胶囊重合则自动下移避让） */}
      {isActive &&
        onUpdate &&
        !isEditingLabel &&
        activePoints.length < MAX_EDGE_CONTROL_POINTS &&
        draftPoints === null &&
        segmentMidpoints.map((mid) => {
          const collidesLabel =
            hasVisibleLabel &&
            Math.hypot(mid.x - labelX, mid.y - labelY) < LABEL_COLLISION_RADIUS_PX;
          const handleX = mid.x;
          const handleY = collidesLabel ? mid.y + ADD_HANDLE_LABEL_OFFSET_Y : mid.y;

          return (
            <g
              key={`${id}-add-${mid.insertIndex}`}
              className="nodrag nopan edge-control-handle"
              transform={`translate(${handleX}, ${handleY})`}
              pointerEvents="all"
              style={{
                cursor: 'copy',
                pointerEvents: 'all',
                touchAction: 'none',
              }}
              onMouseDown={stopCanvasPanPropagation}
              onTouchStart={stopCanvasPanPropagation}
              onPointerDown={(ev) => {
                if (ev.button !== 0) return;
                const inserted = insertControlPoint(committedPoints, mid.insertIndex, {
                  x: handleX,
                  y: handleY,
                });
                startDragControlPoint(mid.insertIndex, inserted, ev, true);
              }}
            >
              <title>左键点击或拖出新增控制点</title>
              <circle r={10} fill="transparent" pointerEvents="all" />
              <circle
                r={5.5}
                fill="#FFFFFF"
                fillOpacity={0.95}
                stroke={stroke}
                strokeWidth={1.5}
                strokeDasharray="2 1.5"
                pointerEvents="all"
              />
              <path
                d="M -2.5 0 L 2.5 0 M 0 -2.5 L 0 2.5"
                stroke={stroke}
                strokeWidth={1.4}
                strokeLinecap="round"
                pointerEvents="none"
              />
            </g>
          );
        })}

      {/* 连线标签 / 未读消息胶囊 / 画布内联标签输入框 */}
      {(isEditingLabel || Boolean(label) || edgeFlag) && (
        <EdgeLabelRenderer>
          {isEditingLabel ? (
            <div
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
              onMouseDown={stopCanvasPanPropagation}
              onTouchStart={stopCanvasPanPropagation}
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={(ev) => ev.stopPropagation()}
              onDoubleClick={(ev) => ev.stopPropagation()}
              style={{
                position: 'absolute',
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                pointerEvents: 'all',
                zIndex: 1000,
              }}
              className="nodrag nopan"
            >
              <input
                ref={labelInputRef}
                type="text"
                aria-label="编辑连线标签"
                placeholder="输入连线文字..."
                value={draftLabel}
                onChange={(ev) => setDraftLabel(ev.target.value)}
                onBlur={commitInlineLabel}
                onKeyDown={(ev) => {
                  ev.stopPropagation();
                  if (ev.nativeEvent.isComposing) return;
                  if (ev.key === 'Enter') {
                    ev.preventDefault();
                    commitInlineLabel();
                  } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    cancelInlineLabel();
                  }
                }}
                style={{
                  borderColor: stroke,
                  width: `${Math.max(10, Math.min(32, draftLabel.length + 5))}ch`,
                }}
                className="nodrag nopan rounded-full border-2 bg-white px-2.5 py-0.5 text-center text-[11px] font-semibold text-slate-800 shadow-md outline-none ring-2 ring-blue-500/20"
              />
            </div>
          ) : (
            <div
              title={edgeFlag ? `${routeTooltip}
未读消息：${edgeMsgPreview}` : routeTooltip}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
              onDoubleClick={handleLabelDoubleClick}
              style={{
                position: 'absolute',
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                pointerEvents: 'all',
                borderColor: edgeFlag ? '#F59E0B' : (isActive ? stroke : '#CBD5E1'),
                color: edgeFlag ? '#B45309' : (isActive ? stroke : '#334155'),
                backgroundColor: edgeFlag ? '#FFFBEB' : 'rgba(255,255,255,0.95)',
              }}
              className="nodrag nopan inline-flex select-none items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold shadow-sm transition-colors"
            >
              {edgeFlag && <span className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse" />}
              <span>{label ? String(label) : 'NEW'}</span>
              {edgeFlag && edgeMsgPreview && (
                <span className="max-w-[110px] truncate font-mono text-[10px] font-normal text-amber-800">
                  {edgeMsgPreview}
                </span>
              )}
            </div>
          )}
        </EdgeLabelRenderer>
      )}
    </g>
  );
});
