/**
 * @file mcpServer.ts
 * @description 零外部依赖的 Atlas Hybrid Canvas MCP（Model Context Protocol）stdio 服务端。
 *
 * 兼容 Claude Desktop / Cursor / Gemini CLI 等标准 MCP 客户端（JSON-RPC 2.0 over stdio）。
 * 环境变量：
 * - ATLAS_BASE_URL：后端地址（默认 http://127.0.0.1:8787）
 * - AGENT_API_KEY：鉴权密钥（也可设 BLUEPRINT_SAVE_KEY）
 * - ATLAS_DEFAULT_ROOM：默认房间路径（默认 atlas-main）
 *
 * 暴露 4 个 MCP 工具：
 * 1. atlas_list_templates  — 列出 22 套内置控件与背景模板
 * 2. atlas_inspect_room    — 读取指定房间实时状态摘要与 revision
 * 3. atlas_apply_ops       — 原子批量创建/修改/删除控件、背景与连线（支持 expectedRevision & dryRun）
 * 4. atlas_rollback_room   — 一键回档到历史版本
 */

import readline from 'node:readline';
import { getAgentToolSchema, listAgentTemplates } from '../src/core/agentOps';
import { DEFAULT_ROOM_PATH, encodeRoomPathForUrl, normalizeRoomPath } from '../src/core/roomPath';

export interface McpRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  defaultRoom: string;
  fetcher?: typeof fetch;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const MCP_PROTOCOL_VERSION = '2024-11-05';

export function getMcpToolsDefinition() {
  const baseTools = getAgentToolSchema();
  return [
    {
      name: 'atlas_list_templates',
      description: '列出 Atlas Hybrid Canvas 内置的全部控件与背景模板（含 templateId、分类与说明），供 create_from_template 使用。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'atlas_inspect_room',
      description: baseTools[0].description,
      inputSchema: baseTools[0].parameters,
    },
    {
      name: 'atlas_apply_ops',
      description: baseTools[1].description,
      inputSchema: baseTools[1].parameters,
    },
    {
      name: 'atlas_rollback_room',
      description: '将指定房间一键回档到历史版本号（由 historyVersion 或历史接口提供），同步广播给全部在线协作者。',
      inputSchema: {
        type: 'object',
        required: ['version'],
        properties: {
          room: { type: 'string', description: '房间路径，默认使用 ATLAS_DEFAULT_ROOM' },
          version: { type: 'number', description: '目标历史版本号（正整数）' },
        },
      },
    },
  ];
}

function asToolTextResult(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

export async function handleMcpJsonRpcRequest(
  req: JsonRpcRequest,
  cfg: McpRuntimeConfig
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const doFetch = cfg.fetcher ?? fetch;
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');

  // JSON-RPC notifications have no id and expect no response
  if (req.method === 'notifications/initialized' || req.method === 'notifications/cancelled') {
    return null;
  }

  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'atlas-hybrid-canvas-mcp', version: '0.88.0' },
      },
    };
  }

  if (req.method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (req.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: getMcpToolsDefinition() },
    };
  }

  if (req.method === 'tools/call') {
    const params = (req.params || {}) as { name?: string; arguments?: Record<string, unknown> };
    const toolName = String(params.name || '');
    const args = (params.arguments || {}) as Record<string, unknown>;

    try {
      if (toolName === 'atlas_list_templates') {
        return {
          jsonrpc: '2.0',
          id,
          result: asToolTextResult({ ok: true, templates: listAgentTemplates() }),
        };
      }

      if (toolName === 'atlas_inspect_room') {
        const room = normalizeRoomPath(typeof args.room === 'string' ? args.room : cfg.defaultRoom);
        const encoded = encodeRoomPathForUrl(room);
        const query = args.full === true ? '?full=1' : '';
        const resp = await doFetch(`${baseUrl}/api/rooms/${encoded}/agent/state${query}`, {
          method: 'GET',
          headers: { 'X-Agent-Api-Key': cfg.apiKey },
        });
        const data = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
        return {
          jsonrpc: '2.0',
          id,
          result: asToolTextResult(data, !resp.ok),
        };
      }

      if (toolName === 'atlas_apply_ops') {
        const room = normalizeRoomPath(typeof args.room === 'string' ? args.room : cfg.defaultRoom);
        const encoded = encodeRoomPathForUrl(room);
        const resp = await doFetch(`${baseUrl}/api/rooms/${encoded}/ops`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Agent-Api-Key': cfg.apiKey,
          },
          body: JSON.stringify({
            actor: args.actor ?? 'mcp-agent',
            summary: args.summary,
            expectedRevision: args.expectedRevision,
            dryRun: args.dryRun,
            ops: args.ops,
          }),
        });
        const data = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
        return {
          jsonrpc: '2.0',
          id,
          result: asToolTextResult(data, !resp.ok),
        };
      }

      if (toolName === 'atlas_rollback_room') {
        const room = normalizeRoomPath(typeof args.room === 'string' ? args.room : cfg.defaultRoom);
        const encoded = encodeRoomPathForUrl(room);
        const resp = await doFetch(`${baseUrl}/api/rooms/${encoded}/rollback`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Agent-Api-Key': cfg.apiKey,
            'X-Blueprint-Save-Key': cfg.apiKey,
          },
          body: JSON.stringify({ version: Number(args.version) }),
        });
        const data = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
        return {
          jsonrpc: '2.0',
          id,
          result: asToolTextResult(data, !resp.ok),
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: asToolTextResult(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          true
        ),
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${req.method}` },
  };
}

function isMainEntry(): boolean {
  const entry = process.argv[1] || '';
  return entry.endsWith('mcpServer.ts') || entry.endsWith('mcp-server.mjs');
}

if (isMainEntry()) {
  const cfg: McpRuntimeConfig = {
    baseUrl: (process.env.ATLAS_BASE_URL || 'http://127.0.0.1:8787').trim(),
    apiKey: (process.env.AGENT_API_KEY || process.env.BLUEPRINT_SAVE_KEY || '').trim(),
    defaultRoom: normalizeRoomPath(process.env.ATLAS_DEFAULT_ROOM || DEFAULT_ROOM_PATH),
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as JsonRpcRequest;
      const resp = await handleMcpJsonRpcRequest(parsed, cfg);
      if (resp) {
        process.stdout.write(`${JSON.stringify(resp)}\n`);
      }
    } catch (err) {
      const errResp: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `Parse error: ${err instanceof Error ? err.message : String(err)}` },
      };
      process.stdout.write(`${JSON.stringify(errResp)}\n`);
    }
  });
}
