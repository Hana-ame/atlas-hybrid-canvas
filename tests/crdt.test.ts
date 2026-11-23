import test from 'node:test';
import assert from 'node:assert/strict';
import { beats, computeRecordDiff, mergeRecordFieldsLWW } from '../src/core/crdt.ts';
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

test('mergeRecordFieldsLWW(): preserves concurrent non-overlapping field edits from two clients', () => {
  const base = {
    id: 'n1',
    rev: 1,
    cid: 'srv',
    title: '原标题',
    color: '#2563EB',
    fieldRevs: {
      title: { rev: 1, cid: 'srv' },
      color: { rev: 1, cid: 'srv' },
    },
  };
  const editA = {
    ...base,
    rev: 2,
    cid: 'client-a',
    title: 'A改的标题',
    fieldRevs: { ...base.fieldRevs, title: { rev: 2, cid: 'client-a' } },
  };
  const editB = {
    ...base,
    rev: 2,
    cid: 'client-b',
    color: '#DC2626',
    fieldRevs: { ...base.fieldRevs, color: { rev: 2, cid: 'client-b' } },
  };

  const step1 = mergeRecordFieldsLWW(base, editA);
  assert.equal(step1.changed, true);
  const step2 = mergeRecordFieldsLWW(step1.merged, editB);
  assert.equal(step2.changed, true);
  assert.equal(step2.merged.title, 'A改的标题');
  assert.equal(step2.merged.color, '#DC2626');
});
