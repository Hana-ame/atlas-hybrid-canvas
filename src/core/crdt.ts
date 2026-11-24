/**
 * 确定性 (rev, cid) LWW-Element-Set 冲突裁决、字段级合并（fieldRevs）与增量 Diff
 */
export interface FieldStamp {
  rev: number;
  cid: string;
}

export interface VersionedRecord {
  id: string;
  rev: number;
  cid: string;
  fieldRevs?: Record<string, FieldStamp>;
}

const META_FIELDS = new Set(['id', 'rev', 'cid', 'fieldRevs']);

export function beats(
  incoming: { rev: number; cid: string } | null | undefined,
  current: { rev: number; cid: string } | null | undefined
): boolean {
  if (!incoming) return false;
  if (!current) return true;
  const ar = Number(incoming.rev) || 0;
  const cr = Number(current.rev) || 0;
  if (ar !== cr) return ar > cr;
  return String(incoming.cid || '') > String(current.cid || '');
}

/**
 * 字段级 LWW 合并：
 * 当两位协作者并发修改同一张卡片的不同字段（如 A 改 title、B 改 color）时，
 * 按各字段的 fieldRevs (rev, cid) 独立裁决，保留双方不冲突的修改，不再整卡互相覆盖。
 */
export function mergeRecordFieldsLWW<T extends VersionedRecord>(
  current: T | undefined,
  incoming: T
): { merged: T; changed: boolean } {
  if (!current) {
    return { merged: incoming, changed: true };
  }

  const curRevs = current.fieldRevs;
  const incRevs = incoming.fieldRevs;

  // 若双方均未携带 fieldRevs，退回整条记录 LWW 裁决以保持向后兼容
  if (!curRevs && !incRevs) {
    if (beats(incoming, current)) {
      return { merged: incoming, changed: true };
    }
    return { merged: current, changed: false };
  }

  const nextObj: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  const nextFieldRevs: Record<string, FieldStamp> = { ...(curRevs ?? {}) };
  let changed = false;

  const allKeys = new Set<string>([
    ...Object.keys(current as Record<string, unknown>),
    ...Object.keys(incoming as Record<string, unknown>),
  ]);

  const curFallback: FieldStamp = { rev: Number(current.rev) || 0, cid: String(current.cid || '') };
  const incFallback: FieldStamp = { rev: Number(incoming.rev) || 0, cid: String(incoming.cid || '') };

  for (const key of allKeys) {
    if (META_FIELDS.has(key)) continue;
    const curVal = (current as Record<string, unknown>)[key];
    const incVal = (incoming as Record<string, unknown>)[key];
    const curStamp = curRevs?.[key] ?? curFallback;
    const incStamp = incRevs?.[key] ?? incFallback;

    const incExists = key in (incoming as Record<string, unknown>);
    const curExists = key in (current as Record<string, unknown>);

    if (incExists && !curExists) {
      const curKeyStamp = curRevs?.[key];
      if (!curKeyStamp || beats(incStamp, curKeyStamp)) {
        nextObj[key] = incVal;
        nextFieldRevs[key] = incStamp;
        changed = true;
      }
      continue;
    }

    if (!incExists && curExists) {
      if (beats(incFallback, curStamp)) {
        delete nextObj[key];
        nextFieldRevs[key] = incFallback;
        changed = true;
      }
      continue;
    }

    if (beats(incStamp, curStamp)) {
      if (JSON.stringify(curVal) !== JSON.stringify(incVal)) {
        nextObj[key] = incVal;
        changed = true;
      }
      if (!curRevs?.[key] || beats(incStamp, curRevs[key])) {
        nextFieldRevs[key] = incStamp;
      }
    } else if (!nextFieldRevs[key]) {
      nextFieldRevs[key] = curStamp;
    }
  }

  const winMeta = beats(incoming, current) ? incoming : current;
  const maxRev = Math.max(Number(current.rev) || 0, Number(incoming.rev) || 0);
  nextObj.id = current.id;
  nextObj.rev = maxRev;
  nextObj.cid = winMeta.cid;
  nextObj.fieldRevs = nextFieldRevs;

  return { merged: nextObj as T, changed };
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
      const nextFieldRevs: Record<string, FieldStamp> = { ...(prevEl?.fieldRevs ?? nextEl.fieldRevs ?? {}) };
      const prevRec = (prevEl ?? {}) as Record<string, unknown>;
      const nextRec = nextEl as Record<string, unknown>;
      const keys = new Set([...Object.keys(prevRec), ...Object.keys(nextRec)]);
      for (const k of keys) {
        if (META_FIELDS.has(k)) continue;
        if (!prevEl || JSON.stringify(prevRec[k]) !== JSON.stringify(nextRec[k])) {
          nextFieldRevs[k] = { rev: nextRev, cid: selfCid };
        }
      }
      upserts.push({
        ...nextEl,
        rev: nextRev,
        cid: selfCid,
        fieldRevs: nextFieldRevs,
      });
    }
  }

  return { upserts, deletes };
}
