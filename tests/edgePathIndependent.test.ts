/**
 * @file edgePathIndependent.test.ts
 * @description v91 独立审查配套测试（独立编写，不复用 tests/edgePath.test.ts 的断言口径）。
 *
 * 与项目自带 v91 测试的差异：
 * 1. 自带测试只校验「路径里出现控制点坐标字符串」「控制点数组长度 >= 2」，
 *    本文件改为**解析 path 指令**，断言 M 起点与每段 C 的终点序列严格等于
 *    [source, ...controlPoints, target]，即样条真的穿过每个控制点；
 * 2. 自带测试对 ZONE F 只校验 controlPoints.length >= 2，
 *    本文件按种子数据里的真实卡片矩形做**几何避让断言**（控制点不得落在任何状态卡内部）；
 * 3. 补充入参不可变性、上限饱和、索引钳位、findBestInsertIndex 精确命中、
 *    agentOps 端到端 sanitize 等自带测试未覆盖的边界；
 * 4. 末尾 3 条为「现状锁定」用例：把 v91 现存缺陷的当前数值钉住并注明应有行为，
 *    修复后这些断言会失败，从而强制同步更新（详见 changelog/v91-review-01.md）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildControlPointEdgePath,
  findBestInsertIndex,
  insertControlPoint,
  MAX_EDGE_CONTROL_POINTS,
  removeControlPoint,
  sanitizeControlPoints,
} from '../src/core/edgePath.ts';
import { applyAgentOperations } from '../src/core/agentOps.ts';
import { createSeedBlueprint } from '../src/core/seedBlueprint.ts';

interface Pt {
  x: number;
  y: number;
}

interface Cubic {
  from: Pt;
  cp1: Pt;
  cp2: Pt;
  to: Pt;
}

/** 解析 `M x y C x1 y1, x2 y2, x y ...` 指令序列，得到起点与各三次贝塞尔段。 */
function parsePath(d: string): { start: Pt; cubics: Cubic[] } {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  assert.ok(nums.length >= 8, `路径数字项不足，无法解析：${d}`);
  const start: Pt = { x: nums[0], y: nums[1] };
  const cubics: Cubic[] = [];
  let from = start;
  for (let i = 2; i + 5 < nums.length; i += 6) {
    const cp1: Pt = { x: nums[i], y: nums[i + 1] };
    const cp2: Pt = { x: nums[i + 2], y: nums[i + 3] };
    const to: Pt = { x: nums[i + 4], y: nums[i + 5] };
    cubics.push({ from, cp1, cp2, to });
    from = to;
  }
  return { start, cubics };
}

/** 三次贝塞尔在参数 t 处的点。 */
function sampleCubic(c: Cubic, t: number): Pt {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const d = 3 * mt * t * t;
  const e = t * t * t;
  return {
    x: a * c.from.x + b * c.cp1.x + d * c.cp2.x + e * c.to.x,
    y: a * c.from.y + b * c.cp1.y + d * c.cp2.y + e * c.to.y,
  };
}

/** 折线（控制多边形）弧长累计。 */
function chordLengths(pts: Pt[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    out.push(Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y));
  }
  return out;
}

test('独立①：路径严格穿过 [起点, ...控制点, 终点]，段数 = 控制点数 + 1', () => {
  const src = { x: 0, y: 0 };
  const tgt = { x: 300, y: 200 };
  const cps = [
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 260, y: 180 },
  ];
  const { path } = buildControlPointEdgePath(src.x, src.y, tgt.x, tgt.y, cps);
  const { start, cubics } = parsePath(path);

  assert.equal(cubics.length, cps.length + 1, '每两个相邻节点之间必须恰好一段三次贝塞尔');
  const endpoints: Pt[] = [start, ...cubics.map((c) => c.to)];
  const expected: Pt[] = [src, ...cps, tgt];
  assert.equal(endpoints.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    // path 里端点用 toFixed(1) 输出，容差取 0.05 足以覆盖舍入
    assert.ok(
      Math.abs(endpoints[i].x - expected[i].x) <= 0.05 && Math.abs(endpoints[i].y - expected[i].y) <= 0.05,
      `第 ${i} 个锚点应为 (${expected[i].x}, ${expected[i].y})，实际 (${endpoints[i].x}, ${endpoints[i].y})`
    );
  }

  // 上述断言等价于「C 指令序列的终点链 = 控制点链」，即 SVG 语义下每段必然首尾相接，
  // 不会出现断裂或跳点；段数也保证了没有多画/少画一段。
});

