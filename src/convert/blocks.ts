import type { BlockContent, PhrasingContent, RootContent } from 'mdast';
import type { BlockNode, ConvertedDoc, Frontmatter, InlineElement } from '../types.js';
import { convertInline, mergeElements, describeImage, type InlineSegment } from './inline.js';
import { mapCodeLanguage } from './languages.js';
import type { ParsedMarkdown } from './parse.js';

/** GFM Alerts（> [!NOTE] 等）→ 飞书高亮块样式 */
const ALERT_STYLES: Record<string, { emoji: string; backgroundColor: number; borderColor: number }> = {
  NOTE: { emoji: 'bulb', backgroundColor: 5, borderColor: 5 }, // 浅蓝/蓝
  TIP: { emoji: 'white_check_mark', backgroundColor: 4, borderColor: 4 }, // 浅绿/绿
  IMPORTANT: { emoji: 'exclamation', backgroundColor: 6, borderColor: 6 }, // 浅紫/紫
  WARNING: { emoji: 'rotating_light', backgroundColor: 3, borderColor: 3 }, // 浅黄/黄
  CAUTION: { emoji: 'no_entry_sign', backgroundColor: 1, borderColor: 1 }, // 浅红/红
};

interface ConvertContext {
  warnings: string[];
  footnotes: { label: string; node: RootContent }[];
}

export interface ConvertOptions {
  /** 首个 Heading 作为文档标题并从正文移除（默认 true） */
  titleFromHeading?: boolean;
  /** 兜底标题（如文件名） */
  fallbackTitle?: string;
  /** 显式标题（优先级最高） */
  title?: string;
  /** 块级公式前加 \displaystyle，让积分/求和上下标渲染在符号上下方（默认 true） */
  displayStyle?: boolean;
  /** mermaid 代码块处理：code=纯文本代码块（默认）；image=渲染为图片 */
  mermaidMode?: 'code' | 'image';
}

export function convertDocument(parsed: ParsedMarkdown, options: ConvertOptions = {}): ConvertedDoc {
  const ctx: ConvertContext = { warnings: [], footnotes: [] };
  const fm: Frontmatter = parsed.frontmatter;

  const firstIsHeading = parsed.mdast.children[0]?.type === 'heading';
  const blocks = convertAll(parsed.mdast.children, ctx, options);

  // 脚注定义 → 文末列表
  if (ctx.footnotes.length > 0) {
    blocks.push({ kind: 'divider' });
    for (const fn of ctx.footnotes) {
      const def = fn.node as unknown as { children?: RootContent[] };
      // footnoteDefinition 的子节点是块级（通常为 paragraph），取其行内内容
      const inlineSource: PhrasingContent[] = [];
      for (const child of def?.children ?? []) {
        if (child.type === 'paragraph') {
          inlineSource.push(...(child as unknown as { children: PhrasingContent[] }).children);
        } else if (child.type === 'text' || child.type === 'inlineCode') {
          inlineSource.push(child as PhrasingContent);
        }
      }
      blocks.push({
        kind: 'bullet',
        elements: mergeElements([
          { type: 'text', content: `[${fn.label}] `, style: { bold: true } },
          ...convertInlineElements(inlineSource),
        ]),
      });
    }
  }

  let title = options.title ?? fm.title;
  let consumedHeading = false;
  if (!title && firstIsHeading && blocks[0]?.kind === 'heading' && options.titleFromHeading !== false) {
    title = plainText(blocks[0].elements ?? []);
    blocks.shift();
    consumedHeading = true;
  }
  if (!title) title = options.fallbackTitle ?? '未命名文档';
  title = title.trim().slice(0, 200) || '未命名文档';

  if (parsed.frontmatterError) ctx.warnings.push(parsed.frontmatterError);
  void consumedHeading;

  return { title, frontmatter: fm, blocks, warnings: ctx.warnings };
}

/** 行内节点 → 元素数组（图片被丢弃，适用于表格单元格等场景） */
function convertInlineElements(nodes: PhrasingContent[]): InlineElement[] {
  const out: InlineElement[] = [];
  for (const seg of convertInline(nodes)) {
    if (seg.kind === 'element') out.push(seg.element);
    else if (seg.image.alt) out.push({ type: 'text', content: seg.image.alt, style: { italic: true } });
  }
  return out;
}

export function plainText(elements: InlineElement[] | undefined): string {
  if (!elements) return '';
  return elements
    .map((e) => (e.type === 'text' ? e.content : ` ${e.content} `))
    .join('')
    .trim();
}

