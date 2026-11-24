/**
 * @file webrtcMesh.ts
 * @description 房间内轻量级 WebRTC P2P DataChannel 网状传输层（复用现有 /ws/<roomPath> 做信令中继）：
 * - 确定性发起方裁决（selfCid > peerCid 发起 Offer），避免双端同时建连 glare；
 * - DataChannel 就绪后，高频 CRDT 增量帧可直接走 P2P 通道低延迟直达对端；
 * - 任一端处于严格 NAT/防火墙或无 RTCPeerConnection 环境时，自动静默回落至 WS 中继，不阻断协同。
 */

export type RtcSignalMessage =
  | { t: 'rtc_offer'; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { t: 'rtc_answer'; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { t: 'rtc_ice'; from: string; to: string; candidate: RTCIceCandidateInit };

export interface WebRtcMeshOptions {
  selfCid: string;
  sendSignal: (msg: RtcSignalMessage) => void;
  onDataMessage: (raw: string, fromPeerCid: string) => void;
  onPeersChange?: (openPeerCids: string[]) => void;
  iceServers?: RTCIceServer[];
  peerConnectionFactory?: (config: RTCConfiguration) => RTCPeerConnection;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/** 确定性发起方裁决：字典序大的 cid 主动创建 Offer，防止 glare。 */
export function shouldInitiateRtcOffer(selfCid: string, peerCid: string): boolean {
  return selfCid > peerCid;
}

export class RoomWebRtcMesh {
  private readonly peers = new Map<string, { pc: RTCPeerConnection; dc: RTCDataChannel | null }>();
  private readonly iceServers: RTCIceServer[];
  private readonly createPc: ((config: RTCConfiguration) => RTCPeerConnection) | null;

  constructor(private readonly opts: WebRtcMeshOptions) {
    this.iceServers = opts.iceServers ?? DEFAULT_ICE_SERVERS;
    if (opts.peerConnectionFactory) {
      this.createPc = opts.peerConnectionFactory;
    } else if (typeof RTCPeerConnection !== 'undefined') {
      this.createPc = (cfg) => new RTCPeerConnection(cfg);
    } else {
      this.createPc = null;
    }
  }

  get supported(): boolean {
    return this.createPc !== null;
  }

  getOpenPeerCids(): string[] {
    const out: string[] = [];
    for (const [cid, entry] of this.peers.entries()) {
      if (entry.dc && entry.dc.readyState === 'open') out.push(cid);
    }
    return out;
  }

  private emitPeersChange(): void {
    this.opts.onPeersChange?.(this.getOpenPeerCids());
  }

  private attachDataChannel(peerCid: string, dc: RTCDataChannel): void {
    const entry = this.peers.get(peerCid);
    if (!entry) return;
    entry.dc = dc;
    dc.onopen = () => this.emitPeersChange();
    dc.onclose = () => this.emitPeersChange();
    dc.onerror = () => this.emitPeersChange();
    dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.opts.onDataMessage(ev.data, peerCid);
      }
    };
  }

  private ensurePeer(peerCid: string): { pc: RTCPeerConnection; dc: RTCDataChannel | null } | null {
    if (!this.createPc || !peerCid || peerCid === this.opts.selfCid) return null;
    const existing = this.peers.get(peerCid);
    if (existing) return existing;

    const pc = this.createPc({ iceServers: this.iceServers });
    const entry = { pc, dc: null as RTCDataChannel | null };
    this.peers.set(peerCid, entry);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.opts.sendSignal({
          t: 'rtc_ice',
          from: this.opts.selfCid,
          to: peerCid,
          candidate: typeof ev.candidate.toJSON === 'function' ? ev.candidate.toJSON() : (ev.candidate as unknown as RTCIceCandidateInit),
        });
      }
    };

    pc.ondatachannel = (ev) => {
      this.attachDataChannel(peerCid, ev.channel);
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed' || st === 'disconnected') {
        this.removePeer(peerCid);
      }
    };

    return entry;
  }

  /** 当房间出现新成员时调用：仅由确定性发起方主动发 Offer。 */
  async handlePeerJoined(peerCid: string): Promise<void> {
    if (!this.createPc || !peerCid || peerCid === this.opts.selfCid) return;
    if (!shouldInitiateRtcOffer(this.opts.selfCid, peerCid)) return;
    const entry = this.ensurePeer(peerCid);
    if (!entry) return;
    try {
      const dc = entry.pc.createDataChannel('atlas-crdt', { ordered: true });
      this.attachDataChannel(peerCid, dc);
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      this.opts.sendSignal({
        t: 'rtc_offer',
        from: this.opts.selfCid,
        to: peerCid,
        sdp: offer,
      });
    } catch {
      this.removePeer(peerCid);
    }
  }

  /** 处理经由 WS 信令中继收到的 Offer / Answer / ICE 候选。 */
  async handleSignal(msg: RtcSignalMessage): Promise<void> {
    if (!this.createPc || msg.to !== this.opts.selfCid || !msg.from) return;
    const entry = this.ensurePeer(msg.from);
    if (!entry) return;
    try {
      if (msg.t === 'rtc_offer') {
        await entry.pc.setRemoteDescription(msg.sdp);
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        this.opts.sendSignal({
          t: 'rtc_answer',
          from: this.opts.selfCid,
          to: msg.from,
          sdp: answer,
        });
      } else if (msg.t === 'rtc_answer') {
        await entry.pc.setRemoteDescription(msg.sdp);
      } else if (msg.t === 'rtc_ice' && msg.candidate) {
        await entry.pc.addIceCandidate(msg.candidate);
      }
    } catch {
      // 信令乱序或 NAT 失败时静默降级至 WS 通道
    }
  }

  /** 向所有已建立 P2P DataChannel 的同房成员广播字符串帧，返回实际直发成功的 peer 数量。 */
  broadcastRaw(payload: string): number {
    let sent = 0;
    for (const entry of this.peers.values()) {
      if (entry.dc && entry.dc.readyState === 'open') {
        try {
          entry.dc.send(payload);
          sent += 1;
        } catch {
          // ignore
        }
      }
    }
    return sent;
  }

  removePeer(peerCid: string): void {
    const entry = this.peers.get(peerCid);
    if (!entry) return;
    this.peers.delete(peerCid);
    try {
      entry.dc?.close();
    } catch {
      /* ignore */
    }
    try {
      entry.pc.close();
    } catch {
      /* ignore */
    }
    this.emitPeersChange();
  }

  closeAll(): void {
    for (const cid of Array.from(this.peers.keys())) {
      this.removePeer(cid);
    }
  }
}