test('独立②：无控制点时退化为单段贝塞尔，标签落在端点包围盒内', () => {
  const { path, labelX, labelY, segmentMidpoints } = buildControlPointEdgePath(0, 0, 200, 100);
  const { start, cubics } = parsePath(path);

  assert.deepEqual(start, { x: 0, y: 0 });
  assert.deepEqual(cubics[0].to, { x: 200, y: 100 });
  assert.equal(cubics.length, 1);

  // 水平控制柄：cp1 在起点右侧、cp2 在终点左侧，且偏移量 >= 48（避免短边塌成直线）
  assert.ok(cubics[0].cp1.x - 0 >= 47.95, 'cp1 水平偏移应不小于 48');
  assert.ok(200 - cubics[0].cp2.x >= 47.95, 'cp2 水平偏移应不小于 48');
  assert.equal(cubics[0].cp1.y, 0);
  assert.equal(cubics[0].cp2.y, 100);

  // 标签 = 贝塞尔 t=0.5 点，必然落在端点包围盒内
  assert.ok(labelX >= 0 && labelX <= 200, `labelX ${labelX} 应落在 [0,200]`);
  assert.ok(labelY >= 0 && labelY <= 100, `labelY ${labelY} 应落在 [0,100]`);
  assert.equal(segmentMidpoints.length, 1, '无控制点时至多一个「+」插入手柄');
  assert.equal(segmentMidpoints[0].insertIndex, 0);
});

test('独立③：标签位于控制多边形弧长 50% 处，且落在所有控制点包围盒内', () => {
  const src = { x: 0, y: 0 };
  const tgt = { x: 300, y: 200 };
  const cps = [
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];
  const { labelX, labelY } = buildControlPointEdgePath(src.x, src.y, tgt.x, tgt.y, cps);

  const pts: Pt[] = [src, ...cps, tgt];
  const lens = chordLengths(pts);
  const total = lens.reduce((a, b) => a + b, 0);
  assert.ok(total > 0);

  // 找到标签落在哪一段、离折线多远、距起点已走过的折线弧长
  const label: Pt = { x: labelX, y: labelY };
  let best = { dist: Infinity, arc: 0 };
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const lenSq = vx * vx + vy * vy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((label.x - a.x) * vx + (label.y - a.y) * vy) / lenSq)) : 0;
    const px = a.x + t * vx;
    const py = a.y + t * vy;
    const d = Math.hypot(label.x - px, label.y - py);
    if (d < best.dist) best = { dist: d, arc: acc + t * (lens[i] || 0) };
    acc += lens[i] || 0;
  }

  assert.ok(best.dist <= 1.01, `标签应贴在控制多边形上，实测偏离 ${best.dist.toFixed(2)}px`);
  assert.ok(
    Math.abs(best.arc - total / 2) <= 1.01,
    `标签应位于折线弧长 50%（${(total / 2).toFixed(2)}px）处，实测 ${best.arc.toFixed(2)}px`
  );

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  assert.ok(labelX >= Math.min(...xs) && labelX <= Math.max(...xs), '标签 x 不得跑出控制点包围盒');
  assert.ok(labelY >= Math.min(...ys) && labelY <= Math.max(...ys), '标签 y 不得跑出控制点包围盒');
});

