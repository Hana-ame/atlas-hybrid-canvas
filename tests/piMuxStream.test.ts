import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseBuffer } from '../src/core/piMuxStream';

describe('piMuxStream SSE parser', () => {
  it('parses id, event, and data lines across chunk boundaries', () => {
    const events: Array<{ eventName: string; data: string; id: number | null }> = [];
    const chunk1 = ': connected\n\nid: 7\nevent: mux_event\ndata: {"room":"main","nodeId":"n1"';
    const r1 = parseSseBuffer(chunk1, 'message', (eventName, data, id) => {
      events.push({ eventName, data, id });
    });
    assert.equal(events.length, 0);
    assert.equal(r1.currentEvent, 'mux_event');

    const chunk2 = r1.remaining + ',"payload":{"type":"agent_settled"}}\n\n';
    const r2 = parseSseBuffer(chunk2, r1.currentEvent, (eventName, data, id) => {
      events.push({ eventName, data, id });
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventName, 'mux_event');
    assert.match(events[0].data, /agent_settled/);
    assert.equal(r2.remaining, '');
  });
});
