import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomWebRtcMesh, shouldInitiateRtcOffer, type RtcSignalMessage } from '../src/core/webrtcMesh.ts';

class MockDataChannel {
  readyState: RTCDataChannelState = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  partner: MockDataChannel | null = null;

  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
  send(data: string): void {
    if (this.partner && this.partner.readyState === 'open') {
      this.partner.onmessage?.({ data });
    }
  }
  close(): void {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class MockPeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  onicecandidate: ((ev: { candidate: RTCIceCandidateInit | null }) => void) | null = null;
  ondatachannel: ((ev: { channel: MockDataChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  dc: MockDataChannel | null = null;

  createDataChannel(): MockDataChannel {
    this.dc = new MockDataChannel();
    return this.dc;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0 mock-offer' };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'v=0 mock-answer' };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  close(): void {
    this.connectionState = 'closed';
  }
}

test('shouldInitiateRtcOffer() elects deterministic initiator without glare', () => {
  assert.equal(shouldInitiateRtcOffer('cid-b', 'cid-a'), true);
  assert.equal(shouldInitiateRtcOffer('cid-a', 'cid-b'), false);
  assert.equal(shouldInitiateRtcOffer('cid-a', 'cid-a'), false);
});

test('RoomWebRtcMesh exchanges offer/answer over signaling and delivers P2P DataChannel payloads', async () => {
  const pcs: MockPeerConnection[] = [];
  const signals: RtcSignalMessage[] = [];
  const receivedByA: string[] = [];
  const receivedByB: string[] = [];

  const meshA = new RoomWebRtcMesh({
    selfCid: 'cid-a',
    sendSignal: (m) => signals.push(m),
    onDataMessage: (raw) => receivedByA.push(raw),
    peerConnectionFactory: () => {
      const pc = new MockPeerConnection();
      pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
  });

  const meshB = new RoomWebRtcMesh({
    selfCid: 'cid-b',
    sendSignal: (m) => signals.push(m),
    onDataMessage: (raw) => receivedByB.push(raw),
    peerConnectionFactory: () => {
      const pc = new MockPeerConnection();
      pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
  });

  // cid-a < cid-b, so cid-a does NOT initiate; cid-b initiates offer
  await meshA.handlePeerJoined('cid-b');
  assert.equal(signals.length, 0);

  await meshB.handlePeerJoined('cid-a');
  assert.equal(signals.length, 1);
  assert.equal(signals[0].t, 'rtc_offer');

  // Relay offer to A -> A replies with answer
  await meshA.handleSignal(signals[0]);
  assert.equal(signals.length, 2);
  assert.equal(signals[1].t, 'rtc_answer');

  // Relay answer to B
  await meshB.handleSignal(signals[1]);

  // Simulate DataChannel connection between B's created channel and A's ondatachannel
  const dcB = pcs[0].dc!;
  const dcA = new MockDataChannel();
  dcB.partner = dcA;
  dcA.partner = dcB;
  pcs[1].ondatachannel?.({ channel: dcA });
  dcB.open();
  dcA.open();

  assert.deepEqual(meshB.getOpenPeerCids(), ['cid-a']);
  assert.deepEqual(meshA.getOpenPeerCids(), ['cid-b']);

  assert.equal(meshB.broadcastRaw('{"t":"upsert_node","id":"n1"}'), 1);
  assert.deepEqual(receivedByA, ['{"t":"upsert_node","id":"n1"}']);

  meshA.closeAll();
  meshB.closeAll();
  assert.deepEqual(meshA.getOpenPeerCids(), []);
  assert.deepEqual(meshB.getOpenPeerCids(), []);
});
