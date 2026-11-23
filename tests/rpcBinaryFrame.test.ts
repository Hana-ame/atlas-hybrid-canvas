import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBinaryRpcFrame, encodeBinaryRpcFrame } from '../src/core/rpcBinaryFrame.ts';

test('encodeBinaryRpcFrame() & decodeBinaryRpcFrame() roundtrip header and raw binary payload with zero base64', () => {
  const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff]);
  const meta = {
    t: 'rpc_req',
    id: 'r1-abc',
    method: 'POST',
    path: '/api/pdf/unpack-upload',
    headers: { 'content-type': 'application/pdf' },
    bodyEncoding: 'binary',
  };
  const encoded = encodeBinaryRpcFrame(meta, pdfMagic);
  const decoded = decodeBinaryRpcFrame(encoded);
  assert.ok(decoded);
  assert.deepEqual(decoded.meta, meta);
  assert.deepEqual(Array.from(decoded.payload), Array.from(pdfMagic));
});

test('encodeBinaryRpcFrame() handles empty payload and decodeBinaryRpcFrame() rejects truncated/invalid frames', () => {
  const empty = encodeBinaryRpcFrame({ t: 'rpc_res', id: 'r2', status: 204 }, new Uint8Array(0));
  const decoded = decodeBinaryRpcFrame(empty);
  assert.ok(decoded);
  assert.equal(decoded.payload.byteLength, 0);

  assert.equal(decodeBinaryRpcFrame(new Uint8Array([0, 0, 1])), null);
  assert.equal(decodeBinaryRpcFrame(new Uint8Array([0, 0, 0, 99, 123])), null);
});
