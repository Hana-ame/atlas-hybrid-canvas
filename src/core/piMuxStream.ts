/**
 * @file piMuxStream.ts
 * @description Singleton multiplexed SSE client for `GET /pi/admin/events/stream`.
 *
 * Solves the browser HTTP/1.1 6-concurrent-connection limit: regardless of how many
 * `PiAgentBlock` cards are active on a Canvas, they share ONE multiplexed SSE connection
 * per `(baseUrl, adminKey)` pair, with automatic `?afterSeq=` reconnect and per-(room, nodeId) routing.
 */

export interface PiMuxEnvelope {
  room: string;
  nodeId: string;
  seq: number;
  eventName: string;
  payload: Record<string, unknown>;
}

export type PiMuxListener = (envelope: PiMuxEnvelope) => void;

interface ChannelState {
  key: string;
  baseUrl: string;
  adminKey: string;
  lastSeq: number;
  abortController: AbortController | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connecting: boolean;
  /** Map of `${room}::${nodeId}` -> Set<PiMuxListener> */
  subscribers: Map<string, Set<PiMuxListener>>;
}

const channels = new Map<string, ChannelState>();

function makeTargetKey(room: string, nodeId: string): string {
  return `${room}::${nodeId}`;
}

function makeChannelKey(baseUrl: string, adminKey: string): string {
  return `${baseUrl.replace(/\/+$/, '')}::${adminKey}`;
}

/**
 * Pure SSE chunk parser helper (LF-delimited SSE records) exported for unit testing.
 */
export function parseSseBuffer(
  buffer: string,
  currentEvent: string,
  onEvent: (eventName: string, data: string, id: number | null) => void
): { remaining: string; currentEvent: string } {
  let buf = buffer;
  let evName = currentEvent;
  let pendingId: number | null = null;
  let idx: number;

  while ((idx = buf.indexOf('\n')) !== -1) {
    const rawLine = buf.slice(0, idx).replace(/\r$/, '');
    buf = buf.slice(idx + 1);
    if (!rawLine) {
      evName = 'message';
      pendingId = null;
      continue;
    }
    if (rawLine.startsWith(':')) continue;
    if (rawLine.startsWith('id:')) {
      const n = Number(rawLine.slice(3).trim());
      if (Number.isFinite(n) && n >= 0) pendingId = Math.floor(n);
    } else if (rawLine.startsWith('event:')) {
      evName = rawLine.slice(6).trim();
    } else if (rawLine.startsWith('data:')) {
      onEvent(evName, rawLine.slice(5).trim(), pendingId);
    }
  }

  return { remaining: buf, currentEvent: evName };
}

function countTotalSubscribers(ch: ChannelState): number {
  let total = 0;
  for (const set of ch.subscribers.values()) total += set.size;
  return total;
}

function scheduleReconnect(ch: ChannelState, delayMs = 2000): void {
  if (ch.reconnectTimer || countTotalSubscribers(ch) === 0) return;
  ch.reconnectTimer = setTimeout(() => {
    ch.reconnectTimer = null;
    if (countTotalSubscribers(ch) > 0) {
      void startChannelLoop(ch);
    }
  }, delayMs);
}

async function startChannelLoop(ch: ChannelState): Promise<void> {
  if (ch.connecting || countTotalSubscribers(ch) === 0) return;
  ch.connecting = true;
  const ac = new AbortController();
  ch.abortController = ac;

  try {
    const prefix = ch.baseUrl.replace(/\/+$/, '');
    const url = `${prefix}/pi/admin/events/stream?afterSeq=${ch.lastSeq}`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Pi-Admin-Key': ch.adminKey,
        'Last-Event-ID': String(ch.lastSeq),
      },
      signal: ac.signal,
    });
    if (!resp.ok || !resp.body) {
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let currentEvent = 'message';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBuffer(buffer, currentEvent, (eventName, dataStr, id) => {
        if (id !== null && id > ch.lastSeq) ch.lastSeq = id;
        if (eventName !== 'mux_event') return;
        try {
          const env = JSON.parse(dataStr) as PiMuxEnvelope;
          if (!env || typeof env.room !== 'string' || typeof env.nodeId !== 'string') return;
          const targetListeners = ch.subscribers.get(makeTargetKey(env.room, env.nodeId));
          if (!targetListeners) return;
          for (const fn of Array.from(targetListeners)) {
            try {
              fn(env);
            } catch {
              // isolate individual card listener errors
            }
          }
        } catch {
          // ignore malformed payload
        }
      });
      buffer = parsed.remaining;
      currentEvent = parsed.currentEvent;
    }
  } catch {
    // aborted or transient network disconnect
  } finally {
    if (ch.abortController === ac) {
      ch.abortController = null;
    }
    ch.connecting = false;
    if (countTotalSubscribers(ch) > 0 && !ac.signal.aborted) {
      scheduleReconnect(ch, 2000);
    }
  }
}

/**
 * Subscribes a `PiAgentBlock` card to the shared multiplexed SSE stream.
 * Returns an unsubscribe function that tears down the shared connection once the last card unsubscribes.
 */
export function subscribePiMux(
  baseUrl: string,
  adminKey: string,
  room: string,
  nodeId: string,
  listener: PiMuxListener
): () => void {
  const trimmedKey = adminKey.trim();
  if (!trimmedKey) return () => {};

  const chKey = makeChannelKey(baseUrl, trimmedKey);
  let ch = channels.get(chKey);
  if (!ch) {
    ch = {
      key: chKey,
      baseUrl,
      adminKey: trimmedKey,
      lastSeq: 0,
      abortController: null,
      reconnectTimer: null,
      connecting: false,
      subscribers: new Map(),
    };
    channels.set(chKey, ch);
  }

  const tKey = makeTargetKey(room, nodeId);
  let set = ch.subscribers.get(tKey);
  if (!set) {
    set = new Set();
    ch.subscribers.set(tKey, set);
  }
  set.add(listener);

  if (!ch.connecting && !ch.abortController) {
    void startChannelLoop(ch);
  }

  return () => {
    const existing = channels.get(chKey);
    if (!existing) return;
    const targetSet = existing.subscribers.get(tKey);
    if (targetSet) {
      targetSet.delete(listener);
      if (targetSet.size === 0) existing.subscribers.delete(tKey);
    }
    if (countTotalSubscribers(existing) === 0) {
      if (existing.reconnectTimer) {
        clearTimeout(existing.reconnectTimer);
        existing.reconnectTimer = null;
      }
      existing.abortController?.abort();
      existing.abortController = null;
      channels.delete(chKey);
    }
  };
}
