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

/**
 * 读取统一房间持久化文件中的蓝图快照（REST 与 WS 共用 `<dataDir>/rooms/<key>.json` 单一事实源）。
 */
export async function loadRoomSnapshotFile(
  dataDir: string,
  roomName: string
): Promise<Record<string, unknown> | null> {
  const filePath = path.join(dataDir, 'rooms', `${roomPathToFileKey(roomName)}.json`);
  const parsed = await safeReadJson<Record<string, unknown>>(filePath);
  if (!parsed || typeof parsed !== 'object') return null;
  if ('blueprint' in parsed && parsed.blueprint && typeof parsed.blueprint === 'object') {
    return parsed.blueprint as Record<string, unknown>;
  }
  return parsed;
}

/**
 * 原子保存统一房间文件中的蓝图快照（保留既有 revision，与 REST 蓝图读写共用同一文件）。
 */
export async function saveRoomSnapshotFile(
  dataDir: string,
  roomName: string,
  snapshot: Record<string, unknown>
): Promise<void> {
  const filePath = path.join(dataDir, 'rooms', `${roomPathToFileKey(roomName)}.json`);
  const existing = await safeReadJson<Partial<PersistedBlueprintFile>>(filePath);
  const rev = existing && typeof existing.revision === 'number' && existing.revision >= 1 ? existing.revision : 1;
  await atomicWriteJson(filePath, {
    revision: rev,
    blueprint: snapshot,
    updatedAt: Date.now(),
  } satisfies PersistedBlueprintFile);
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

export type RoomHistoryAction = 'publish' | 'collab' | 'rollback';

export interface RoomHistoryMeta {
  version: number;
  ts: number;
  action: RoomHistoryAction;
  actor: string;
  summary: string;
}

export interface RoomHistoryEntry extends RoomHistoryMeta {
  blueprint: unknown;
}

export interface RoomBlueprintStore extends BlueprintStore {
  recordHistory: (
    action: RoomHistoryAction,
    opts?: { actor?: string; summary?: string; blueprint?: unknown }
  ) => Promise<RoomHistoryMeta | null>;
  listHistory: () => Promise<RoomHistoryMeta[]>;
  rollbackToVersion: (
    version: number,
    actor?: string
  ) => Promise<{ ok: boolean; revision: number; blueprint: unknown; entry?: RoomHistoryMeta; error?: string }>;
}

const MAX_HISTORY_ENTRIES = 50;

function createSingleFileBlueprintStore(filePath: string): RoomBlueprintStore {
  const historyPath = filePath.replace(/\.json$/i, '.history.json');
  let loaded = false;
  let revision = 1;
  let blueprint: unknown = null;
  let historyLoaded = false;
  let historyEntries: RoomHistoryEntry[] = [];
  let lastBlueprintJson = '';
  let writeChain: Promise<void> = Promise.resolve();

  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    const saved = await safeReadJson<Partial<PersistedBlueprintFile>>(filePath);
    if (saved && typeof saved === 'object') {
      const r = Number(saved.revision);
      if (Number.isFinite(r) && r >= 1) revision = Math.trunc(r);
      if (saved.blueprint !== undefined) {
        blueprint = saved.blueprint;
        try {
          lastBlueprintJson = JSON.stringify(blueprint);
        } catch {
          lastBlueprintJson = '';
        }
      }
    }
  };

  const ensureHistoryLoaded = async (): Promise<void> => {
    if (historyLoaded) return;
    historyLoaded = true;
    const saved = await safeReadJson<RoomHistoryEntry[]>(historyPath);
    if (Array.isArray(saved)) {
      historyEntries = saved.filter(
        (e) => e && typeof e === 'object' && typeof e.version === 'number' && typeof e.ts === 'number'
      );
      if (historyEntries.length > MAX_HISTORY_ENTRIES) {
        historyEntries = historyEntries.slice(-MAX_HISTORY_ENTRIES);
      }
    }
  };

  const enqueuePersistMain = (): Promise<void> => {
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

  const enqueuePersistHistory = (): Promise<void> => {
    const snap = historyEntries.slice(-MAX_HISTORY_ENTRIES);
    writeChain = writeChain
      .then(() => atomicWriteJson(historyPath, snap))
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
      await enqueuePersistMain();
    },
    async readBlueprint() {
      await ensureLoaded();
      return blueprint;
    },
    async writeBlueprint(bp: unknown) {
      await ensureLoaded();
      blueprint = bp;
      try {
        lastBlueprintJson = JSON.stringify(bp);
      } catch {
        lastBlueprintJson = '';
      }
      await enqueuePersistMain();
      return true;
    },
    async recordHistory(action, opts) {
      await ensureLoaded();
      await ensureHistoryLoaded();
      const targetBp = opts?.blueprint !== undefined ? opts.blueprint : blueprint;
      if (!targetBp || typeof targetBp !== 'object') return null;
      let serialized = '';
      try {
        serialized = JSON.stringify(targetBp);
      } catch {
        return null;
      }
      const latest = historyEntries[historyEntries.length - 1];
      if (action === 'collab' && latest) {
        try {
          if (JSON.stringify(latest.blueprint) === serialized) return null;
        } catch {
          // ignore
        }
      }
      const nextVersion = (latest?.version ?? 0) + 1;
      const entry: RoomHistoryEntry = {
        version: nextVersion,
        ts: Date.now(),
        action,
        actor: String(opts?.actor || 'system').slice(0, 80),
        summary: String(
          opts?.summary ||
            (action === 'publish' ? '发布蓝图' : action === 'rollback' ? '版本回档' : '协同变更')
        ).slice(0, 120),
        blueprint: JSON.parse(serialized),
      };
      historyEntries.push(entry);
      if (historyEntries.length > MAX_HISTORY_ENTRIES) {
        historyEntries = historyEntries.slice(-MAX_HISTORY_ENTRIES);
      }
      await enqueuePersistHistory();
      return {
        version: entry.version,
        ts: entry.ts,
        action: entry.action,
        actor: entry.actor,
        summary: entry.summary,
      };
    },
    async listHistory() {
      await ensureHistoryLoaded();
      return historyEntries
        .slice()
        .reverse()
        .map(({ version, ts, action, actor, summary }) => ({
          version,
          ts,
          action,
          actor,
          summary,
        }));
    },
    async rollbackToVersion(version, actor = 'admin') {
      await ensureLoaded();
      await ensureHistoryLoaded();
      const target = historyEntries.find((e) => e.version === version);
      if (!target) {
        return { ok: false, revision, blueprint, error: `未找到版本 v${version}` };
      }
      let cloned: unknown;
      try {
        cloned = JSON.parse(JSON.stringify(target.blueprint));
      } catch {
        cloned = target.blueprint;
      }
      blueprint = cloned;
      revision += 1;
      try {
        lastBlueprintJson = JSON.stringify(cloned);
      } catch {
        lastBlueprintJson = '';
      }
      await enqueuePersistMain();

      const latest = historyEntries[historyEntries.length - 1];
      const rollbackEntry: RoomHistoryEntry = {
        version: (latest?.version ?? 0) + 1,
        ts: Date.now(),
        action: 'rollback',
        actor: String(actor || 'admin').slice(0, 80),
        summary: `回档至 v${version}`,
        blueprint: JSON.parse(lastBlueprintJson || 'null'),
      };
      historyEntries.push(rollbackEntry);
      if (historyEntries.length > MAX_HISTORY_ENTRIES) {
        historyEntries = historyEntries.slice(-MAX_HISTORY_ENTRIES);
      }
      await enqueuePersistHistory();
      return {
        ok: true,
        revision,
        blueprint: cloned,
        entry: {
          version: rollbackEntry.version,
          ts: rollbackEntry.ts,
          action: rollbackEntry.action,
          actor: rollbackEntry.actor,
          summary: rollbackEntry.summary,
        },
      };
    },
  };
}

