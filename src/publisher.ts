import type { BlockNode, InlineElement, TextStyle } from './types.js';
import type { FeishuClient } from './api/client.js';
import type { DescendantPayload } from './api/endpoints.js';
import {
  batchDeleteChildren,
  createDescendants,
  createDocument,
  createWikiDocxNode,
  listAllBlocks,
  replaceImageToken,
  updateDocumentTitle,
  uploadDocxImage,
} from './api/endpoints.js';
import { displaySize, loadImage, type MermaidRenderOptions } from './api/images.js';

/** 单次 descendant 请求的块数上限是 1000，留安全余量 */
const MAX_DESCENDANTS_PER_BATCH = 900;
/** 单次请求图片数上限 20（错误码 1770035），留余量 */
const MAX_IMAGES_PER_BATCH = 18;

export interface ImageRef {
  tempId: string;
  node: BlockNode;
}

export interface PublishBatch {
  childrenId: string[];
  descendants: DescendantPayload[];
  imageRefs: ImageRef[];
}

export type UpdateMode = 'diff' | 'rebuild';

export interface PublishOptions {
  title: string;
  blocks: BlockNode[];
  /** Markdown 文件所在目录，用于解析相对图片路径 */
  baseDir: string;
  folderToken?: string;
  wiki?: { spaceId: string; parentNodeToken?: string };
  update?: { documentId: string; mode?: UpdateMode };
  domain?: string;
  dryRun?: boolean;
  /** 转换引擎：builtin（默认，精确控制）/ official（官方 Markdown→块接口） */
  engine?: 'builtin' | 'official';
  /** official 引擎使用的原始 Markdown（应去除 front-matter） */
  markdownSource?: string;
  /** mermaid 渲染配置 */
  mermaid?: MermaidRenderOptions;
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

export interface PublishResult {
  documentId: string;
  url?: string;
  created: boolean;
  blockCount: number;
  imageCount: number;
  imageFailures: string[];
  /** diff 更新统计 */
  diff?: { kept: number; patched: number; deleted: number; inserted: number };
  engine: 'builtin' | 'official';
}

/** 顶层子树的扁平 payload（diff 更新与分批写入共用） */
export interface TopPayload {
  rootId: string;
  payloads: DescendantPayload[];
  imageRefs: ImageRef[];
}

/** 把整棵 BlockNode 树展开为顶层子树 payload 列表（临时 ID 全局唯一） */
export function buildTopPayloads(topBlocks: BlockNode[]): TopPayload[] {
  let counter = 0;
  const nextId = () => `b${++counter}`;
  return topBlocks.map((top) => {
    const payloads: DescendantPayload[] = [];
    const imageRefs: ImageRef[] = [];
    const rootId = flattenNode(top, nextId, payloads, imageRefs);
    return { rootId, payloads, imageRefs };
  });
}

/**
 * 把整篇文档规划为若干个「创建嵌套块」请求。
 * 以顶层子树为最小拆分单位（子树不能跨请求拆开）。
 */
export function planBatches(topBlocks: BlockNode[]): PublishBatch[] {
  const tops = buildTopPayloads(topBlocks);
  const batches: PublishBatch[] = [];
  let current: PublishBatch = { childrenId: [], descendants: [], imageRefs: [] };
  for (const top of tops) {
    const images = top.imageRefs.length;
    const wouldExceed =
      current.descendants.length + top.payloads.length > MAX_DESCENDANTS_PER_BATCH ||
      current.imageRefs.length + images > MAX_IMAGES_PER_BATCH;
    if (wouldExceed && current.descendants.length > 0) {
      batches.push(current);
      current = { childrenId: [], descendants: [], imageRefs: [] };
    }
    current.childrenId.push(top.rootId);
    current.descendants.push(...top.payloads);
    current.imageRefs.push(...top.imageRefs);
  }
  if (current.descendants.length > 0) batches.push(current);
  return batches;
}

/** 递归：把节点转成 API payload，追加到 payloads，返回自身的临时 ID */
function flattenNode(
  node: BlockNode,
  nextId: () => string,
  payloads: DescendantPayload[],
  imageRefs: ImageRef[],
): string {
  const tempId = nextId();
  const childIds: string[] = [];

  switch (node.kind) {
    case 'text':
    case 'heading':
    case 'bullet':
    case 'ordered':
    case 'todo': {
      const entity = { elements: toApiElements(node.elements), style: buildBlockStyle(node) };
      const typeAndKey =
        node.kind === 'text'
          ? { t: 2, k: 'text' as const }
          : node.kind === 'heading'
            ? { t: 2 + clamp(node.level ?? 1, 1, 9), k: `heading${clamp(node.level ?? 1, 1, 9)}` as 'heading1' }
            : node.kind === 'bullet'
              ? { t: 12, k: 'bullet' as const }
              : node.kind === 'ordered'
                ? { t: 13, k: 'ordered' as const }
                : { t: 17, k: 'todo' as const };
      const payload: DescendantPayload = { block_id: tempId, block_type: typeAndKey.t };
      (payload as unknown as Record<string, unknown>)[typeAndKey.k] = entity;
      for (const child of node.children ?? []) childIds.push(flattenNode(child, nextId, payloads, imageRefs));
      if (childIds.length > 0) payload.children = childIds;
      payloads.push(payload);
      return tempId;
    }
    case 'code': {
      payloads.push({
        block_id: tempId,
        block_type: 14,
        code: {
          elements: [{ text_run: { content: node.code?.content ?? '' } }],
          style: { language: node.code?.language ?? 1, wrap: true },
        },
      });
      return tempId;
    }
    case 'equation': {
      // 飞书当前无独立公式块类型：用仅含公式元素的文本块承载块级公式
      payloads.push({
        block_id: tempId,
        block_type: 2,
        text: { elements: [{ equation: { content: node.latex ?? '' } }], style: {} },
      });
      return tempId;
    }
    case 'divider': {
      payloads.push({ block_id: tempId, block_type: 22, divider: {} });
      return tempId;
    }
    case 'image': {
      const size = displaySize(node.imageWidth, node.imageHeight);
      payloads.push({
        block_id: tempId,
        block_type: 27,
        image: size ? { width: size.width, height: size.height } : {},
      });
      imageRefs.push({ tempId, node });
      return tempId;
    }
    case 'quote': {
      for (const child of node.children ?? []) childIds.push(flattenNode(child, nextId, payloads, imageRefs));
      if (childIds.length === 0) {
        const emptyId = nextId();
        payloads.push({ block_id: emptyId, block_type: 2, text: { elements: emptyElements(), style: {} } });
        childIds.push(emptyId);
      }
      payloads.push({ block_id: tempId, block_type: 34, quote_container: {}, children: childIds });
      return tempId;
    }
    case 'callout': {
      for (const child of node.children ?? []) childIds.push(flattenNode(child, nextId, payloads, imageRefs));
      if (childIds.length === 0) {
        const emptyId = nextId();
        payloads.push({ block_id: emptyId, block_type: 2, text: { elements: emptyElements(), style: {} } });
        childIds.push(emptyId);
      }
      payloads.push({
        block_id: tempId,
        block_type: 19,
        callout: {
          background_color: node.callout?.backgroundColor ?? 5,
          border_color: node.callout?.borderColor ?? 5,
          emoji_id: node.callout?.emoji ?? 'bulb',
        },
        children: childIds,
      });
      return tempId;
    }
    case 'table': {
      const rows = node.rows ?? 0;
      const cols = node.cols ?? 0;
      const cellIds: string[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cellId = nextId();
          cellIds.push(cellId);
          const contentIds: string[] = [];
          const cellBlocks = node.cells?.[r * cols + c] ?? [];
          if (cellBlocks.length === 0) {
            const emptyId = nextId();
            payloads.push({ block_id: emptyId, block_type: 2, text: { elements: emptyElements(), style: {} } });
            contentIds.push(emptyId);
          }
          for (const cb of cellBlocks) contentIds.push(flattenNode(cb, nextId, payloads, imageRefs));
          payloads.push({ block_id: cellId, block_type: 32, table_cell: {}, children: contentIds });
        }
      }
      payloads.push({
        block_id: tempId,
        block_type: 31,
        table: {
          property: {
            row_size: rows,
            column_size: cols,
            header_row: true,
            ...(node.columnWidths ? { column_width: node.columnWidths } : {}),
          },
        },
        children: cellIds,
      });
      return tempId;
    }
    default:
      payloads.push({ block_id: tempId, block_type: 2, text: { elements: emptyElements(), style: {} } });
      return tempId;
  }
}

