/**
 * @file fileStore.ts
 * @description 零外部依赖的原子文件持久化引擎（替代进程重启即丢数据的纯内存存储）。
 * - 蓝图底座（BlueprintStore）落盘到 `<dataDir>/blueprint.json`；
 * - 协同房间快照落盘到 `<dataDir>/rooms/<safeName>.json`；
 * - 所有写入均走「串行队列 + 写临时文件 + fs.rename 原子替换」，避免并发写坏或进程崩溃留半截 JSON。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BlueprintStore } from '../src/core/apiCore';
import { DEFAULT_ROOM_PATH, normalizeRoomPath } from '../src/core/roomPath';

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
  const filePath = path.join(dataDir, 'rooms', `${roomPathToFileKey(roomName)}.json`);
  const parsed = await safeReadJson<Record<string, unknown>>(filePath);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

/** 原子保存协同房间快照。 */
export async function saveRoomSnapshotFile(
  dataDir: string,
  roomName: string,
  snapshot: Record<string, unknown>
): Promise<void> {
  const filePath = path.join(dataDir, 'rooms', `${roomPathToFileKey(roomName)}.json`);
  await atomicWriteJson(filePath, snapshot);
}


/**
 * 将房间路径（支持多级 `/`）映射为防碰撞的安全文件名：
 * - 单段纯 `[a-zA-Z0-9_-]` 保持直观原名（向后兼容老房间快照）；
 * - 含斜杠、中文或特殊字符时附加 8 位 SHA-256 摘要，避免 `team/design` 与 `team_design` 碰撞。
 */
export function roomPathToFileKey(roomPath: string): string {
  const normalized = normalizeRoomPath(roomPath);
  if (/^[a-zA-Z0-9_-]{1,80}$/.test(normalized)) {
    return normalized;
  }
  const slug = normalized
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64) || 'room';
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${slug}__${hash}`;
}

function createSingleFileBlueprintStore(filePath: string): BlueprintStore {
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
      .catch(() => {});
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

/**
 * 按房间路径隔离的 BlueprintStore 注册表：
 * - 默认房间（`atlas-main` / `default`）沿用 `<dataDir>/blueprint.json` 兼容既有部署；
 * - 其余路径房间各自落盘到 `<dataDir>/room-blueprints/<roomPathToFileKey>.json`。
 */
export function createRoomBlueprintStoreRegistry(dataDir: string): {
  getStore: (roomPath?: string | null) => BlueprintStore;
} {
  const stores = new Map<string, BlueprintStore>();
  return {
    getStore(roomPath?: string | null): BlueprintStore {
      const normalized = normalizeRoomPath(roomPath);
      const isDefault = normalized === DEFAULT_ROOM_PATH || normalized === 'default';
      const cacheKey = isDefault ? DEFAULT_ROOM_PATH : normalized;
      let existing = stores.get(cacheKey);
      if (!existing) {
        const targetFile = isDefault
          ? path.join(dataDir, 'blueprint.json')
          : path.join(dataDir, 'room-blueprints', `${roomPathToFileKey(normalized)}.json`);
        existing = createSingleFileBlueprintStore(targetFile);
        stores.set(cacheKey, existing);
      }
      return existing;
    },
  };
}

/** 列出已落盘的房间快照与蓝图文件键。 */
export async function listPersistedRooms(dataDir: string): Promise<string[]> {
  const keys = new Set<string>();
  for (const sub of ['rooms', 'room-blueprints']) {
    try {
      const entries = await fs.readdir(path.join(dataDir, sub));
      for (const name of entries) {
        if (name.endsWith('.json')) keys.add(name.slice(0, -5));
      }
    } catch {
      // 目录尚未创建时忽略
    }
  }
  return Array.from(keys).sort();
}
