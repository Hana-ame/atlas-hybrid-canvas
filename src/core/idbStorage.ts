/**
 * 零依赖异步 IndexedDB 键值存储与分级缓存封装（Structured Clone 原生对象存取，无 JSON 序列化阻塞）
 * - `kv` 表：持久业务数据（本地叠加层、自定义模板、离线蓝图底座）；
 * - `cache` 表：可淘汰冷缓存（PDF 离屏渲染页、深层撤销历史快照），内置条目上限与 LRU 淘汰，缓解浏览器 RAM 占用；
 * - 若浏览器隐私模式或测试环境无 indexedDB，自动降级为有界内存 Map。
 */

const DB_NAME = 'atlas-hybrid-canvas-db';
const DB_VERSION = 2;
const STORE_NAME = 'kv';
const CACHE_STORE_NAME = 'cache';
const DEFAULT_CACHE_MAX_ENTRIES = 120;

interface CacheRecord<T = unknown> {
  key: string;
  value: T;
  touchedAt: number;
}

const memoryFallback = new Map<string, unknown>();
const memoryCacheFallback = new Map<string, CacheRecord>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
        if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
          const cacheStore = db.createObjectStore(CACHE_STORE_NAME, { keyPath: 'key' });
          cacheStore.createIndex('by_touchedAt', 'touchedAt');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onclose = () => { dbPromise = null; };
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        resolve(null);
      };
    } catch {
      dbPromise = null;
      resolve(null);
    }
  });
  return dbPromise;
}

export async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDB();
  if (!db) {
    return (memoryFallback.get(key) as T | undefined) ?? null;
  }
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function idbSet<T>(key: string, value: T): Promise<boolean> {
  const db = await openDB();
  if (!db) {
    memoryFallback.set(key, value);
    return true;
  }
  return new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function idbDelete(key: string): Promise<void> {
  const db = await openDB();
  if (!db) {
    memoryFallback.delete(key);
    return;
  }
  return new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** 读取冷缓存条目（命中时刷新 LRU 访问时间）。 */
export async function idbCacheGet<T>(key: string): Promise<T | null> {
  const db = await openDB();
  if (!db) {
    const hit = memoryCacheFallback.get(key);
    if (!hit) return null;
    memoryCacheFallback.delete(key);
    hit.touchedAt = Date.now();
    memoryCacheFallback.set(key, hit);
    return hit.value as T;
  }
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(CACHE_STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        const rec = req.result as CacheRecord<T> | undefined;
        if (!rec) {
          resolve(null);
          return;
        }
        rec.touchedAt = Date.now();
        try {
          store.put(rec);
        } catch {
          // ignore touch update failure
        }
        resolve(rec.value);
      };
      req.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function resolveCacheNamespace(key: string, explicitPrefix?: string): string {
  if (explicitPrefix !== undefined) return explicitPrefix;
  const colonIdx = key.indexOf(':');
  return colonIdx > 0 ? key.slice(0, colonIdx + 1) : '';
}

function belongsToNamespace(key: string, ns: string): boolean {
  if (ns) return key.startsWith(ns);
  return !key.includes(':');
}

/**
 * 写入冷缓存条目，并按命名空间前缀（默认取首个 `:` 前缀，如 `pdf:`、`hist:`）独立执行 LRU 淘汰，
 * 防止不同子系统的冷缓存互相挤出（串味）。
 */
export async function idbCacheSet<T>(
  key: string,
  value: T,
  maxEntries = DEFAULT_CACHE_MAX_ENTRIES,
  namespacePrefix?: string
): Promise<boolean> {
  const cap = Math.max(1, Math.floor(maxEntries));
  const ns = resolveCacheNamespace(key, namespacePrefix);
  const now = Date.now();
  const db = await openDB();
  if (!db) {
    memoryCacheFallback.delete(key);
    memoryCacheFallback.set(key, { key, value, touchedAt: now });
    const scopedKeys: string[] = [];
    for (const k of memoryCacheFallback.keys()) {
      if (belongsToNamespace(k, ns)) scopedKeys.push(k);
    }
    let excess = scopedKeys.length - cap;
    for (const k of scopedKeys) {
      if (excess <= 0) break;
      memoryCacheFallback.delete(k);
      excess -= 1;
    }
    return true;
  }
  return new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(CACHE_STORE_NAME);
      store.put({ key, value, touchedAt: now } satisfies CacheRecord<T>);

      const idx = store.index('by_touchedAt');
      const matchedKeys: IDBValidKey[] = [];
      const scanReq = idx.openCursor();
      scanReq.onsuccess = () => {
        const cursor = scanReq.result;
        if (cursor) {
          const pk = String(cursor.primaryKey ?? '');
          if (belongsToNamespace(pk, ns)) matchedKeys.push(cursor.primaryKey);
          cursor.continue();
          return;
        }
        const excess = matchedKeys.length - cap;
        for (let i = 0; i < excess; i++) {
          store.delete(matchedKeys[i]);
        }
      };

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** 删除单条冷缓存记录。 */
export async function idbCacheDelete(key: string): Promise<void> {
  const db = await openDB();
  if (!db) {
    memoryCacheFallback.delete(key);
    return;
  }
  return new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
      tx.objectStore(CACHE_STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** 按键前缀批量清理冷缓存（例如销毁 PDF 文档或清理会话撤销溢出快照）。 */
export async function idbCacheClearPrefix(prefix: string): Promise<void> {
  if (!prefix) return;
  const db = await openDB();
  if (!db) {
    for (const k of Array.from(memoryCacheFallback.keys())) {
      if (k.startsWith(prefix)) memoryCacheFallback.delete(k);
    }
    return;
  }
  return new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(CACHE_STORE_NAME);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const k = String(cursor.primaryKey ?? '');
        if (k.startsWith(prefix)) {
          cursor.delete();
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
