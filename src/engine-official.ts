/**
 * 官方引擎：调用飞书「Markdown/HTML → 文档块」接口（docx:document.block:convert 权限），
 * 把原始 Markdown 交给官方转换器，再用现有的 descendant 写入与图片上传管线落地。
 * 与 builtin 引擎的差异：不支持公式/高亮块/GFM Alerts/front-matter 定制，但官方兼容性兜底。
 */
import type { FeishuClient } from './api/client.js';
import { convertMarkdownBlocks, createDescendants, uploadDocxImage, replaceImageToken, type ConvertBlock, type DescendantPayload } from './api/endpoints.js';
import { loadImage } from './api/images.js';
import type { PublishResult } from './publisher.js';

const MAX_BLOCKS_PER_BATCH = 900;
const MAX_IMAGES_PER_BATCH = 18;

export interface OfficialEngineOptions {
  documentId: string;
  url?: string;
  created: boolean;
  /** 去除 front-matter 后的原始 Markdown */
  markdown: string;
  baseDir: string;
  rebuild?: boolean;
  log: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

/** 清理官方返回块中的只读/多余字段（merge_info 传入会报错） */
export function sanitizeConvertBlocks(blocks: ConvertBlock[]): Map<string, DescendantPayload> {
  const map = new Map<string, DescendantPayload>();
  for (const block of blocks) {
    const payload: Record<string, unknown> = {
      block_id: block.block_id,
      block_type: block.block_type,
    };
    for (const key of [
      'text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'heading7',
      'heading8', 'heading9', 'bullet', 'ordered', 'todo', 'code', 'quote', 'callout',
      'quote_container', 'divider', 'image', 'table_cell',
    ]) {
      if (block[key] !== undefined) payload[key] = block[key];
    }
    if (block.table !== undefined) {
      const table = { ...block.table } as Record<string, unknown>;
      const property = { ...(table.property ?? {}) } as Record<string, unknown>;
      delete property.merge_info;
      if (Object.keys(property).length > 0) table.property = property;
      else delete table.property;
      payload.table = table;
    }
    if (block.children !== undefined && block.children.length > 0) payload.children = block.children;
    map.set(block.block_id, payload as unknown as DescendantPayload);
  }
  return map;
}

/** 按顶层子树统计块数/图片数，切成 ≤900 块 / ≤18 图的批次 */
export function planOfficialBatches(
  firstLevelIds: string[],
  byId: Map<string, DescendantPayload>,
): { childrenId: string[]; descendants: DescendantPayload[]; imageIds: string[] }[] {
  const batches: { childrenId: string[]; descendants: DescendantPayload[]; imageIds: string[] }[] = [];
  let current = { childrenId: [] as string[], descendants: [] as DescendantPayload[], imageIds: [] as string[] };
  for (const rootId of firstLevelIds) {
    // 收集整棵子树
    const subtree: DescendantPayload[] = [];
    const images: string[] = [];
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const p = byId.get(id);
      if (!p) continue;
      subtree.push(p);
      if (p.block_type === 27) images.push(id);
      for (const c of p.children ?? []) stack.push(c);
    }
    if (current.descendants.length > 0 && (current.descendants.length + subtree.length > MAX_BLOCKS_PER_BATCH || current.imageIds.length + images.length > MAX_IMAGES_PER_BATCH)) {
      batches.push(current);
      current = { childrenId: [], descendants: [], imageIds: [] };
    }
    current.childrenId.push(rootId);
    current.descendants.push(...subtree);
    current.imageIds.push(...images);
  }
  if (current.descendants.length > 0) batches.push(current);
  return batches;
}

/** 从 Markdown 提取图片 src（与官方转换产生的 image 块按文档顺序一一对应） */
export function extractImageSources(markdown: string): string[] {
  const out: string[] = [];
  const re = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) out.push(m[1]);
  return out;
}

export async function publishWithOfficialEngine(client: FeishuClient, opts: OfficialEngineOptions): Promise<PublishResult> {
  if (!opts.markdown.trim()) {
    throw new Error('official 引擎需要 markdownSource');
  }
  const { firstLevelBlockIds, blocks } = await convertMarkdownBlocks(client, opts.markdown);
  if (blocks.length === 0) throw new Error('官方转换返回了 0 个块');

  const byId = sanitizeConvertBlocks(blocks);
  const batches = planOfficialBatches(firstLevelBlockIds, byId);
  opts.log(`官方引擎：${blocks.length} 个块，分 ${batches.length} 批写入`);

  let blockCount = 0;
  for (const batch of batches) {
    await createDescendants(client, opts.documentId, opts.documentId, batch.childrenId, batch.descendants);
    blockCount += batch.descendants.length;
  }

  // 图片：官方返回空 image 块，按文档顺序与 Markdown 中的 src 配对后走三步上传
  const imageBlockIds = batches.flatMap((b) => b.imageIds);
  const sources = extractImageSources(opts.markdown);
  let imageCount = 0;
  const imageFailures: string[] = [];
  if (imageBlockIds.length > 0) {
    if (sources.length !== imageBlockIds.length) {
      opts.log(`⚠ 图片块（${imageBlockIds.length}）与 Markdown 图片（${sources.length}）数量不一致，按序尽量配对`);
    }
    for (let i = 0; i < Math.min(imageBlockIds.length, sources.length); i++) {
      const src = sources[i];
      try {
        const kind = /^https?:\/\//i.test(src) ? 'remote' : src.startsWith('data:') ? 'data' : 'local';
        const loaded = await loadImage({ src, kind, path: kind === 'local' ? src : undefined }, opts.baseDir, opts.fetchImpl);
        const token = await uploadDocxImage(client, imageBlockIds[i], loaded.fileName, loaded.bytes, loaded.mimeType);
        await replaceImageToken(client, opts.documentId, imageBlockIds[i], token);
        imageCount++;
      } catch (err) {
        imageFailures.push(src);
        opts.log(`⚠ 图片处理失败：${src.slice(0, 80)}（${(err as Error).message.split('\n')[0]}）`);
      }
    }
  }

  return {
    documentId: opts.documentId,
    url: opts.url,
    created: opts.created,
    blockCount,
    imageCount,
    imageFailures,
    engine: 'official',
  };
}
