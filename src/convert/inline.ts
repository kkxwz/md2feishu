import type { PhrasingContent } from 'mdast';
import type { InlineElement, TextStyle, ImageSource } from '../types.js';

/** 行内转换结果：元素序列，图片会被拆出来作为独立段落级块 */
export type InlineSegment =
  | { kind: 'element'; element: InlineElement }
  | { kind: 'image'; image: ImageSource };

/**
 * 把 mdast 行内节点展开为「文本元素 + 图片」序列。
 * 样式（加粗/斜体/删除线/行内代码/链接）通过 style 参数向下传递并合并。
 */
export function convertInline(
  nodes: PhrasingContent[],
  style: TextStyle = {},
): InlineSegment[] {
  const out: InlineSegment[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ kind: 'element', element: { type: 'text', content: node.value, style: { ...style } } });
        break;
      case 'emphasis':
        out.push(...convertInline(node.children, { ...style, italic: true }));
        break;
      case 'strong':
        out.push(...convertInline(node.children, { ...style, bold: true }));
        break;
      case 'delete':
        out.push(...convertInline(node.children, { ...style, strikethrough: true }));
        break;
      case 'inlineCode':
        out.push({
          kind: 'element',
          element: { type: 'text', content: node.value, style: { ...style, inlineCode: true } },
        });
        break;
      case 'link':
        out.push(...convertInline(node.children, { ...style, linkUrl: node.url }));
        break;
      case 'image': {
        out.push({ kind: 'image', image: describeImage(node.url ?? '', node.alt ?? '', node.title) });
        break;
      }
      case 'break':
        out.push({ kind: 'element', element: { type: 'text', content: '\n', style: {} } });
        break;
      case 'inlineMath': {
        const latex = (node as unknown as { value: string }).value;
        out.push({ kind: 'element', element: { type: 'equation', content: latex } });
        break;
      }
      case 'footnoteReference':
        out.push({ kind: 'element', element: { type: 'text', content: `[${node.label ?? '^'}]`, style: {} } });
        break;
      case 'html': {
        const value = node.value ?? '';
        if (/^<br\s*\/?\s*>$/i.test(value.trim())) {
          out.push({ kind: 'element', element: { type: 'text', content: '\n', style: {} } });
        } else {
          const imgMatch = value.match(/^<img\b[^>]*>/i);
          if (imgMatch) {
            const src = imgMatch[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
            const alt = imgMatch[0].match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1];
            if (src) out.push({ kind: 'image', image: describeImage(src, alt ?? '', undefined) });
          }
          // 其余行内 HTML 标签（<b> 等）丢弃，保留相邻文本节点
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export function describeImage(url: string, alt: string, _title?: string | null): ImageSource {
  const src = url.trim();
  if (src.startsWith('data:')) {
    return { src, kind: 'data', alt };
  }
  if (/^https?:\/\//i.test(src)) {
    return { src, kind: 'remote', alt };
  }
  if (src.startsWith('//')) {
    return { src: `https:${src}`, kind: 'remote', alt };
  }
  return { src, kind: 'local', path: decodeURIComponent(src), alt };
}

/** 合并相邻同样式文本元素，压缩空内容 */
export function mergeElements(elements: InlineElement[]): InlineElement[] {
  const merged: InlineElement[] = [];
  for (const el of elements) {
    if (el.type === 'text' && el.content === '') continue;
    const last = merged[merged.length - 1];
    if (
      el.type === 'text' &&
      last &&
      last.type === 'text' &&
      sameStyle(last.style, el.style)
    ) {
      last.content += el.content;
    } else {
      merged.push({ ...el, ...(el.type === 'text' ? { style: { ...el.style } } : {}) });
    }
  }
  return merged;
}

function sameStyle(a: TextStyle, b: TextStyle): boolean {
  const keys: (keyof TextStyle)[] = ['bold', 'italic', 'strikethrough', 'underline', 'inlineCode', 'linkUrl'];
  return keys.every((k) => a[k] === b[k]);
}