/**
 * 按房间路径隔离的统一房间存储注册表（有界 LRU 缓存，REST 与 WS 共用同一实例与同一串行写队列）：
 * - 主状态落盘到 `<dataDir>/rooms/<roomPathToFileKey>.json`；
 * - 修改日志与回档快照落盘到 `<dataDir>/rooms/<roomPathToFileKey>.history.json`。
 */
export function createRoomBlueprintStoreRegistry(
  dataDir: string,
  maxCachedStores = 100
): {
  getStore: (roomPath?: string | null) => RoomBlueprintStore;
  cachedCount: () => number;
} {
  const cap = Math.max(1, Math.floor(maxCachedStores));
  const stores = new Map<string, RoomBlueprintStore>();
  return {
    getStore(roomPath?: string | null): RoomBlueprintStore {
      const normalized = normalizeRoomPath(roomPath);
      const isDefault = normalized === DEFAULT_ROOM_PATH || normalized === 'default';
      const cacheKey = isDefault ? DEFAULT_ROOM_PATH : normalized;
      const existing = stores.get(cacheKey);
      if (existing) {
        stores.delete(cacheKey);
        stores.set(cacheKey, existing);
        return existing;
      }
      const targetFile = path.join(dataDir, 'rooms', `${roomPathToFileKey(cacheKey)}.json`);
      const created = createSingleFileBlueprintStore(targetFile);
      stores.set(cacheKey, created);
      while (stores.size > cap) {
        const oldest = stores.keys().next().value;
        if (oldest === undefined) break;
        stores.delete(oldest);
      }
      return created;
    },
    cachedCount(): number {
      return stores.size;
    },
  };
}

/** 列出已落盘的房间文件键（排除 .history.json）。 */
export async function listPersistedRooms(dataDir: string): Promise<string[]> {
  const keys = new Set<string>();
  try {
    const entries = await fs.readdir(path.join(dataDir, 'rooms'));
    for (const name of entries) {
      if (name.endsWith('.json') && !name.endsWith('.history.json')) {
        keys.add(name.slice(0, -5));
      }
    }
  } catch {
    // 目录尚未创建时忽略
  }
  return Array.from(keys).sort();
}