function buildBlockStyle(node: BlockNode): Record<string, unknown> {
  const style: Record<string, unknown> = {};
  if (node.kind === 'todo') style.done = node.done === true;
  if (node.kind === 'ordered' && node.orderedStart != null) style.sequence = String(node.orderedStart);
  return style;
}

function toApiElements(elements: InlineElement[] | undefined): unknown[] {
  const list = elements && elements.length > 0 ? elements : [{ type: 'text' as const, content: '', style: {} }];
  return list.map((el) =>
    el.type === 'equation'
      ? { equation: { content: el.content } }
      : { text_run: { content: el.content, ...(hasAnyStyle(el.style) ? { text_element_style: toApiStyle(el.style) } : {}) } },
  );
}

function emptyElements(): unknown[] {
  return [{ text_run: { content: '' } }];
}

function hasAnyStyle(style: TextStyle | undefined): boolean {
  if (!style) return false;
  return Boolean(
    style.bold || style.italic || style.strikethrough || style.underline || style.inlineCode || style.linkUrl,
  );
}

function toApiStyle(style: TextStyle): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (style.bold) out.bold = true;
  if (style.italic) out.italic = true;
  if (style.strikethrough) out.strikethrough = true;
  if (style.underline) out.underline = true;
  if (style.inlineCode) out.inline_code = true;
  if (style.linkUrl) out.link = { url: encodeURIComponent(style.linkUrl) };
  return out;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/** 收集树中所有图片节点（深度优先，保持文档顺序） */
