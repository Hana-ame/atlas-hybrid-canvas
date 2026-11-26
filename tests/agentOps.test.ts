import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAgentOperations, getAgentToolSchema, listAgentTemplates, summarizeBlueprintForAgent } from '../src/core/agentOps.ts';

test('applyAgentOperations() creates widgets, background annotations, updates vars, connects edges, and cleans dangling edges on delete', () => {
  const res = applyAgentOperations(null, [
    {
      op: 'create_annotation',
      id: 'bg-zone-1',
      kind: 'text',
      text: 'Agent 自动创建的看板背景区',
      bgColor: '#DBEAFE',
      bgOpacity: 0.5,
      x: 40,
      y: 40,
      width: 820,
      height: 460,
    },
    {
      op: 'create_widget',
      id: 'w-sensor',
      title: '温度传感器',
      body: '采集实时温度',
      defaultVars: { temperature: 25, unit: 'C' },
    },
    {
      op: 'create_widget',
      id: 'w-alert',
      title: '告警面板',
      defaultVars: { status: 'ok' },
    },
    {
      op: 'update_widget',
      id: 'w-sensor',
      defaultVars: { temperature: 88 },
    },
    {
      op: 'connect_edge',
      id: 'e-1',
      source: 'w-sensor',
      target: 'w-alert',
      bidirectional: true,
      label: '实时联动',
    },
  ], { actor: 'planner-agent' });

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.results.length, 5);
  assert.equal(res.blueprint.annotations['bg-zone-1'].text, 'Agent 自动创建的看板背景区');
  assert.equal(res.blueprint.nodes['w-sensor'].defaultVars.temperature, 88);
  assert.equal(res.blueprint.nodes['w-sensor'].defaultVars.unit, 'C', 'mergeVars defaults to true');
  assert.equal(res.blueprint.nodes['w-sensor'].rev, 2);
  assert.equal(res.blueprint.edges['e-1'].bidirectional, true);
  const a = res.blueprint.nodes['w-sensor'];
  const b = res.blueprint.nodes['w-alert'];
  const overlapX = a.x < b.x + b.width && a.x + a.width > b.x;
  const overlapY = a.y < b.y + b.height && a.y + a.height > b.y;
  assert.equal(overlapX && overlapY, false, 'auto-placed widgets must not overlap');

  const delRes = applyAgentOperations(res.blueprint, [{ op: 'delete_widget', id: 'w-sensor' }]);
  assert.equal(delRes.ok, true);
  if (!delRes.ok) return;
  assert.equal(delRes.blueprint.nodes['w-sensor'], undefined);
  assert.equal(delRes.blueprint.edges['e-1'], undefined);
});

test('applyAgentOperations() rejects unsafe scripts, unsafe imageUrl, and rolls back atomically on error', () => {
  const badScript = applyAgentOperations(null, [
    { op: 'create_widget', title: 'Valid First' },
    { op: 'create_widget', title: 'Evil', script: 'fetch("https://evil.example")' },
  ]);
  assert.equal(badScript.ok, false);
  if (!badScript.ok) assert.equal(badScript.failedIndex, 1);

  const badImg = applyAgentOperations(null, [
    { op: 'create_annotation', kind: 'image', imageUrl: 'javascript:alert(1)' },
  ]);
  assert.equal(badImg.ok, false);

  const schema = getAgentToolSchema();
  const opsTool = schema.find((t) => t.name === 'atlas_canvas_ops');
  assert.ok(opsTool, 'atlas_canvas_ops tool must exist');
  assert.ok(schema.some((t) => t.name === 'atlas_inspect_room'), 'atlas_inspect_room tool must exist');
  assert.ok((opsTool as any).parameters.properties.ops.items.properties.op.enum.includes('create_annotation'));
});

