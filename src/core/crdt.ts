/**
 * 确定性 (rev, cid) LWW-Element-Set 冲突裁决与增量 Diff
 * 与 room-go/store.go 中的 beatsRevCid 规则 100% 一致
 */
export interface VersionedRecord {
  id: string;
  rev: number;
  cid: string;
}

export function beats<T extends VersionedRecord>(incoming: T | null | undefined, current: T | null | undefined): boolean {
  if (!incoming) return false;
  if (!current) return true;
  const ar = Number(incoming.rev) || 0;
  const cr = Number(current.rev) || 0;
  if (ar !== cr) return ar > cr;
  return String(incoming.cid || '') > String(current.cid || '');
}

export function computeRecordDiff<T extends VersionedRecord>(
  before: Record<string, T>,
  after: Record<string, T>,
  selfCid: string
): { upserts: T[]; deletes: string[] } {
  const upserts: T[] = [];
  const deletes: string[] = [];

  for (const id of Object.keys(before)) {
    if (!(id in after)) deletes.push(id);
  }

  for (const id of Object.keys(after)) {
    const nextEl = after[id];
    const prevEl = before[id];
    if (!prevEl || JSON.stringify(prevEl) !== JSON.stringify(nextEl)) {
      const nextRev = Math.max(Number(prevEl?.rev) || 0, Number(nextEl?.rev) || 0) + 1;
      upserts.push({
        ...nextEl,
        rev: nextRev,
        cid: selfCid,
      });
    }
  }

  return { upserts, deletes };
}
