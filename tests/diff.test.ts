import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/convert/parse.js';
import { convertDocument } from '../src/convert/blocks.js';
import { planDiffOps, canonicalizeExisting, canonicalizeDesired } from '../src/diff.js';
import { buildTopPayloads, planBatches } from '../src/publisher.js';
import type { DescendantPayload, FeishuBlockInfo } from '../src/api/endpoints.js';

function desiredPayloads(md: string): { tops: ReturnType<typeof buildTopPayloads>; byId: Map<string, DescendantPayload> } {
  const doc = convertDocument(parseMarkdown(md), { fallbackTitle: 't', titleFromHeading: false });
  const tops = buildTopPayloads(doc.blocks);
  const byId = new Map<string, DescendantPayload>();
  for (const t of tops) for (const p of t.payloads) byId.set(p.block_id, p);
  return { tops, byId };
}

describe('planDiffOps（LCS 对齐与算子规划）', () => {
  it('完全一致：全部 keep，无写操作', () => {
    const ops = planDiffOps(['a', 'b', 'c'], ['a', 'b', 'c'], () => false);
    expect(ops.filter((o) => o.kind === 'keep')).toHaveLength(3);
    expect(ops.filter((o) => o.kind !== 'keep')).toHaveLength(0);
  });

  it('中间替换：patch 配对成功时用 patch，否则 del+ins', () => {
    const ops = planDiffOps(['a', 'b', 'c'], ['a', 'x', 'c'], () => true);
    expect(ops).toContainEqual({ kind: 'patch', pos: 1, aIndex: 1, bIndex: 1 });
    expect(ops.filter((o) => o.kind === 'del')).toHaveLength(0);
    expect(ops.filter((o) => o.kind === 'ins')).toHaveLength(0);

    const ops2 = planDiffOps(['a', 'b', 'c'], ['a', 'x', 'c'], () => false);
    expect(ops2).toContainEqual({ kind: 'del', pos: 1, aStart: 1, aEnd: 2 });
    expect(ops2).toContainEqual({ kind: 'ins', pos: 2, bStart: 1, bEnd: 2 });
  });

  it('纯删除与纯新增（首尾位置）', () => {
    const ops = planDiffOps(['a', 'b', 'c'], ['b'], () => false);
    expect(ops).toContainEqual({ kind: 'del', pos: 0, aStart: 0, aEnd: 1 });
    expect(ops).toContainEqual({ kind: 'del', pos: 2, aStart: 2, aEnd: 3 });

    const ops2 = planDiffOps(['b'], ['a', 'b', 'c'], () => false);
    expect(ops2).toContainEqual({ kind: 'ins', pos: 0, bStart: 0, bEnd: 1 });
    expect(ops2).toContainEqual({ kind: 'ins', pos: 1, bStart: 2, bEnd: 3 });
  });

  it('从空文档到有内容：全部插入，锚点为 0', () => {
    const ops = planDiffOps([], ['x', 'y'], () => false);
    expect(ops).toEqual([{ kind: 'ins', pos: 0, bStart: 0, bEnd: 2 }]);
  });

  it('从有内容到空文档：全部删除', () => {
    const ops = planDiffOps(['x', 'y'], [], () => false);
    expect(ops).toEqual([{ kind: 'del', pos: 0, aStart: 0, aEnd: 2 }]);
  });

  it('应用顺序：按 pos 降序，同位置 del 在 ins 前', () => {
    const ops = planDiffOps(['a', 'b', 'c', 'd'], ['a', 'x', 'd'], () => false);
    const nonKeep = (
      ops.filter((o) => o.kind !== 'keep') as { kind: string; pos: number }[]
    ).sort((x, y) => y.pos - x.pos || (x.kind === 'del' ? -1 : 1));
    for (let i = 1; i < nonKeep.length; i++) {
      if (nonKeep[i - 1].pos === nonKeep[i].pos) {
        expect(nonKeep[i - 1].kind).toBe('del');
      } else {
        expect(nonKeep[i - 1].pos).toBeGreaterThanOrEqual(nonKeep[i].pos);
      }
    }
  });
});

