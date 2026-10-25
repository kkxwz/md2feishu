import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
import { parse as parseYaml } from 'yaml';
import type { Root, RootContent } from 'mdast';
import type { Frontmatter } from '../types.js';

export interface ParsedMarkdown {
  frontmatter: Frontmatter;
  /** 去掉 front-matter 节点后的 mdast */
  mdast: Root;
  frontmatterError?: string;
}

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkMath);

/**
 * 预处理：把「独立成行的单行块级公式 `$$...$$`」归一化为多行形式。
 * remark-math 只把多行（或前后空行包围的）$$ 识别为块级 math，
 * 单行会被误判为行内公式；这里统一改写，并跳过代码围栏内的行。
 */
function normalizeBlockMath(src: string): string {
  const lines = src.split('\n');
  let inFence = false;
  let fenceMarker = '';
  let processed = false;
  const out = lines.map((line) => {
    const fence = line.match(/^ {0,3}(```+|~~~+)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1].slice(0, 3);
      } else if (fence[1].startsWith(fenceMarker)) {
        inFence = false;
      }
      return line;
    }
    if (inFence) return line;
    const m = line.match(/^\$\$[ \t]*(\S.*?)[ \t]*\$\$$/);
    if (m) {
      processed = true;
      return `$$\n${m[1]}\n$$`;
    }
    return line;
  });
  return processed ? out.join('\n') : src;
}

export function parseMarkdown(markdown: string): ParsedMarkdown {
  const root = processor.parse(normalizeBlockMath(markdown));
  let frontmatter: Frontmatter = {};
  let frontmatterError: string | undefined;
  const content: RootContent[] = [];
  for (const node of root.children) {
    if ((node as { type?: string }).type === 'yaml') {
      const raw = (node as unknown as { value: string }).value;
      try {
        const parsed = parseYaml(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          frontmatter = parsed as Frontmatter;
        }
      } catch (err) {
        frontmatterError = `front-matter YAML 解析失败：${(err as Error).message}`;
      }
      continue;
    }
    content.push(node);
  }
  return {
    frontmatter,
    frontmatterError,
    mdast: { ...root, children: content },
  };
}