test('独立④：sanitizeControlPoints() 过滤非法项、按序截断到上限、幂等', () => {
  assert.deepEqual(sanitizeControlPoints(null), []);
  assert.deepEqual(sanitizeControlPoints('not-an-array'), []);
  assert.deepEqual(sanitizeControlPoints({ x: 1, y: 2 }), []);

  // 非对象、NaN、Infinity 一律丢弃；合法项保留顺序
  const mixed = sanitizeControlPoints([
    1,
    'x',
    null,
    { x: 1, y: 2 },
    { x: Number.NaN, y: 3 },
    { x: 4, y: Number.POSITIVE_INFINITY },
    { x: 5, y: 6 },
  ]);
  assert.deepEqual(mixed, [
    { x: 1, y: 2 },
    { x: 5, y: 6 },
  ]);

  // 四舍五入
  assert.deepEqual(sanitizeControlPoints([{ x: 1.4, y: 1.6 }]), [{ x: 1, y: 2 }]);

  // 超过上限时按前 N 个截断
  const many = Array.from({ length: 20 }, (_, i) => ({ x: i, y: i + 100 }));
  const capped = sanitizeControlPoints(many);
  assert.equal(capped.length, MAX_EDGE_CONTROL_POINTS);
  assert.deepEqual(capped[0], { x: 0, y: 100 });
  assert.deepEqual(capped[MAX_EDGE_CONTROL_POINTS - 1], { x: MAX_EDGE_CONTROL_POINTS - 1, y: MAX_EDGE_CONTROL_POINTS - 1 + 100 });

  // 幂等
  assert.deepEqual(sanitizeControlPoints(capped), capped);
});

test('独立⑤：insert/remove 不修改入参、索引钳位、满额饱和、插入后删除可还原', () => {
  const original = [{ x: 1, y: 2 }];
  const inserted = insertControlPoint(original, 0, { x: 9, y: 9 });
  assert.equal(original.length, 1, 'insertControlPoint 不得修改入参数组');
  assert.notEqual(inserted, original, '应返回新数组');
  assert.deepEqual(inserted, [
    { x: 9, y: 9 },
    { x: 1, y: 2 },
  ]);

  assert.deepEqual(removeControlPoint(inserted, 0), original, '删掉刚插入的点应还原');
  assert.equal(inserted.length, 2, 'removeControlPoint 不得修改入参数组');

  // 索引钳位：负值插到头部，越界插到尾部
  assert.deepEqual(insertControlPoint(original, -5, { x: 0, y: 0 })[0], { x: 0, y: 0 });
  const tail = insertControlPoint(original, 999, { x: 8, y: 8 });
  assert.deepEqual(tail[tail.length - 1], { x: 8, y: 8 });

  // 越界删除为无操作，不抛异常
  assert.deepEqual(removeControlPoint(original, -1), original);
  assert.deepEqual(removeControlPoint(original, 99), original);

  // 满额后 insert 饱和：长度不变、内容不变
  const full = Array.from({ length: MAX_EDGE_CONTROL_POINTS }, (_, i) => ({ x: i, y: 0 }));
  const over = insertControlPoint(full, 0, { x: 999, y: 999 });
  assert.equal(over.length, MAX_EDGE_CONTROL_POINTS);
  assert.deepEqual(over, full);
});

test('独立⑥：findBestInsertIndex() 精确命中最近线段（含两端钳位段）', () => {
  const src = { x: 0, y: 0 };
  const tgt = { x: 300, y: 0 };
  const cps = [
    { x: 100, y: 0 },
    { x: 200, y: 0 },
  ];
  // 三段：[0,100] [100,200] [200,300]
  assert.equal(findBestInsertIndex(src, tgt, cps, { x: 10, y: 5 }), 0, '靠近首段应返回 0');
  assert.equal(findBestInsertIndex(src, tgt, cps, { x: 150, y: 5 }), 1, '中点应返回 1');
  assert.equal(findBestInsertIndex(src, tgt, cps, { x: 290, y: 5 }), 2, '靠近末段应返回 2');

  // 零长段（起终点重合）不应抛异常、不产生 NaN 索引
  const degenerate = findBestInsertIndex({ x: 0, y: 0 }, { x: 0, y: 0 }, [], { x: 1, y: 1 });
  assert.equal(degenerate, 0);
});