export function collectImages(blocks: BlockNode[], out: BlockNode[] = []): BlockNode[] {
  for (const b of blocks) {
    if (b.kind === 'image') out.push(b);
    if (b.children) collectImages(b.children, out);
    if (b.cells) for (const cell of b.cells) collectImages(cell, out);
  }
  return out;
}

/** 预加载图片（去重、并发 3）；失败者降级为链接文本或代码块 */
export async function preloadImages(
  blocks: BlockNode[],
  baseDir: string,
  log?: (msg: string) => void,
  fetchImpl?: typeof fetch,
  mermaidOpts?: MermaidRenderOptions,
): Promise<string[]> {
  const failures: string[] = [];
  const nodes = collectImages(blocks);
  const bySrc = new Map<string, BlockNode[]>();
  for (const n of nodes) {
    if (!n.image) continue;
    const arr = bySrc.get(n.image.src) ?? [];
    arr.push(n);
    bySrc.set(n.image.src, arr);
  }
  const entries = [...bySrc.entries()];
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const [src, group] = entries[cursor++];
      try {
        const loaded = await loadImage(group[0].image!, baseDir, fetchImpl, mermaidOpts);
        for (const n of group) {
          n.imageWidth = loaded.width;
          n.imageHeight = loaded.height;
          (n as BlockNode & { __loaded?: unknown }).__loaded = loaded;
        }
      } catch (err) {
        const msg = (err as Error).message;
        failures.push(src);
        log?.(`⚠ 图片/mermaid 加载失败，降级处理：${src.slice(0, 80)}（${msg}）`);
        for (const n of group) degrade(n, msg);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return failures;
}

type LoadedImageData = { bytes: Uint8Array; mimeType: string; fileName: string };

/** 上传阶段需要的字节内容挂在节点上 */
function loadedDataOf(node: BlockNode): LoadedImageData | undefined {
  const v = (node as BlockNode & { __loaded?: LoadedImageData }).__loaded;
  return v;
}

/** 失败降级：mermaid → 纯文本代码块；普通图片 → 链接文本块 */
function degrade(node: BlockNode, reason: string): void {
  const image = node.image;
  if (image?.kind === 'mermaid') {
    node.kind = 'code';
    node.image = undefined;
    node.imageWidth = node.imageHeight = undefined;
    node.elements = undefined;
    node.code = { content: image.src, language: 1, rawLanguage: `mermaid（渲染失败：${reason.slice(0, 60)}）` };
    return;
  }
  const src = image?.src ?? '';
  const alt = image?.alt ?? '';
  node.kind = 'text';
  node.image = undefined;
  node.imageWidth = node.imageHeight = undefined;
  node.elements = [
    {
      type: 'text',
      content: alt ? `🖼️ ${alt}（图片加载失败）` : `🖼️ ${src}`,
      style: /^https?:\/\//.test(src) ? { linkUrl: src } : {},
    },
  ];
}

/** 发布主流程 */
export async function publishDocument(client: FeishuClient, opts: PublishOptions): Promise<PublishResult> {
  const log = opts.log ?? (() => {});
  const blocks = opts.blocks;

  // 1. 解析目标文档
  let documentId: string;
  let url: string | undefined;
  let created: boolean;
  if (opts.update) {
    documentId = opts.update.documentId;
    created = false;
    url = opts.domain ? `${opts.domain}/docx/${documentId}` : undefined;
  } else if (opts.wiki) {
    const node = await createWikiDocxNode(client, opts.wiki.spaceId, opts.title, opts.wiki.parentNodeToken);
    documentId = node.obj_token;
    created = true;
    url = opts.domain ? `${opts.domain}/wiki/${node.node_token}` : undefined;
  } else {
    documentId = await createDocument(client, opts.title, opts.folderToken);
    created = true;
    url = opts.domain ? `${opts.domain}/docx/${documentId}` : undefined;
  }

  // 2. official 引擎：走官方 Markdown→块 接口（失败自动回退 builtin）
  if (opts.engine === 'official' && !opts.dryRun) {
    try {
      const { publishWithOfficialEngine } = await import('./engine-official.js');
      return await publishWithOfficialEngine(client, {
        documentId,
        url,
        created,
        markdown: opts.markdownSource ?? '',
        baseDir: opts.baseDir,
        log,
        fetchImpl: opts.fetchImpl,
        // official 引擎更新=清空重建
        rebuild: Boolean(opts.update),
      });
    } catch (err) {
      log(`⚠ 官方引擎失败，回退内置引擎：${(err as Error).message.split('\n')[0]}`);
      if (opts.update) await clearDocument(client, documentId);
    }
  }

  // 3. builtin 引擎
  if (!opts.dryRun) await preloadImages(blocks, opts.baseDir, log, opts.fetchImpl, opts.mermaid);

  if (opts.update) {
    log(`更新已有文档 ${documentId}…`);
    try {
      await updateDocumentTitle(client, documentId, opts.title);
    } catch (err) {
      log(`⚠ 标题未更新（不影响正文）：${(err as Error).message.split('\n')[0]}`);
    }
    const mode = opts.update.mode ?? 'diff';
    if (mode === 'diff') {
      const { applyDiffUpdate } = await import('./diff.js');
      try {
        const diffSummary = await applyDiffUpdate(client, documentId, blocks, log);
        const imageCount = await uploadPendingImages(client, documentId, diffSummary.insertedImageRefs, log);
        cleanLoadedMarkers(blocks);
        return {
          documentId,
          url,
          created,
          blockCount: diffSummary.kept + diffSummary.patched + diffSummary.inserted,
          imageCount,
          imageFailures: [],
          diff: { kept: diffSummary.kept, patched: diffSummary.patched, deleted: diffSummary.deleted, inserted: diffSummary.inserted },
          engine: 'builtin',
        };
      } catch (err) {
        log(`⚠ diff 更新失败，回退整体重建：${(err as Error).message.split('\n')[0]}`);
      }
    }
    await clearDocument(client, documentId);
  }

  const batches = planBatches(blocks);
  let imageCount = 0;
  const imageFailures: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    log(`写入块 ${i + 1}/${batches.length}（${batch.descendants.length} 个块）…`);
    const relations = await createDescendants(client, documentId, documentId, batch.childrenId, batch.descendants);
    imageCount += await uploadPendingImages(client, documentId, batch.imageRefs, log, relations, imageFailures);
  }
  cleanLoadedMarkers(blocks);

  const blockCount = batches.reduce((sum, b) => sum + b.descendants.length, 0);
  return { documentId, url, created, blockCount, imageCount, imageFailures, engine: 'builtin' };
}