function convertAll(nodes: RootContent[], ctx: ConvertContext, options: ConvertOptions): BlockNode[] {
  const out: BlockNode[] = [];
  for (const node of nodes) {
    for (const block of convertNode(node, ctx, options)) out.push(block);
  }
  return out;
}

/** 把一个块级 mdast 节点转换为 0..n 个 BlockNode */
function convertNode(node: RootContent, ctx: ConvertContext, options: ConvertOptions): BlockNode[] {
  switch (node.type) {
    case 'heading': {
      const h = node as Extract<BlockContent, { type: 'heading' }>;
      return [
        {
          kind: 'heading',
          level: Math.min(Math.max(h.depth, 1), 9),
          elements: mergeElements(convertInlineElements(h.children)),
          line: node.position?.start.line,
        },
      ];
    }
    case 'paragraph': {
      const p = node as Extract<BlockContent, { type: 'paragraph' }>;
      return paragraphToBlocks(p.children, ctx);
    }
    case 'code': {
      const c = node as Extract<BlockContent, { type: 'code' }>;
      const langRaw = c.lang ?? '';
      if (langRaw.toLowerCase() === 'mermaid' && options.mermaidMode === 'image') {
        // 渲染为图片：加载失败时在预加载阶段降级回纯文本代码块
        return [
          {
            kind: 'image',
            image: { src: c.value, kind: 'mermaid', alt: 'mermaid' },
            line: node.position?.start.line,
          },
        ];
      }
      const mapped = mapCodeLanguage(langRaw);
      if (mapped === null) {
        ctx.warnings.push(
          langRaw.toLowerCase() === 'mermaid'
            ? `mermaid 代码块按纯文本插入（第 ${node.position?.start.line ?? '?'} 行）；可用 --mermaid image 渲染为图`
            : `飞书暂不支持语言 "${langRaw || '(无)'}" 的代码块，已按纯文本插入（第 ${node.position?.start.line ?? '?'} 行）`,
        );
      }
      return [
        {
          kind: 'code',
          code: { content: c.value, language: mapped ?? 1, rawLanguage: langRaw },
          line: node.position?.start.line,
        },
      ];
    }
    case 'math': {
      const m = node as unknown as { value: string; position?: { start: { line: number } } };
      let latex = m.value.trim();
      if (options.displayStyle !== false && !/^\s*\\displaystyle\b/.test(latex)) {
        latex = `\\displaystyle ${latex}`;
      }
      return [{ kind: 'equation', latex, line: m.position?.start.line }];
    }
    case 'thematicBreak':
      return [{ kind: 'divider', line: node.position?.start.line }];
    case 'blockquote':
      return [blockquoteToBlock(node as Extract<BlockContent, { type: 'blockquote' }>, ctx, options)];
    case 'list':
      return listToBlocks(node as Extract<BlockContent, { type: 'list' }>, ctx, options);
    case 'table':
      return [tableToBlock(node as unknown as TableNode, ctx)];
    case 'html':
      return htmlToBlocks(node as Extract<BlockContent, { type: 'html' }>);
    case 'footnoteDefinition': {
      const f = node as unknown as { label: string };
      ctx.footnotes.push({ label: f.label, node });
      return [];
    }
    case 'yaml':
    case 'definition':
      return [];
    default:
      ctx.warnings.push(`暂不支持的内容类型 "${node.type}"，已跳过`);
      return [];
  }
}

/** 段落 → 文本块 + 独立图片块序列 */
function paragraphToBlocks(children: PhrasingContent[], ctx: ConvertContext): BlockNode[] {
  void ctx;
  const segments = convertInline(children);
  const out: BlockNode[] = [];
  let buffer: InlineElement[] = [];
  const flush = () => {
    const merged = mergeElements(buffer);
    if (merged.length > 0) out.push({ kind: 'text', elements: merged });
    buffer = [];
  };
  for (const seg of segments) {
    if (seg.kind === 'image') {
      flush();
      out.push({ kind: 'image', image: seg.image });
    } else {
      buffer.push(seg.element);
    }
  }
  flush();
  if (out.length === 0) out.push({ kind: 'text', elements: [] });
  return out;
}

