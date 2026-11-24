import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ROOM_PATH,
  buildRoomBlueprintPublishUrl,
  buildBrowserRoomUrl,
  buildRoomBlueprintUrl,
  buildRoomWsUrl,
  extractRoomPathFromBrowserLocation,
  extractRoomPathFromWsPathname,
  normalizeRoomPath,
} from '../src/core/roomPath.ts';
import { createRoomBlueprintStoreRegistry, roomPathToFileKey } from '../server/fileStore.ts';

test('normalizeRoomPath() preserves nested paths, blocks traversal, and defaults empty to atlas-main', () => {
  assert.equal(normalizeRoomPath(''), DEFAULT_ROOM_PATH);
  assert.equal(normalizeRoomPath('/'), DEFAULT_ROOM_PATH);
  assert.equal(normalizeRoomPath('/team/design/'), 'team/design');
  assert.equal(normalizeRoomPath('/../etc/../../team/alpha'), 'etc/team/alpha');
  assert.equal(normalizeRoomPath('产品/一期'), '产品/一期');
});

test('extractRoomPathFromWsPathname() supports path-based /ws/<roomPath> and legacy /ws?room=', () => {
  assert.deepEqual(extractRoomPathFromWsPathname('/ws/team/design', '/ws', null), {
    matched: true,
    roomPath: 'team/design',
  });
  assert.deepEqual(extractRoomPathFromWsPathname('/ws/alpha/', '/ws', null), {
    matched: true,
    roomPath: 'alpha',
  });
  assert.deepEqual(extractRoomPathFromWsPathname('/ws', '/ws', 'legacy-room'), {
    matched: true,
    roomPath: 'legacy-room',
  });
  assert.deepEqual(extractRoomPathFromWsPathname('/ws', '/ws', null), {
    matched: true,
    roomPath: null,
  });
  assert.deepEqual(extractRoomPathFromWsPathname('/other', '/ws', 'foo'), {
    matched: false,
    roomPath: null,
  });
});

test('extractRoomPathFromBrowserLocation() & URL builders work cleanly for nested room paths', () => {
  assert.equal(extractRoomPathFromBrowserLocation('/'), DEFAULT_ROOM_PATH);
  assert.equal(extractRoomPathFromBrowserLocation('/index.html'), DEFAULT_ROOM_PATH);
  assert.equal(extractRoomPathFromBrowserLocation('/team/design'), 'team/design');
  assert.equal(extractRoomPathFromBrowserLocation('/r/team/design'), 'team/design');
  assert.equal(extractRoomPathFromBrowserLocation('/room/proj-1'), 'proj-1');

  assert.equal(
    buildRoomWsUrl('ws://localhost:8787/ws', 'team/design', 'cid-1'),
    'ws://localhost:8787/ws/team/design?cid=cid-1'
  );
  assert.equal(buildRoomBlueprintUrl('team/design'), '/api/rooms/team/design/blueprint');
  assert.equal(buildRoomBlueprintPublishUrl('team/design'), '/api/rooms/team/design/blueprint/publish');
});

test('roomPathToFileKey() prevents collisions between nested paths and underscores', () => {
  assert.notEqual(roomPathToFileKey('team/design'), roomPathToFileKey('team_design'));
  assert.equal(roomPathToFileKey('alpha'), 'alpha');
});

test('createRoomBlueprintStoreRegistry() isolates blueprints and revisions across room paths on disk', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-room-bp-'));
  try {
    const reg = createRoomBlueprintStoreRegistry(tmpDir);
    const storeA = reg.getStore('team/alpha');
    const storeB = reg.getStore('team/beta');

    await storeA.writeBlueprint({ nodes: { a: { id: 'a' } } });
    await storeA.writeRevision(5);

    await storeB.writeBlueprint({ nodes: { b: { id: 'b' } } });
    await storeB.writeRevision(2);

    // Reload from a fresh registry instance to verify disk persistence & isolation
    const reg2 = createRoomBlueprintStoreRegistry(tmpDir);
    assert.deepEqual(await reg2.getStore('team/alpha').readBlueprint(), { nodes: { a: { id: 'a' } } });
    assert.equal(await reg2.getStore('team/alpha').readRevision(), 5);
    assert.deepEqual(await reg2.getStore('team/beta').readBlueprint(), { nodes: { b: { id: 'b' } } });
    assert.equal(await reg2.getStore('team/beta').readRevision(), 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('extractRoomPathFromBrowserLocation() strips GitHub Pages basePath and uses ?room= cleanly', () => {
  assert.equal(extractRoomPathFromBrowserLocation('/atlas-canvas/', '/atlas-canvas/', ''), DEFAULT_ROOM_PATH);
  assert.equal(extractRoomPathFromBrowserLocation('/atlas-canvas/index.html', '/atlas-canvas/', ''), DEFAULT_ROOM_PATH);
  assert.equal(extractRoomPathFromBrowserLocation('/atlas-canvas/', '/atlas-canvas/', '?room=team%2Fdesign'), 'team/design');
  assert.equal(extractRoomPathFromBrowserLocation('/atlas-canvas/proj-a', '/atlas-canvas/', ''), 'proj-a');
  assert.equal(buildBrowserRoomUrl('team/design', '/atlas-canvas/', '', ''), '/atlas-canvas/?room=team%2Fdesign');
  assert.equal(buildBrowserRoomUrl('atlas-main', '/atlas-canvas/', '?room=team%2Fdesign', ''), '/atlas-canvas/');
  assert.equal(buildBrowserRoomUrl('team/design', '/', '', ''), '/team/design');
});

test('createRoomBlueprintStoreRegistry() enforces bounded LRU cache size without losing disk data', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-room-lru-'));
  try {
    const reg = createRoomBlueprintStoreRegistry(tmpDir, 2);
    await reg.getStore('r1').writeBlueprint({ nodes: { a: 1 } });
    await reg.getStore('r2').writeBlueprint({ nodes: { b: 2 } });
    await reg.getStore('r3').writeBlueprint({ nodes: { c: 3 } });
    assert.equal(reg.cachedCount(), 2);
    assert.deepEqual(await reg.getStore('r1').readBlueprint(), { nodes: { a: 1 } });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