test('独立⑦：ZONE F 五条回退连线的控制点全部落在状态卡矩形之外且互不重合', () => {
  const seed = createSeedBlueprint();
  const cards = ['fsm-idle', 'fsm-running', 'fsm-paused', 'fsm-done'].map((id) => {
    const n = seed.nodes[id];
    assert.ok(n, `种子缺少节点 ${id}`);
    return { id, x: n.x, y: n.y, w: n.width, h: n.height };
  });

  const routedEdges = [
    'edge-fsm-run-idle', // cancel
    'edge-fsm-run-pause', // pause
    'edge-fsm-pause-run', // resume
    'edge-fsm-pause-idle', // reset
    'edge-fsm-done-idle', // restart
  ];

  const seen = new Set<string>();
  let total = 0;

  for (const edgeId of routedEdges) {
    const edge = seed.edges[edgeId];
    assert.ok(edge, `种子缺少连线 ${edgeId}`);
    const cps = sanitizeControlPoints(edge.controlPoints);
    assert.ok(cps.length >= 2, `${edgeId} 应预置 ≥2 个避让控制点，实际 ${cps.length}`);

    for (const cp of cps) {
      total += 1;
      const key = `${cp.x},${cp.y}`;
      assert.equal(seen.has(key), false, `控制点 (${key}) 在 ${edgeId} 中与其它连线重复，会造成标签/走线重叠`);
      seen.add(key);

      for (const card of cards) {
        const inside = cp.x > card.x && cp.x < card.x + card.w && cp.y > card.y && cp.y < card.y + card.h;
        assert.equal(
          inside,
          false,
          `${edgeId} 的控制点 (${cp.x},${cp.y}) 落在卡片 ${card.id} 内部（矩形 ${card.x},${card.y} ${card.w}x${card.h}）`
        );
      }
    }
  }

  assert.equal(total, 14, 'v91 声明为五条连线共 14 个避让控制点');

  // cancel 走顶部走廊：全部控制点应位于四张卡片上沿（y=2040）之上
  const cancel = sanitizeControlPoints(seed.edges['edge-fsm-run-idle'].controlPoints);
  for (const cp of cancel) {
    assert.ok(cp.y < 2040, `cancel 的控制点 y=${cp.y} 应在卡片上沿 2040 之上`);
  }

  // pause 与 resume 是相反方向的两条平行走廊，走廊 x 不得重合，否则两条线会并线
  const pauseXs = new Set(sanitizeControlPoints(seed.edges['edge-fsm-run-pause'].controlPoints).map((p) => p.x));
  const resumeXs = new Set(sanitizeControlPoints(seed.edges['edge-fsm-pause-run'].controlPoints).map((p) => p.x));
  for (const x of pauseXs) {
    assert.equal(resumeXs.has(x), false, `pause 与 resume 共用走廊 x=${x}，两条回退线会重叠`);
  }
});

test('独立⑧：agentOps 的 connect_edge 落盘控制点前会 sanitize，且不污染入参蓝图', () => {
  const seed = createSeedBlueprint();
  const res = applyAgentOperations(seed, [
    {
      op: 'connect_edge',
      id: 'edge-review-independent',
      source: 'fsm-idle',
      target: 'fsm-done',
      label: 'review',
      controlPoints: [
        { x: 100.4, y: 200.6 },
        { x: Number.NaN, y: 0 },
        { x: 50, y: 60 },
      ],
    },
  ]);

  assert.equal(res.ok, true, `connect_edge 应成功：${res.ok ? '' : String((res as { error?: string }).error)}`);
  assert.ok(res.blueprint, '成功时应返回新蓝图');
  const edge = res.blueprint.edges['edge-review-independent'];
  assert.ok(edge, '新连线应写入蓝图');
  assert.deepEqual(
    edge.controlPoints,
    [
      { x: 100, y: 201 },
      { x: 50, y: 60 },
    ],
    'NaN 控制点应被丢弃，其余四舍五入'
  );
  assert.equal(seed.edges['edge-review-independent'], undefined, 'applyAgentOperations 不得修改入参蓝图');
});

