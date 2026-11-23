/**
 * @file fileStore.ts
 * @description 零外部依赖的原子文件持久化引擎（替代进程重启即丢数据的纯内存存储）。
 * - 蓝图底座（BlueprintStore）落盘到 `<dataDir>/blueprint.json`；
 * - 协同房间快照落盘到 `<dataDir>/rooms/<safeName>.json`；
 * - 所有写入均走「串行队列 + 写临时文件 + fs.rename 原子替换」，避免并发写坏或进程崩溃留半截 JSON。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { BlueprintStore } from '../src/core/apiCore';

interface PersistedBlueprintFile {
  revision: number;
  blueprint: unknown;
  updatedAt: number;
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  await fs.writeFile(tmpPath, payload, 'utf8');
  await fs.rename(tmpPath, filePath);
}

async function safeReadJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 将房间名消毒为安全文件名，防止路径遍历。 */
export function sanitizeRoomFileKey(roomName: string): string {
  const cleaned = String(roomName || 'default')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);
  return cleaned || 'default';
}

/**
 * 持久化版 BlueprintStore（与 apiCore.ts 的 createMemoryStore 接口完全一致）。
 * 启动时惰性从磁盘水合一次，之后读走内存、写走串行原子落盘。
 */
export function createFileBlueprintStore(dataDir: string): BlueprintStore {
  const filePath = path.join(dataDir, 'blueprint.json');
  let loaded = false;
  let revision = 1;
  let blueprint: unknown = null;
  let writeChain: Promise<void> = Promise.resolve();

  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    const saved = await safeReadJson<Partial<PersistedBlueprintFile>>(filePath);
    if (saved && typeof saved === 'object') {
      const r = Number(saved.revision);
      if (Number.isFinite(r) && r >= 1) revision = Math.trunc(r);
      if (saved.blueprint !== undefined) blueprint = saved.blueprint;
    }
  };

  const enqueuePersist = (): Promise<void> => {
    const snap: PersistedBlueprintFile = {
      revision,
      blueprint,
      updatedAt: Date.now(),
    };
    writeChain = writeChain
      .then(() => atomicWriteJson(filePath, snap))
      .catch(() => {
        // 落盘失败时不阻断后续内存写入队列
      });
    return writeChain;
  };

  return {
    async readRevision() {
      await ensureLoaded();
      return revision;
    },
    async writeRevision(rev: number) {
      await ensureLoaded();
      revision = rev;
      await enqueuePersist();
    },
    async readBlueprint() {
      await ensureLoaded();
      return blueprint;
    },
    async writeBlueprint(bp: unknown) {
      await ensureLoaded();
      blueprint = bp;
      await enqueuePersist();
      return true;
    },
  };
}

/** 读取协同房间持久化快照。 */
export async function loadRoomSnapshotFile(
  dataDir: string,
  roomName: string
): Promise<Record<string, unknown> | null> {
  const filePath = path.join(dataDir, 'rooms', `${sanitizeRoomFileKey(roomName)}.json`);
  const parsed = await safeReadJson<Record<string, unknown>>(filePath);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

/** 原子保存协同房间快照。 */
export async function saveRoomSnapshotFile(
  dataDir: string,
  roomName: string,
  snapshot: Record<string, unknown>
): Promise<void> {
  const filePath = path.join(dataDir, 'rooms', `${sanitizeRoomFileKey(roomName)}.json`);
  await atomicWriteJson(filePath, snapshot);
}
