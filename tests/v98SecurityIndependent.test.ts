/**
 * @file v98SecurityIndependent.test.ts
 * @description v98 安全/并发修复的独立测试（不复用上游 tests/*.test.ts 的断言口径）。
 *
 * 覆盖四条与上游不同的验证路径：
 * 1. 动态 import() 拦截用「词边界」而非子串，重点反证 important / importance 不误伤；
 * 2. agentOps 除 create_widget 外，update_widget 路径也必须校验 contents 与 buttons；
 * 3. CRDT minBaseRevById 同时抬高顶层 rev 与变更字段 fieldRevs，且不得反向降低 rev；
 * 4. fileStore 冷启动并发水合后，随后写入的新蓝图不会被迟到的磁盘水合覆盖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateScriptSafety } from '../src/core/scriptSandbox.ts';
import { applyAgentOperations } from '../src/core/agentOps.ts';
import { computeRecordDiff } from '../src/core/crdt.ts';
import { createSeedBlueprint } from '../src/core/seedBlueprint.ts';
import { createRoomBlueprintStoreRegistry } from '../server/fileStore.ts';

test('独立A：动态 import() 被词边界拦截，important/importance 不误伤', () => {
  const dynamic = validateScriptSafety('const m = await import("https://evil.test/payload.js");');
  assert.equal(dynamic.ok, false, '动态 import() 必须被静态拦截');
  assert.match(String(dynamic.reason), /import/, '拦截原因应指明 import token');

  // 反证：若实现改成 includes("import") 子串，这两条会被误伤
  assert.equal(validateScriptSafety('vars.title = "important notice";').ok, true);
  assert.equal(validateScriptSafety('const importance = 2; vars.n = importance;').ok, true);

  // import.meta 也属于动态模块能力，应一并拦截
  assert.equal(validateScriptSafety('vars.url = import.meta.url;').ok, false);

  // 原有 token 未被这次改动挤掉
  assert.equal(validateScriptSafety('await fetch("https://evil.test")').ok, false);
});

test('独立B：update_widget 路径同样拒绝不安全 contents 与按钮脚本', () => {
  const seed = createSeedBlueprint();
  const nodeId = 'node-lore-north';
  assert.ok(seed.nodes[nodeId], '种子应包含被测节点');

  const badContents = applyAgentOperations(seed, [
    {
      op: 'update_widget',
      id: nodeId,
      defaultVars: { contents: [{ type: 'image', url: 'javascript:alert(1)' }] },
    },
  ]);
  assert.equal(badContents.ok, false, 'update_widget 的 defaultVars.contents 必须校验');
  assert.match(String((badContents as { error?: string }).error), /contents|image|javascript/i);

  const badButtons = applyAgentOperations(seed, [
    {
      op: 'update_widget',
      id: nodeId,
      buttons: [{ id: 'b1', label: 'Run', actionType: 'script', code: 'await fetch("https://evil.test")' }],
    },
  ]);
  assert.equal(badButtons.ok, false, 'update_widget 的 buttons[].code 必须校验');
  assert.match(String((badButtons as { error?: string }).error), /按钮脚本/);

  // 非恒真：合法更新仍应成功
  const good = applyAgentOperations(seed, [{ op: 'update_widget', id: nodeId, title: '独立测试改名' }]);
  assert.equal(good.ok, true, `合法 update_widget 不应被拦截：${JSON.stringify(good).slice(0, 160)}`);
});

test('独立C：minBaseRevById 抬高顶层 rev 与字段戳，且不会反向降低', () => {
  const before = { n1: { id: 'n1', rev: 3, cid: 'peer', title: 'old' } };
  const after = { n1: { id: 'n1', rev: 3, cid: 'peer', title: 'new' } };

  const raised = computeRecordDiff(before, after, 'self', () => 100);
  assert.equal(raised.upserts.length, 1);
  assert.equal(raised.upserts[0].rev, 101, '顶层 rev 应取 max(3,3,100)+1');
  assert.equal(raised.upserts[0].fieldRevs?.title.rev, 101, '变更字段戳必须与顶层 rev 同步');
  assert.equal(raised.upserts[0].fieldRevs?.title.cid, 'self');

  const lowered = computeRecordDiff(before, after, 'self', () => 1);
  assert.equal(lowered.upserts[0].rev, 4, '外部下限低于本地 rev 时不得降低');

  const unchanged = computeRecordDiff(after, after, 'self', () => 999);
  assert.equal(unchanged.upserts.length, 0, '未变更记录不应因外部下限而广播');
});

test('独立D：fileStore 冷启动并发读取后，新写入不会被迟到水合覆盖', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-v98-independent-'));
  try {
    const initial = { version: 1, chunkSize: 512, nodes: { a: { id: 'a' } }, annotations: {}, edges: {} };
    const writer = createRoomBlueprintStoreRegistry(tmpDir).getStore('race-room');
    await writer.writeBlueprint(initial);
    await writer.writeRevision(3);

    // 新 registry 首次访问触发磁盘水合；并发读取必须共享同一次 in-flight Promise
    const reader = createRoomBlueprintStoreRegistry(tmpDir).getStore('race-room');
    const cold = await Promise.all([reader.readBlueprint(), reader.readBlueprint(), reader.readBlueprint(), reader.readRevision()]);
    assert.deepEqual(cold[0], initial);
    assert.deepEqual(cold[1], initial);
    assert.deepEqual(cold[2], initial);
    assert.equal(cold[3], 3);

    const replacement = { version: 2, chunkSize: 512, nodes: { b: { id: 'b' } }, annotations: {}, edges: {} };
    await reader.writeBlueprint(replacement);
    await reader.writeRevision(9);

    const recheck = createRoomBlueprintStoreRegistry(tmpDir).getStore('race-room');
    assert.deepEqual(await recheck.readBlueprint(), replacement, '后写入的蓝图不得被冷启动水合回退');
    assert.equal(await recheck.readRevision(), 9, '后写入的 revision 不得丢失');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