test('独立⑨：上限 12 时路径段数与控制点数仍自洽，且标签不 NaN', () => {
  const cps = Array.from({ length: MAX_EDGE_CONTROL_POINTS }, (_, i) => ({ x: i * 20, y: i % 2 === 0 ? 0 : 80 }));
  const { path, labelX, labelY, segmentMidpoints } = buildControlPointEdgePath(0, 0, 300, 0, cps);
  const { cubics } = parsePath(path);

  assert.equal(cubics.length, MAX_EDGE_CONTROL_POINTS + 1);
  assert.equal(segmentMidpoints.length, MAX_EDGE_CONTROL_POINTS + 1);
  assert.ok(Number.isFinite(labelX) && Number.isFinite(labelY), '标签坐标必须是有限数');
  for (const mid of segmentMidpoints) {
    assert.ok(Number.isFinite(mid.x) && Number.isFinite(mid.y), '「+」手柄坐标必须是有限数');
  }
});

/* ------------------------------------------------------------------ *
 * 以下 3 条为「现状锁定」用例。
 * 它们把 v91 现存缺陷的当前数值钉住：一旦有人修复，这些断言会失败，
 * 从而强制同步更新并提醒复核 changelog/v91-review-01.md 中的对应条目。
 * ------------------------------------------------------------------ */

test('独立⑩[现状锁定]：sanitize 目前把 null / 空串坐标强转为 0（应改为拒绝）', () => {
  // 期望行为：{ x: null } / { x: '' } 不是合法坐标，应被丢弃 → []
  // 当前行为：Number(null) === 0、Number('') === 0，于是被当成原点控制点写入。
  assert.deepEqual(sanitizeControlPoints([{ x: null, y: 3 }]), [{ x: 0, y: 3 }]);
  assert.deepEqual(sanitizeControlPoints([{ x: '', y: 3 }]), [{ x: 0, y: 3 }]);
});

test('独立⑪[现状锁定]：段中点手柄/标签取的是控制多边形弦中点，不在渲染曲线上', () => {
  // 控制点 B 相对弦 A→C 有 200px 折角，曲线在弦外鼓出
  const { path, segmentMidpoints } = buildControlPointEdgePath(0, 0, 300, 200, [{ x: 0, y: 200 }]);
  const mid = segmentMidpoints[0];

  const { cubics } = parsePath(path);
  const onCurve = sampleCubic(cubics[0], 0.5);
  const gap = Math.hypot(mid.x - onCurve.x, mid.y - onCurve.y);

  // 期望行为：手柄应贴在曲线上（gap <= 2px）
  // 当前行为：手柄固定在弦中点 (0,100)，曲线实际经过 (-18.75,100)，偏离约 18.75px
  assert.ok(gap > 15, `当前弦中点与曲线中点应存在明显偏离，实测 ${gap.toFixed(2)}px`);
  assert.equal(mid.x, 0);
  assert.equal(mid.y, 100);
});

test('独立⑫[现状锁定]：uniform Catmull-Rom 在疏密不均控制点下会冲出包围盒', () => {
  // 控制点前后间距 5px 与 300px 悬殊，uniform 参数化会产生过冲
  const { path } = buildControlPointEdgePath(0, 0, 5, 300, [{ x: 5, y: 0 }]);
  const { cubics } = parsePath(path);

  let minY = Infinity;
  for (const cubic of cubics) {
    for (let i = 0; i <= 200; i++) {
      minY = Math.min(minY, sampleCubic(cubic, i / 200).y);
    }
  }

  // 期望行为：曲线不应越过控制点包围盒上界 y=0 之外超过 2px（centripetal 参数化可避免）
  // 当前行为：过冲到 y ≈ -22.2
  assert.ok(minY < -15, `当前应出现明显过冲，实测最低点 y=${minY.toFixed(2)}`);
});
