import test from 'node:test';
import assert from 'node:assert/strict';
import { beats, computeRecordDiff } from '../src/core/crdt.ts';
import { mergeRemoteBlueprintCRDT } from '../src/core/roomClient.ts';
import { createSeedBlueprint } from '../src/core/seedBlueprint.ts';

test('beats(): higher rev wins; equal rev breaks ties deterministically by cid', () => {
  assert.equal(beats({ id: '1', rev: 2, cid: 'a' }, { id: '1', rev: 1, cid: 'z' }), true);
  assert.equal(beats({ id: '1', rev: 1, cid: 'z' }, { id: '1', rev: 2, cid: 'a' }), false);
  assert.equal(beats({ id: '1', rev: 3, cid: 'client-b' }, { id: '1', rev: 3, cid: 'client-a' }), true);
  assert.equal(beats({ id: '1', rev: 3, cid: 'client-a' }, { id: '1', rev: 3, cid: 'client-b' }), false);
});

test('computeRecordDiff(): detects upserts with incremented rev and deletes', () => {
  const before = { a: { id: 'a', rev: 1, cid: 'c1' }, b: { id: 'b', rev: 2, cid: 'c1' } };
  const after = { a: { id: 'a', rev: 1, cid: 'c1' }, c: { id: 'c', rev: 1, cid: 'c2' } };
  const diff = computeRecordDiff(before, after, 'c2');
  assert.deepEqual(diff.deletes, ['b']);
  assert.equal(diff.upserts.length, 1);
  assert.equal(diff.upserts[0].id, 'c');
});

test('mergeRemoteBlueprintCRDT(): merges higher-rev remote node without clobbering newer local node', () => {
  const local = createSeedBlueprint();
  const remote = createSeedBlueprint();

  local.nodes['node-world-hub'].title = 'Local Newer';
  local.nodes['node-world-hub'].rev = 5;

  remote.nodes['node-world-hub'].title = 'Remote Stale';
  remote.nodes['node-world-hub'].rev = 2;

  remote.nodes['node-lore-north'].title = 'Remote Newer';
  remote.nodes['node-lore-north'].rev = 4;

  const merged = mergeRemoteBlueprintCRDT(local, remote);
  assert.equal(merged.nodes['node-world-hub'].title, 'Local Newer');
  assert.equal(merged.nodes['node-lore-north'].title, 'Remote Newer');
});