function blockquoteToBlock(node: Extract<BlockContent, { type: 'blockquote' }>, ctx: ConvertContext, options: ConvertOptions): BlockNode {
  const children = [...node.children];

  // GFM Alert 检测：> [!NOTE] 等
  const first = children[0];
  if (first && first.type === 'paragraph') {
    const p = first as Extract<BlockContent, { type: 'paragraph' }>;
    const firstText = p.children.find((c) => c.type === 'text') as { type: 'text'; value: string } | undefined;
    const match = firstText?.value.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/is);
    if (match && firstText) {
      const style = ALERT_STYLES[match[1].toUpperCase()];
      // 去掉 marker，保留同一 text 节点的剩余内容
      const rest = match[2];
      const newChildren = [...p.children];
      const idx = newChildren.indexOf(firstText);
      if (rest.trim()) {
        (newChildren as { type: 'text'; value: string }[])[idx] = { type: 'text', value: rest.replace(/^\n+/, '') };
      } else {
        newChildren.splice(idx, 1);
      }
      children[0] = { ...p, children: newChildren } as typeof first;
      const inner = convertAll(children, ctx, options);
      if (inner.length === 0) inner.push({ kind: 'text', elements: [] });
      return { kind: 'callout', callout: style, children: inner, line: node.position?.start.line };
    }
  }

  const inner = convertAll(children, ctx, options);
  if (inner.length === 0) inner.push({ kind: 'text', elements: [] });
  return { kind: 'quote', children: inner, line: node.position?.start.line };
}

function listToBlocks(node: Extract<BlockContent, { type: 'list' }>, ctx: ConvertContext, options: ConvertOptions): BlockNode[] {
  const out: BlockNode[] = [];
  const start = node.start ?? 1;
  node.children.forEach((item, idx) => {
    const first = item.children[0];
    const itemNode: BlockNode = {
      kind: item.checked == null ? (node.ordered ? 'ordered' : 'bullet') : 'todo',
      elements: [],
      children: [],
      line: item.position?.start.line,
    };
    if (itemNode.kind === 'todo') itemNode.done = item.checked === true;
    if (itemNode.kind === 'ordered' && idx === 0) itemNode.orderedStart = start;

    const rest: RootContent[] = [];
    if (first && first.type === 'paragraph') {
      const p = first as Extract<BlockContent, { type: 'paragraph' }>;
      const segments = convertInline(p.children);
      const els: InlineElement[] = [];
      for (const seg of segments) {
        if (seg.kind === 'image') {
          // 列表项内的图片：作为列表项的子块
          itemNode.children!.push({ kind: 'image', image: seg.image });
        } else {
          els.push(seg.element);
        }
      }
      itemNode.elements = mergeElements(els);
      rest.push(...item.children.slice(1));
    } else {
      rest.push(...item.children);
    }
    if (!itemNode.elements || itemNode.elements.length === 0) {
      itemNode.elements = [{ type: 'text', content: '', style: {} }];
    }
    for (const child of rest) {
      itemNode.children!.push(...convertNode(child, ctx, options));
    }
    out.push(itemNode);
  });
  return out;
}

interface TableNode {
  children: TableRowAst[];
  position?: { start: { line: number } };
}
interface TableRowAst {
  type: 'tableRow';
  children: TableCellAst[];
}
interface TableCellAst {
  type: 'tableCell';
  children: PhrasingContent[];
}

function tableToBlock(node: TableNode, ctx: ConvertContext): BlockNode {
  void ctx;
  const rows = node.children.length;
  const cols = Math.max(...node.children.map((r) => r.children.length), 1);
  const cells: BlockNode[][] = [];
  const colTextLen: number[] = new Array(cols).fill(0);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = node.children[r].children[c];
      const elements = cell ? mergeElements(convertInlineElements(cell.children)) : [];
      const text = plainText(elements);
      colTextLen[c] = Math.max(colTextLen[c], visualWidth(text));
      cells.push([{ kind: 'text', elements }]);
    }
  }

  const columnWidths = colTextLen.map((w) => Math.min(320, Math.max(96, 36 + w * 9)));
  return {
    kind: 'table',
    rows,
    cols,
    cells,
    columnWidths,
    line: node.position?.start.line,
  };
}

/** 粗略可视宽度：CJK 记 2，其他记 1 */
function visualWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return w;
}

function htmlToBlocks(node: Extract<BlockContent, { type: 'html' }>): BlockNode[] {
  const value = node.value ?? '';
  if (/^\s*<!--[\s\S]*-->\s*$/.test(value)) return [];
  if (/^<br\s*\/?\s*>$/i.test(value.trim())) return [{ kind: 'text', elements: [{ type: 'text', content: '\n', style: {} }] }];
  const imgs = [...value.matchAll(/<img\b[^>]*>/gi)];
  if (imgs.length > 0) {
    return imgs
      .map((m) => {
        const src = m[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
        const alt = m[0].match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1];
        return src ? ({ kind: 'image', image: describeImage(src, alt ?? '', undefined) } as BlockNode) : null;
      })
      .filter((b): b is BlockNode => b !== null);
  }
  return [];
}