test('applyAgentOperations() supports create_from_template (widget & annotation), structured blocks, and summarizeBlueprintForAgent()', () => {
  const templates = listAgentTemplates();
  assert.ok(templates.length >= 20, 'should expose all built-in templates');
  assert.ok(templates.some((t) => t.id === 'tpl-slider-node'));
  assert.ok(templates.some((t) => t.id === 'tpl-ann-textbox'));

  const res = applyAgentOperations(null, [
    {
      op: 'create_from_template',
      templateId: 'tpl-slider-node',
      id: 'w-slider-1',
      title: '亮度调节',
      defaultVars: { brightness: 75 },
    },
    {
      op: 'create_from_template',
      templateId: 'tpl-ann-textbox',
      id: 'bg-note-1',
      text: '模板创建的背景分区',
      x: 10,
      y: 10,
    },
    {
      op: 'create_widget',
      id: 'w-blocks',
      title: '结构化积木卡片',
      blocks: [
        { type: 'text', text: '无需手写脚本的文本块', bold: true },
        { type: 'slider', id: 's1', bind: 'level', min: 0, max: 100, value: 60 },
      ],
    },
  ], { actor: 'template-agent' });

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.blueprint.nodes['w-slider-1'].title, '亮度调节');
  assert.equal(res.blueprint.nodes['w-slider-1'].defaultVars.brightness, 75);
  assert.equal(res.blueprint.annotations['bg-note-1'].text, '模板创建的背景分区');
  assert.ok(Array.isArray(res.blueprint.nodes['w-blocks'].defaultVars.contents));
  assert.equal((res.blueprint.nodes['w-blocks'].defaultVars.contents as any[]).length, 2);

  const summary = summarizeBlueprintForAgent(res.blueprint);
  assert.equal(summary.nodeCount, 2);
  assert.equal(summary.annotationCount, 1);
  assert.equal(summary.edgeCount, 0);
  assert.ok(summary.nodes.some((n) => n.id === 'w-slider-1' && n.varKeys.includes('brightness')));

  const unknownTpl = applyAgentOperations(res.blueprint, [
    { op: 'create_from_template', templateId: 'tpl-does-not-exist' },
  ]);
  assert.equal(unknownTpl.ok, false);
});

test('applyAgentOperations() rejects unsafe URLs inside structured blocks (image/video/pdf/image_button)', () => {
  const badImgBlock = applyAgentOperations(null, [
    {
      op: 'create_widget',
      title: 'Bad Image Block',
      blocks: [{ type: 'image', id: 'img-1', url: 'javascript:alert(1)' }],
    },
  ]);
  assert.equal(badImgBlock.ok, false);

  const badVideoBlock = applyAgentOperations(null, [
    {
      op: 'create_widget',
      title: 'Bad Video Block',
      blocks: [{ type: 'video', id: 'vid-1', url: 'blob:https://example.com/123' }],
    },
  ]);
  assert.equal(badVideoBlock.ok, false);

  const badPdfBlock = applyAgentOperations(null, [
    {
      op: 'create_widget',
      title: 'Bad PDF Block',
      blocks: [{ type: 'pdf', id: 'pdf-1', url: 'javascript:alert(1)' }],
    },
  ]);
  assert.equal(badPdfBlock.ok, false);
});

test('agentOps exposes controlPoints in schema, summary, and normalizes empty [] to undefined', () => {
  const schema = getAgentToolSchema();
  const opsTool = schema.find((t) => t.name === 'atlas_canvas_ops') as any;
  assert.ok(opsTool.parameters.properties.ops.items.properties.controlPoints, 'schema must declare controlPoints');

  const res = applyAgentOperations(null, [
    { op: 'create_widget', id: 'a', title: 'A' },
    { op: 'create_widget', id: 'b', title: 'B' },
    { op: 'connect_edge', id: 'e-cp', source: 'a', target: 'b', controlPoints: [{ x: 200, y: 50 }] },
    { op: 'connect_edge', id: 'e-empty', source: 'b', target: 'a', controlPoints: [] },
  ]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.blueprint.edges['e-empty'].controlPoints, undefined, 'empty controlPoints [] must normalize to undefined');

  const summary = summarizeBlueprintForAgent(res.blueprint);
  const eCp = summary.edges.find((e) => e.id === 'e-cp');
  assert.deepEqual(eCp?.controlPoints, [{ x: 200, y: 50 }]);
});

test('summarizeBlueprintForAgent() omits dirty NaN controlPoints instead of emitting []', () => {
  const dirtyBp = {
    version: 1,
    chunkSize: 512,
    nodes: {},
    annotations: {},
    edges: {
      'e-dirty': { id: 'e-dirty', source: 'a', target: 'b', controlPoints: [{ x: Number.NaN, y: 0 }], rev: 1, cid: 'x' },
    },
  };
  const summary = summarizeBlueprintForAgent(dirtyBp);
  assert.equal('controlPoints' in summary.edges[0], false);
});
