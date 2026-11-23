/**
 * @file rpcBinaryFrame.ts
 * @description 浏览器与 Node 共用的原生二进制 WebSocket RPC 帧编解码器：
 * 格式：[4 字节 uint32 BE headerLength][UTF-8 JSON meta][原始二进制负载]
 * 彻底消除 50MB PDF 等二进制体经 WS RPC 传输时的 33% Base64 膨胀与编解码拷贝。
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeBinaryRpcFrame(
  meta: Record<string, unknown>,
  payload: Uint8Array
): Uint8Array {
  const headerBytes = textEncoder.encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + headerBytes.byteLength + payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, headerBytes.byteLength, false);
  out.set(headerBytes, 4);
  if (payload.byteLength > 0) {
    out.set(payload, 4 + headerBytes.byteLength);
  }
  return out;
}

export function decodeBinaryRpcFrame(
  raw: ArrayBuffer | Uint8Array
): { meta: Record<string, unknown>; payload: Uint8Array } | null {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(0, false);
  if (headerLen === 0 || 4 + headerLen > bytes.byteLength) return null;
  try {
    const headerStr = textDecoder.decode(bytes.subarray(4, 4 + headerLen));
    const meta = JSON.parse(headerStr) as Record<string, unknown>;
    if (!meta || typeof meta !== 'object') return null;
    return {
      meta,
      payload: bytes.subarray(4 + headerLen),
    };
  } catch {
    return null;
  }
}
