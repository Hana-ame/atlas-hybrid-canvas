import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpJsonRpcRequest } from '../server/mcpServer.ts';

test('MCP server handles initialize, tools/list, and tools/call (list_templates, inspect_room, apply_ops, rollback_room)', async () => {
  const calls: Array<{ url: string; method: string; key: string | null }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method || 'GET', key: headers.get('X-Agent-Api-Key') });
    if (url.endsWith('/agent/state')) {
      return new Response(JSON.stringify({ ok: true, room: 'team/mcp', revision: 3, summary: { nodeCount: 1 } }), { status: 200 });
    }
    if (url.endsWith('/ops')) {
      return new Response(JSON.stringify({ ok: true, revision: 4, results: [{ index: 0, op: 'create_widget', id: 'w-mcp' }] }), { status: 200 });
    }
    if (url.endsWith('/rollback')) {
      return new Response(JSON.stringify({ ok: true, revision: 5 }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  }) as typeof fetch;

  const cfg = {
    baseUrl: 'http://127.0.0.1:8787',
    apiKey: 'mcp-secret-key',
    defaultRoom: 'team/mcp',
    fetcher: fakeFetch,
  };

  const initResp = await handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, cfg);
  assert.equal((initResp?.result as any).serverInfo.name, 'atlas-hybrid-canvas-mcp');

  const notifResp = await handleMcpJsonRpcRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, cfg);
  assert.equal(notifResp, null);

  const listResp = await handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, cfg);
  const tools = (listResp?.result as any).tools as Array<{ name: string }>;
  assert.deepEqual(
    tools.map((t) => t.name),
    ['atlas_list_templates', 'atlas_inspect_room', 'atlas_apply_ops', 'atlas_rollback_room']
  );

  const tplResp = await handleMcpJsonRpcRequest(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'atlas_list_templates', arguments: {} } },
    cfg
  );
  const tplParsed = JSON.parse((tplResp?.result as any).content[0].text);
  assert.equal(tplParsed.ok, true);
  assert.ok(tplParsed.templates.length >= 20);

  const inspectResp = await handleMcpJsonRpcRequest(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'atlas_inspect_room', arguments: { room: 'team/mcp' } } },
    cfg
  );
  assert.equal((inspectResp?.result as any).isError, false);
  assert.equal(JSON.parse((inspectResp?.result as any).content[0].text).revision, 3);

  const opsResp = await handleMcpJsonRpcRequest(
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'atlas_apply_ops', arguments: { expectedRevision: 3, ops: [{ op: 'create_widget', title: 'From MCP' }] } },
    },
    cfg
  );
  assert.equal(JSON.parse((opsResp?.result as any).content[0].text).revision, 4);

  const rbResp = await handleMcpJsonRpcRequest(
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'atlas_rollback_room', arguments: { version: 1 } } },
    cfg
  );
  assert.equal(JSON.parse((rbResp?.result as any).content[0].text).revision, 5);
  assert.ok(calls.every((c) => c.key === 'mcp-secret-key'));
});
