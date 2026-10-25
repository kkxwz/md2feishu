/**
 * 结构化 diff 更新：拉取文档现有块树与目标块树做指纹对齐（LCS），
 * 未变的块原样保留（保住其上的评论与手动调整），变化块原位补丁，
 * 删除/新增只动对应区间。比「全删全建」快得多，也不打断协作者。
 */
import { createHash } from 'node:crypto';
import type { FeishuClient } from './api/client.js';
import type { DescendantPayload, FeishuBlockInfo } from './api/endpoints.js';
import { batchDeleteChildren, createDescendants, listAllBlocks, patchTextBlock } from './api/endpoints.js';
import type { BlockNode } from './types.js';
import { buildTopPayloads, type ImageRef, type TopPayload } from './publisher.js';

/** 文本类块（可用 update_text_elements 原位补丁） */
const TEXT_BEARING_TYPES = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17]);

/** block_type → 内容实体字段名 */
const ENTITY_KEYS: Record<number, string> = {
  2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4', 7: 'heading5',
  8: 'heading6', 9: 'heading7', 10: 'heading8', 11: 'heading9',
  12: 'bullet', 13: 'ordered', 14: 'code', 15: 'quote', 17: 'todo',
  19: 'callout', 22: 'divider', 27: 'image', 31: 'table', 32: 'table_cell', 34: 'quote_container',
};

export interface DiffSummary {
  kept: number;
  patched: number;
  deleted: number;
  inserted: number;
  insertedImageRefs: ImageRef[];
}

type Canonical = { t: number; e: unknown; c: string[] };

/** 稳定序列化：对象键排序，便于跨来源比对 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function fingerprint(canon: Canonical): string {
  return createHash('sha256').update(stableStringify(canon)).digest('hex');
}

/** URL 解码到稳定：payload 侧可能是二次编码，GET 侧可能已解码，统一归一 */
function tryDecodeUrl(u: string): string {
  let prev = u;
  for (let i = 0; i < 3; i++) {
    try {
      const d = decodeURIComponent(prev);
      if (d === prev) break;
      prev = d;
    } catch {
      break;
    }
  }
  return prev;
}

/** 行内元素规范化：text_run 只留真值样式，链接 URL 解码，公式原样 */
function normalizeElements(elements: unknown): unknown {
  if (!Array.isArray(elements)) return null;
  return elements.map((el) => {
    const e = el as Record<string, Record<string, unknown>>;
    if (e?.text_run) {
      const style = (e.text_run.text_element_style ?? {}) as Record<string, unknown>;
      const s: Record<string, unknown> = {};
      for (const k of ['bold', 'italic', 'strikethrough', 'underline', 'inline_code']) {
        if (style[k] === true) s[k] = true;
      }
      if (style.link && typeof (style.link as { url?: string }).url === 'string') {
        s.l = tryDecodeUrl((style.link as { url: string }).url);
      }
      return { r: e.text_run.content ?? '', ...(Object.keys(s).length ? { s } : {}) };
    }
    if (e?.equation) return { eq: e.equation.content ?? '' };
    return { o: 1 }; // mention 等未知元素：标记为存在
  });
}

/** 块级文本样式规范化：丢弃默认值/不可稳定回读的字段（align/folded/sequence/缩进） */
function normalizeBlockStyle(style: unknown, blockType: number): unknown {
  if (!style || typeof style !== 'object') return null;
  const s = style as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (s.done === true) out.done = true;
  if (blockType === 14) {
    if (typeof s.language === 'number') out.language = s.language;
    if (s.wrap === true) out.wrap = true;
  }
  return Object.keys(out).length ? out : null;
}

