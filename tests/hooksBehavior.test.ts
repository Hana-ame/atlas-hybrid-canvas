import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBlueprintHistory } from '../src/hooks/useBlueprintHistory.ts';
import { useBlueprintIO } from '../src/hooks/useBlueprintIO.ts';
import { useCanvasShortcuts } from '../src/hooks/useCanvasShortcuts.ts';
import { useOverlaySync } from '../src/hooks/useOverlaySync.ts';
import { useRoomCollaboration } from '../src/hooks/useRoomCollaboration.ts';
import { createEmptyOverlay, getOverlayStorageKey } from '../src/core/layeredStore.ts';
import { createSeedBlueprint } from '../src/core/seedBlueprint.ts';
import type { BaseBlueprint, LocalOverlayState } from '../src/core/types.ts';

test('getOverlayStorageKey isolates overlay storage keys across rooms while preserving default room key', () => {
  const defKey = getOverlayStorageKey('atlas-main');
  const aKey = getOverlayStorageKey('team/alpha');
  const bKey = getOverlayStorageKey('team/beta');
  assert.notEqual(aKey, defKey);
  assert.notEqual(aKey, bKey);
  assert.equal(getOverlayStorageKey('default'), defKey);
});

test('useBlueprintHistory, useBlueprintIO, useCanvasShortcuts, useOverlaySync, and useRoomCollaboration initialize cleanly', () => {
  const base = createSeedBlueprint();
  const overlay = createEmptyOverlay();
  let capturedHistory: ReturnType<typeof useBlueprintHistory> | null = null;
  let capturedIO: ReturnType<typeof useBlueprintIO> | null = null;
  let capturedCollab: ReturnType<typeof useRoomCollaboration> | null = null;

  function Harness() {
    const baseRef = React.useRef<BaseBlueprint>(base);
    const overlayRef = React.useRef<LocalOverlayState>(overlay);
    const roomNameRef = React.useRef('team/test');
    const renderedScriptsRef = React.useRef(new Map<string, string>());
    const [, setBase] = React.useState(base);
    const [, setOverlay] = React.useState(overlay);
    const [, setStatus] = React.useState('');
    const [, setTick] = React.useState(0);
    const [, setRoomStatus] = React.useState<'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'error'>('disconnected');

    capturedHistory = useBlueprintHistory(
      baseRef,
      overlayRef,
      setBase,
      setOverlay,
      setStatus,
      () => setTick((t) => t + 1)
    );

    capturedIO = useBlueprintIO({
      baseRef,
      overlayRef,
      setBase,
      setOverlay,
      setStatusLog: setStatus,
      setChunkSyncTick: setTick,
      renderedScriptsRef,
      pushHistory: capturedHistory.pushHistory,
      mergeTrustEntries: () => {},
      selfCid: 'cid-test',
    });

    useCanvasShortcuts({
      handleUndo: capturedHistory.handleUndo,
      handleRedo: capturedHistory.handleRedo,
      handleDeleteSelected: () => {},
      setSearchOpen: () => {},
      setSearchQuery: () => {},
      setSelectedNodeId: () => {},
      setSelectedAnnotationId: () => {},
      setRoomModalOpen: () => {},
      setSaveModalOpen: () => {},
    });

    useOverlaySync(overlay, true, setOverlay, setStatus, () => {}, 'team/test');

    capturedCollab = useRoomCollaboration({
      base,
      baseRef,
      setBase,
      setChunkSyncTick: setTick,
      setStatusLog: setStatus,
      selfCid: 'cid-test',
      roomWsUrl: 'ws://localhost:8787/ws',
      roomName: 'team/test',
      roomNameRef,
      roomStatus: 'disconnected',
      setRoomStatus,
      setRoomModalOpen: () => {},
      mergeTrustEntries: () => {},
    });

    return React.createElement('div', null, 'hooks-ready');
  }

  const html = renderToStaticMarkup(React.createElement(Harness));
  assert.equal(html, '<div>hooks-ready</div>');
  assert.ok(capturedHistory);
  assert.equal(capturedHistory!.historyMeta.canUndo, false);
  assert.equal(capturedHistory!.historyMeta.canRedo, false);
  assert.equal(typeof capturedIO!.handleExportJSON, 'function');
  assert.equal(typeof capturedIO!.handleImportJSONFile, 'function');
  assert.equal(typeof capturedCollab!.handleConnectRoom, 'function');

  // Exercise pushHistory -> undo -> redo stack transitions directly
  capturedHistory!.pushHistory();
  capturedHistory!.handleUndo();
  capturedHistory!.handleRedo();
});