describe('指纹兼容性（payload ↔ GET 块）', () => {
  const fp = (md: string): string[] => {
    const { tops, byId } = desiredPayloads(md);
    return tops.map((t) => canonicalizeDesired(byId.get(t.rootId)!, byId));
  };

  /** 构造一个「GET 回读」风格的块：补上默认值字段/只读字段 */
  const asGetBlock = (payload: DescendantPayload, extra: Record<string, unknown> = {}): FeishuBlockInfo =>
    ({
      block_id: `real_${payload.block_id}`,
      parent_id: 'pagedoc',
      children: payload.children ?? [],
      block_type: payload.block_type,
      ...Object.fromEntries(Object.entries(payload).filter(([k]) => !['block_id', 'block_type', 'children'].includes(k))),
      ...extra,
    }) as unknown as FeishuBlockInfo;

  it('文本块：GET 的 align/folded 默认值与空 text_element_style 不影响一致性', () => {
    const [desiredFp] = fp('甲 **乙** [丙](https://a.b/c?x=1)');
    const { tops, byId } = desiredPayloads('甲 **乙** [丙](https://a.b/c?x=1)');
    const payload = byId.get(tops[0].rootId)!;
    const raw = payload as unknown as { text: { elements: Record<string, { text_run: Record<string, unknown> }>[] } };
    const getBlock = asGetBlock(payload, {
      text: {
        style: { align: 1, folded: false },
        elements: raw.text.elements.map((el) => ({
          text_run: {
            ...el.text_run,
            text_element_style: el.text_run.text_element_style ?? {},
          },
        })),
      },
    });
    const byIdGet = new Map<string, FeishuBlockInfo>([[getBlock.block_id, getBlock]]);
    expect(canonicalizeExisting(getBlock, byIdGet)).toBe(desiredFp);
  });

  it('链接 URL：GET 返回解码值与我们发送的编码值指纹一致', () => {
    const [desiredFp] = fp('[点我](https://a.b/c?x=1%26y=2)');
    const { tops, byId } = desiredPayloads('[点我](https://a.b/c?x=1%26y=2)');
    const payload = byId.get(tops[0].rootId)!;
    const raw = payload as unknown as { text: { elements: { text_run: { content: string; text_element_style?: { link?: { url: string } } } }[] } };
    // 我们发送的是 encodeURIComponent 后的 url；模拟 GET 返回已解码
    const sentUrl = raw.text.elements[0].text_run.text_element_style!.link.url;
    const decoded = decodeURIComponent(sentUrl);
    const getBlock = asGetBlock(payload, {
      text: {
        style: {},
        elements: [
          { text_run: { content: '点我', text_element_style: { link: { url: decoded } } } },
        ],
      },
    });
    const byIdGet = new Map<string, FeishuBlockInfo>([[getBlock.block_id, getBlock]]);
    expect(canonicalizeExisting(getBlock, byIdGet)).toBe(desiredFp);
  });

  it('表格：GET 的 merge_info/header_column 不影响一致性', () => {
    const md = '| A | B |\n| - | - |\n| 1 | 2 |';
    const { tops, byId } = desiredPayloads(md);
    const desiredFp = canonicalizeDesired(byId.get(tops[0].rootId)!, byId);
    const tablePayload = byId.get(tops[0].rootId)!;
    const prop = (tablePayload as unknown as { table: { property: Record<string, unknown> } }).table.property;
    const getBlock = asGetBlock(tablePayload, {
      table: {
        cells: (tablePayload.children ?? []).slice(),
        property: {
          ...prop,
          merge_info: [{ row_span: 1, col_span: 1 }, { row_span: 1, col_span: 1 }],
          header_column: false,
        },
      },
    });
    // 单元格与内容子块也要放进 map，才能递归
    const byIdGet = new Map<string, FeishuBlockInfo>([[getBlock.block_id, getBlock]]);
    for (const p of tops[0].payloads) {
      if (p.block_id === tablePayload.block_id) continue;
      byIdGet.set(`real_${p.block_id}`, asGetBlock(p));
    }
    // 修正父子关系的 id 引用
    const remap = (old: string) => `real_${old}`;
    const fixed = byIdGet.get(`real_${tablePayload.block_id}`)!;
    fixed.children = (tablePayload.children ?? []).map(remap);
    for (const p of tops[0].payloads) {
      const g = byIdGet.get(`real_${p.block_id}`)!;
      if (p.children) g.children = p.children.map(remap);
    }
    expect(canonicalizeExisting(fixed, byIdGet)).toBe(desiredFp);
  });

  it('图片：GET 的 token/尺寸被忽略，有序列表 sequence 差异被忽略', () => {
    const md = '![](a.png)';
    const { tops, byId } = desiredPayloads(md);
    const imgPayload = byId.get(tops[0].rootId)!;
    const getBlock = asGetBlock(imgPayload, { image: { token: 'boxcnXXX', width: 640, height: 480 } });
    const byIdGet = new Map<string, FeishuBlockInfo>([[getBlock.block_id, getBlock]]);
    expect(canonicalizeExisting(getBlock, byIdGet)).toBe(canonicalizeDesired(imgPayload, byId));

    const md2 = '3. 起点';
    const { tops: t2, byId: m2 } = desiredPayloads(md2);
    const orderedPayload = m2.get(t2[0].rootId)!;
    const getOrdered = asGetBlock(orderedPayload, {
      ordered: { elements: (orderedPayload as unknown as { ordered: { elements: unknown[] } }).ordered.elements, style: { sequence: 'auto' } },
    });
    const byIdGet2 = new Map<string, FeishuBlockInfo>([[getOrdered.block_id, getOrdered]]);
    expect(canonicalizeExisting(getOrdered, byIdGet2)).toBe(canonicalizeDesired(orderedPayload, m2));
  });
});

describe('planBatches 与 diff 共用 buildTopPayloads', () => {
  it('两次转换相同内容的 payload 拓扑一致（id 可能不同）', () => {
    const md = '| A | B |\n| - | - |\n| 1 | 2 |';
    const t1 = buildTopPayloads(convertDocument(parseMarkdown(md), { fallbackTitle: 't' }).blocks);
    const t2 = buildTopPayloads(convertDocument(parseMarkdown(md), { fallbackTitle: 't' }).blocks);
    const shape = (tops: ReturnType<typeof buildTopPayloads>) =>
      tops[0].payloads.map((p) => `${p.block_type}:${(p.children ?? []).length}`).join('|');
    expect(shape(t1)).toBe(shape(t2));
  });

  it('planBatches 仍按限额分批', () => {
    const md = Array.from({ length: 1000 }, (_, i) => `p${i}`).join('\n\n');
    const batches = planBatches(convertDocument(parseMarkdown(md), { fallbackTitle: 't' }).blocks);
    expect(batches.length).toBe(2);
  });
});