/** 内容实体规范化：两侧（GET 块 / 我们的 payload）归一为同一形状 */
function normalizeEntity(blockType: number, entityRaw: unknown): unknown {
  const entity = (entityRaw ?? {}) as Record<string, unknown>;
  if (blockType === 27) return null; // 图片：忽略 token/尺寸，按位置保留（见 README 说明）
  if (blockType === 31) {
    const prop = (entity.property ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = { rs: prop.row_size, cs: prop.column_size };
    if (prop.header_row === true) out.hr = true;
    return out;
  }
  if (blockType === 19) {
    const out: Record<string, unknown> = {};
    if (entity.background_color !== undefined) out.bg = entity.background_color;
    if (entity.border_color !== undefined) out.bc = entity.border_color;
    if (entity.emoji_id !== undefined) out.em = entity.emoji_id;
    return out;
  }
  if (blockType === 22 || blockType === 32 || blockType === 34) return null;
  return {
    el: normalizeElements(entity.elements),
    st: normalizeBlockStyle(entity.style, blockType),
  };
}

export function canonicalizeExisting(block: FeishuBlockInfo, byId: Map<string, FeishuBlockInfo>, depth = 0): string {
  const key = ENTITY_KEYS[block.block_type];
  const entity = key ? (block as unknown as Record<string, unknown>)[key] : undefined;
  const childrenFp = (block.children ?? [])
    .slice(0, depth > 40 ? 0 : undefined)
    .map((id) => {
      const child = byId.get(id);
      return child ? canonicalizeExisting(child, byId, depth + 1) : 'MISSING';
    });
  return fingerprint({ t: block.block_type, e: normalizeEntity(block.block_type, entity), c: childrenFp });
}

export function canonicalizeDesired(payload: DescendantPayload, byTempId: Map<string, DescendantPayload>, depth = 0): string {
  const key = ENTITY_KEYS[payload.block_type];
  const entity = key ? (payload as unknown as Record<string, unknown>)[key] : undefined;
  const childrenFp = (payload.children ?? [])
    .slice(0, depth > 40 ? 0 : undefined)
    .map((id) => {
      const child = byTempId.get(id);
      return child ? canonicalizeDesired(child, byTempId, depth + 1) : 'MISSING';
    });
  return fingerprint({ t: payload.block_type, e: normalizeEntity(payload.block_type, entity), c: childrenFp });
}

type Op =
  | { kind: 'keep'; aIndex: number }
  | { kind: 'del'; pos: number; aStart: number; aEnd: number }
  | { kind: 'ins'; pos: number; bStart: number; bEnd: number }
  | { kind: 'patch'; pos: number; aIndex: number; bIndex: number };

/** LCS 对齐 + 算子规划 */
export function planDiffOps(aFp: string[], bFp: string[], patchable: (aIndex: number, bIndex: number) => boolean): Op[] {
  const n = aFp.length;
  const m = bFp.length;
  // DP 表（按行滚动求解长度，再从完整表中回溯；顶层块数量级小，直接 O(n*m)）
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aFp[i] === bFp[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matchedB = new Map<number, number>(); // bIndex -> aIndex
  const matchedA = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aFp[i] === bFp[j]) {
      matchedB.set(j, i);
      matchedA.add(i);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  const ops: Op[] = [];
  let ai = 0;
  let bi = 0;
  while (ai < n || bi < m) {
    if (bi < m && matchedB.has(bi)) {
      const match = matchedB.get(bi)!;
      // 先删除该匹配块之前遗留的未匹配 A 段
      if (match > ai) ops.push({ kind: 'del', pos: ai, aStart: ai, aEnd: match });
      ops.push({ kind: 'keep', aIndex: match });
      ai = match + 1;
      bi++;
      continue;
    }
    // 连续删除段
    let delEnd = ai;
    while (delEnd < n && !matchedA.has(delEnd)) delEnd++;
    // 连续插入段
    let insEnd = bi;
    while (insEnd < m && !matchedB.has(insEnd)) insEnd++;

    if (delEnd > ai && insEnd > bi) {
      // 相邻的删+插段：优先尝试原位补丁（保 block_id 与评论）
      const pairs = Math.min(delEnd - ai, insEnd - bi);
      let patched = 0;
      for (let k = 0; k < pairs; k++) {
        const aIdx = ai + k;
        const bIdx = bi + k;
        if (patchable(aIdx, bIdx)) {
          ops.push({ kind: 'patch', pos: aIdx, aIndex: aIdx, bIndex: bIdx });
          patched++;
        } else {
          break;
        }
      }
      const restAStart = ai + patched;
      const restBStart = bi + patched;
      if (delEnd > restAStart) ops.push({ kind: 'del', pos: restAStart, aStart: restAStart, aEnd: delEnd });
      if (insEnd > restBStart) {
        const anchor = delEnd >= n ? n : nextMatchedA(matchedA, delEnd, n);
        ops.push({ kind: 'ins', pos: anchor, bStart: restBStart, bEnd: insEnd });
      }
    } else if (delEnd > ai) {
      ops.push({ kind: 'del', pos: ai, aStart: ai, aEnd: delEnd });
    } else if (insEnd > bi) {
      const anchor = ai >= n ? n : nextMatchedA(matchedA, ai, n);
      ops.push({ kind: 'ins', pos: anchor, bStart: bi, bEnd: insEnd });
    }
    ai = delEnd;
    bi = insEnd;
  }
  return ops;
}

function nextMatchedA(matchedA: Set<number>, from: number, n: number): number {
  for (let k = from; k < n; k++) if (matchedA.has(k)) return k;
  return n;
}

/** 对外主流程：diff 更新一篇文档 */
export async function applyDiffUpdate(
  client: FeishuClient,
  documentId: string,
  blocks: BlockNode[],
  log: (msg: string) => void,
): Promise<DiffSummary> {
  const items = await listAllBlocks(client, documentId);
  const byId = new Map(items.map((b) => [b.block_id, b]));
  const page = items.find((b) => b.block_type === 1);
  const rootIds = (page?.children ?? []).filter((id) => byId.has(id));

  const tops: TopPayload[] = buildTopPayloads(blocks);
  const payloadById = new Map<string, DescendantPayload>();
  for (const top of tops) for (const p of top.payloads) payloadById.set(p.block_id, p);

  const aFp = rootIds.map((id) => canonicalizeExisting(byId.get(id)!, byId));
  const bFp = tops.map((top) => canonicalizeDesired(payloadById.get(top.rootId)!, payloadById));
  if (aFp.length * bFp.length > 4_000_000) {
    throw new Error(`文档顶层块数过大（${aFp.length}×${bFp.length}），diff 计算放弃`);
  }

  const rootPayload = (bIndex: number) => payloadById.get(tops[bIndex].rootId)!;
  const patchable = (aIndex: number, bIndex: number): boolean => {
    const oldBlock = byId.get(rootIds[aIndex])!;
    const payload = rootPayload(bIndex);
    if (oldBlock.block_type !== payload.block_type) return false;
    if (!TEXT_BEARING_TYPES.has(payload.block_type)) return false;
    const hasChildren = (payload.children?.length ?? 0) > 0 || (oldBlock.children?.length ?? 0) > 0;
    return !hasChildren;
  };

  const ops = planDiffOps(aFp, bFp, patchable);
  const summary: DiffSummary = { kept: 0, patched: 0, deleted: 0, inserted: 0, insertedImageRefs: [] };
  for (const op of ops) {
    if (op.kind === 'keep') summary.kept++;
    else if (op.kind === 'patch') summary.patched++;
    else if (op.kind === 'del') summary.deleted += op.aEnd - op.aStart;
    else summary.inserted += op.bEnd - op.bStart;
  }

  // 应用顺序：按位置从后往前；同位置先删后插
  const ordered = ops
    .filter((op): op is Exclude<Op, { kind: 'keep' }> => op.kind !== 'keep')
    .sort((x, y) => y.pos - x.pos || (x.kind === 'del' ? -1 : 1));
  log(`diff：保留 ${summary.kept}，补丁 ${summary.patched}，删除 ${summary.deleted}，新增 ${summary.inserted}`);

  for (const op of ordered) {
    if (op.kind === 'del') {
      for (let hi = op.aEnd; hi > op.aStart; hi -= 50) {
        const lo = Math.max(op.aStart, hi - 50);
        await batchDeleteChildren(client, documentId, documentId, lo, hi);
      }
    } else if (op.kind === 'ins') {
      // 段内按 900 块 / 18 图分批，段内顺序：从前往后（索引随插入量前移）
      let inserted = 0;
      let b = op.bStart;
      while (b < op.bEnd) {
        const subChildren: string[] = [];
        const subDescendants: DescendantPayload[] = [];
        let subImages = 0;
        while (b < op.bEnd) {
          const top = tops[b];
          if (subDescendants.length > 0 && (subDescendants.length + top.payloads.length > 900 || subImages + top.imageRefs.length > 18)) break;
          subChildren.push(top.rootId);
          subDescendants.push(...top.payloads);
          subImages += top.imageRefs.length;
          b++;
        }
        await createDescendants(client, documentId, documentId, subChildren, subDescendants, op.pos + inserted);
        inserted += subChildren.length;
      }
      for (let k = op.bStart; k < op.bEnd; k++) summary.insertedImageRefs.push(...tops[k].imageRefs);
    } else {
      // patch：失败则回退为删+插
      const oldBlock = byId.get(rootIds[op.aIndex])!;
      const payload = rootPayload(op.bIndex);
      const key = ENTITY_KEYS[payload.block_type];
      const entity = (payload as unknown as Record<string, unknown>)[key] as { elements?: unknown[]; style?: Record<string, unknown> };
      try {
        const style: { done?: boolean; language?: number; wrap?: boolean } = {};
        if (payload.block_type === 17 && entity?.style?.done !== undefined) style.done = entity.style.done === true;
        if (payload.block_type === 14 && entity?.style?.language !== undefined) {
          style.language = Number(entity.style.language);
          style.wrap = true;
        }
        await patchTextBlock(client, documentId, oldBlock.block_id, entity?.elements ?? [], Object.keys(style).length ? style : undefined);
      } catch (err) {
        log(`⚠ 原位补丁失败，改为重建该块：${(err as Error).message.split('\n')[0]}`);
        await batchDeleteChildren(client, documentId, documentId, op.aIndex, op.aIndex + 1);
        await createDescendants(client, documentId, documentId, [payload.block_id], [payload], op.aIndex);
      }
    }
  }
  return summary;
}
