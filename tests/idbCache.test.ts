import test from 'node:test';
import assert from 'node:assert/strict';
import {
  idbCacheClearPrefix,
  idbCacheDelete,
  idbCacheGet,
  idbCacheSet,
} from '../src/core/idbStorage.ts';

test('idbCacheSet / idbCacheGet / idbCacheDelete support roundtrip storage and deletion', async () => {
  const key = 'test-cache:item-1';
  assert.equal(await idbCacheSet(key, { hello: 'atlas' }, 10), true);
  assert.deepEqual(await idbCacheGet<{ hello: string }>(key), { hello: 'atlas' });
  await idbCacheDelete(key);
  assert.equal(await idbCacheGet(key), null);
});

test('idbCacheSet enforces LRU maxEntries cap and evicts least-recently-used key', async () => {
  await idbCacheClearPrefix('lru:');
  await idbCacheSet('lru:a', 1, 3);
  await idbCacheSet('lru:b', 2, 3);
  await idbCacheSet('lru:c', 3, 3);
  // 访问 lru:a 刷新其热度，此时最久未访问的是 lru:b
  assert.equal(await idbCacheGet<number>('lru:a'), 1);
  await idbCacheSet('lru:d', 4, 3);

  assert.equal(await idbCacheGet<number>('lru:b'), null);
  assert.equal(await idbCacheGet<number>('lru:a'), 1);
  assert.equal(await idbCacheGet<number>('lru:c'), 3);
  assert.equal(await idbCacheGet<number>('lru:d'), 4);
  await idbCacheClearPrefix('lru:');
});

test('idbCacheClearPrefix removes only keys matching the prefix', async () => {
  await idbCacheSet('pdf-page:doc1:1@1700', 'png1', 20);
  await idbCacheSet('pdf-page:doc1:2@1700', 'png2', 20);
  await idbCacheSet('pdf-page:doc2:1@1700', 'png3', 20);

  await idbCacheClearPrefix('pdf-page:doc1:');
  assert.equal(await idbCacheGet('pdf-page:doc1:1@1700'), null);
  assert.equal(await idbCacheGet('pdf-page:doc1:2@1700'), null);
  assert.equal(await idbCacheGet('pdf-page:doc2:1@1700'), 'png3');
  await idbCacheClearPrefix('pdf-page:doc2:');
});
