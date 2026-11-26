import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createRoomBlueprintStoreRegistry,
  listPersistedRooms,
  roomPathToFileKey,
} from '../server/fileStore.ts';

test('createRoomBlueprintStoreRegistry() persists blueprint & revision atomically across restarts', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-filestore-'));
  try {
    const reg1 = createRoomBlueprintStoreRegistry(tmpDir);
    const store1 = reg1.getStore('atlas-main');
    assert.equal(await store1.readRevision(), 1);
    assert.equal(await store1.readBlueprint(), null);

    await store1.writeBlueprint({ version: 2, nodes: { n1: { title: '持久化节点' } } });
    await store1.writeRevision(5);

    // 模拟进程重启：重新实例化 registry 读取同一目录
    const reg2 = createRoomBlueprintStoreRegistry(tmpDir);
    const store2 = reg2.getStore('atlas-main');
    assert.equal(await store2.readRevision(), 5);
    assert.deepEqual(await store2.readBlueprint(), { version: 2, nodes: { n1: { title: '持久化节点' } } });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('createRoomBlueprintStoreRegistry() recovers gracefully from corrupted JSON on disk', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-filestore-corrupt-'));
  try {
    const roomsDir = path.join(tmpDir, 'rooms');
    await fs.mkdir(roomsDir, { recursive: true });
    const key = roomPathToFileKey('atlas-main');
    await fs.writeFile(path.join(roomsDir, `${key}.json`), '{broken json!!!', 'utf8');

    const reg = createRoomBlueprintStoreRegistry(tmpDir);
    const store = reg.getStore('atlas-main');
    assert.equal(await store.readRevision(), 1);
    assert.equal(await store.readBlueprint(), null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('listPersistedRooms() returns logical roomPath instead of hashed file keys', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-roomlist-'));
  try {
    const reg = createRoomBlueprintStoreRegistry(tmpDir);
    await reg.getStore('team/design').writeBlueprint({ nodes: {} });
    await reg.getStore('team_design').writeBlueprint({ nodes: {} });

    const listed = await listPersistedRooms(tmpDir);
    assert.deepEqual(listed, ['team/design', 'team_design']);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('createRoomBlueprintStoreRegistry() records modification history, deduplicates identical collab saves, and rolls back cleanly', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-history-'));
  try {
    const reg = createRoomBlueprintStoreRegistry(tmpDir);
    const store = reg.getStore('team/doc');

    const bp1 = { nodes: { n1: { id: 'n1', title: 'v1' } }, annotations: {}, edges: {} };
    await store.writeBlueprint(bp1);
    const h1 = await store.recordHistory('publish', { actor: 'admin', summary: '初始发布', blueprint: bp1 });
    assert.equal(h1?.version, 1);

    const dup = await store.recordHistory('collab', { blueprint: bp1 });
    assert.equal(dup, null);

    const bp2 = { nodes: { n1: { id: 'n1', title: 'v2' }, n2: { id: 'n2', title: 'extra' } }, annotations: {}, edges: {} };
    await store.writeBlueprint(bp2);
    const h2 = await store.recordHistory('collab', { actor: 'ws', summary: '协同新增 n2', blueprint: bp2 });
    assert.equal(h2?.version, 2);

    const listBefore = await store.listHistory();
    assert.deepEqual(
      listBefore.map((e) => e.version),
      [2, 1]
    );

    const rb = await store.rollbackToVersion(1, 'admin');
    assert.equal(rb.ok, true);
    assert.deepEqual(rb.blueprint, bp1);
    assert.deepEqual(await store.readBlueprint(), bp1);

    const reg2 = createRoomBlueprintStoreRegistry(tmpDir);
    const store2 = reg2.getStore('team/doc');
    assert.deepEqual(await store2.readBlueprint(), bp1);
    const listAfter = await store2.listHistory();
    assert.equal(listAfter[0].action, 'rollback');
    assert.equal(listAfter[0].version, 3);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('fileStore concurrent cold-start reads do not bypass initial disk hydration', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-filestore-race-'));
  try {
    const reg1 = createRoomBlueprintStoreRegistry(tmpDir);
    const s1 = reg1.getStore('race-room');
    const bp = { version: 1, chunkSize: 512, nodes: { a: { id: 'a' } }, annotations: {}, edges: {} };
    await s1.writeBlueprint(bp);
    await s1.writeRevision(7);
    await s1.recordHistory('publish', { actor: 'admin', summary: 'v1', blueprint: bp });

    const reg2 = createRoomBlueprintStoreRegistry(tmpDir);
    const s2 = reg2.getStore('race-room');
    const [b1, b2, rev1, hist1, hist2] = await Promise.all([
      s2.readBlueprint(),
      s2.readBlueprint(),
      s2.readRevision(),
      s2.listHistory(),
      s2.listHistory(),
    ]);
    assert.deepEqual(b1, bp);
    assert.deepEqual(b2, bp);
    assert.equal(rev1, 7);
    assert.equal(hist1.length, 1);
    assert.equal(hist2.length, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
