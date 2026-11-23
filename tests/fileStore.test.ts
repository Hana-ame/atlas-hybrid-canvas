import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createFileBlueprintStore,
  loadRoomSnapshotFile,
  sanitizeRoomFileKey,
  saveRoomSnapshotFile,
} from '../server/fileStore.ts';

test('createFileBlueprintStore() persists blueprint & revision atomically across restarts', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-filestore-'));
  try {
    const store1 = createFileBlueprintStore(tmpDir);
    assert.equal(await store1.readRevision(), 1);
    assert.equal(await store1.readBlueprint(), null);

    await store1.writeBlueprint({ version: 2, nodes: { n1: { title: '持久化节点' } } });
    await store1.writeRevision(5);

    // 模拟进程重启：重新实例化 store 读取同一目录
    const store2 = createFileBlueprintStore(tmpDir);
    assert.equal(await store2.readRevision(), 5);
    assert.deepEqual(await store2.readBlueprint(), { version: 2, nodes: { n1: { title: '持久化节点' } } });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('createFileBlueprintStore() recovers gracefully from corrupted JSON on disk', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-filestore-corrupt-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'blueprint.json'), '{broken json!!!', 'utf8');
    const store = createFileBlueprintStore(tmpDir);
    assert.equal(await store.readRevision(), 1);
    assert.equal(await store.readBlueprint(), null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('sanitizeRoomFileKey() blocks path traversal and saves/loads room snapshots', async () => {
  assert.equal(sanitizeRoomFileKey('../../etc/passwd'), '______etc_passwd');
  assert.equal(sanitizeRoomFileKey('   '), 'default');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-roomstore-'));
  try {
    const snap = { nodes: { a: { id: 'a', rev: 2, cid: 'c1' } }, annotations: {}, edges: {} };
    await saveRoomSnapshotFile(tmpDir, 'design-room-1', snap);
    const loaded = await loadRoomSnapshotFile(tmpDir, 'design-room-1');
    assert.deepEqual(loaded, snap);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