/** 上传一批图片（先并发上传素材，再按文档通道顺序替换 token） */
async function uploadPendingImages(
  client: FeishuClient,
  documentId: string,
  refs: ImageRef[],
  log: (msg: string) => void,
  relations?: Map<string, string>,
  imageFailures?: string[],
): Promise<number> {
  if (refs.length === 0) return 0;
  const entries: { ref: ImageRef; realId?: string; token?: string }[] = refs.map((ref) => ({
    ref,
    realId: relations ? relations.get(ref.tempId) : ref.tempId,
  }));

  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      const loaded = loadedDataOf(entry.ref.node);
      if (!entry.realId || !loaded) continue;
      try {
        entry.token = await uploadDocxImage(client, entry.realId, loaded.fileName, loaded.bytes, loaded.mimeType);
      } catch (err) {
        imageFailures?.push(entry.ref.node.image?.src ?? '(未知图片)');
        log(`⚠ 图片上传失败：${entry.ref.node.image?.src?.slice(0, 80)}（${(err as Error).message.split('\n')[0]}）`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  let count = 0;
  for (const entry of entries) {
    if (!entry.token || !entry.realId) continue;
    try {
      await replaceImageToken(client, documentId, entry.realId, entry.token);
      count++;
    } catch (err) {
      imageFailures?.push(entry.ref.node.image?.src ?? '(未知图片)');
      log(`⚠ 图片替换失败：${(err as Error).message.split('\n')[0]}`);
    }
  }
  return count;
}

function cleanLoadedMarkers(blocks: BlockNode[]): void {
  for (const b of collectImages(blocks)) {
    delete (b as BlockNode & { __loaded?: unknown }).__loaded;
  }
}

/** 清空文档正文（page 块的子块），保留文档本身与链接 */
export async function clearDocument(client: FeishuClient, documentId: string): Promise<void> {
  const blocks = await listAllBlocks(client, documentId);
  const page = blocks.find((b) => b.block_type === 1);
  let remaining = page?.children?.length ?? 0;
  while (remaining > 0) {
    const end = Math.min(50, remaining);
    await batchDeleteChildren(client, documentId, documentId, 0, end);
    remaining -= end;
  }
}

/** dry-run 导出：剔除内部加载标记 */
export function dryRunReplacer(key: string, value: unknown): unknown {
  if (key.startsWith('__')) return undefined;
  return value;
}
