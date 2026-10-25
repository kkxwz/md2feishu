import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/convert/parse.js';
import { convertDocument } from '../src/convert/blocks.js';

function conv(md: string, opts?: Parameters<typeof convertDocument>[1]) {
  return convertDocument(parseMarkdown(md), opts);
}

describe('convertDocument', () => {
  it('首个 H1 作为标题并从正文移除', () => {
    const doc = conv('# 我是一级标题\n\n正文段落');
    expect(doc.title).toBe('我是一级标题');
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]).toMatchObject({ kind: 'text' });
  });

  it('--keep-h1 时保留首个标题在正文', () => {
    const doc = conv('# 标题\n\n正文', { titleFromHeading: false, fallbackTitle: 'f' });
    expect(doc.title).toBe('f');
    expect(doc.blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
  });

  it('标题层级 2-6 正确映射', () => {
    const doc = conv('## 二级\n\n#### 四级', { titleFromHeading: false, fallbackTitle: 'f' });
    expect(doc.blocks[0]).toMatchObject({ kind: 'heading', level: 2 });
    expect(doc.blocks[1]).toMatchObject({ kind: 'heading', level: 4 });
  });

  it('行内样式：加粗/斜体/删除线/行内代码/链接组合', () => {
    const doc = conv('**粗** *斜* ~~删~~ `code` [文字](https://a.b/c?x=1)');
    const els = doc.blocks[0].elements!;
    const by = (content: string) => els.find((e) => e.type === 'text' && e.content === content)!;
    expect(by('粗')).toMatchObject({ style: { bold: true } });
    expect(by('斜')).toMatchObject({ style: { italic: true } });
    expect(by('删')).toMatchObject({ style: { strikethrough: true } });
    expect(by('code')).toMatchObject({ style: { inlineCode: true } });
    expect(by('文字')).toMatchObject({ style: { linkUrl: 'https://a.b/c?x=1' } });
  });

  it('嵌套样式合并到同一 run', () => {
    const doc = conv('**[链接](https://x.y) 斜体加粗**');
    const els = doc.blocks[0].elements!;
    expect(els[0]).toMatchObject({ content: '链接', style: { bold: true, linkUrl: 'https://x.y' } });
  });

  it('代码块语言映射与未知语言降级告警', () => {
    const ok = conv('```ts\nconst a=1\n```');
    expect(ok.blocks[0].code).toMatchObject({ language: 63, rawLanguage: 'ts' });
    const bad = conv('```notalang\nx\n```');
    expect(bad.blocks[0].code!.language).toBe(1);
    expect(bad.warnings.some((w) => w.includes('notalang'))).toBe(true);
  });

  it('mermaid 代码块降级为纯文本并告警', () => {
    const doc = conv('```mermaid\ngraph TD; A-->B;\n```');
    expect(doc.blocks[0].code!.language).toBe(1);
    expect(doc.warnings.some((w) => w.includes('mermaid'))).toBe(true);
  });

  it('行内公式 → equation 元素', () => {
    const doc = conv('质能方程 $E=mc^2$ 结束');
    const els = doc.blocks[0].elements!;
    expect(els[1]).toEqual({ type: 'equation', content: 'E=mc^2' });
  });

  it('块级公式 → 仅含公式元素的文本块，默认加 \\displaystyle', () => {
    const doc = conv('$$\n\\int_0^1 x dx\n$$');
    expect(doc.blocks[0]).toMatchObject({ kind: 'equation', latex: '\\displaystyle \\int_0^1 x dx' });
  });

  it('已有 \\displaystyle 不重复添加；displayStyle:false 关闭前缀', () => {
    const doc = conv('$$\n\\displaystyle \\sum_i a_i\n$$');
    expect(doc.blocks[0].latex).toBe('\\displaystyle \\sum_i a_i');
    const off = conv('$$\n\\int x\n$$', { displayStyle: false });
    expect(off.blocks[0].latex).toBe('\\int x');
  });

  it('单行 $$...$$ 识别为块级公式（而非行内）', () => {
    const doc = conv('$$x^2$$');
    expect(doc.blocks[0]).toMatchObject({ kind: 'equation', latex: '\\displaystyle x^2' });
    // 行内 $...$ 不受影响
    const doc2 = conv('值 $x^2$ 结束');
    expect(doc2.blocks[0].elements![1]).toEqual({ type: 'equation', content: 'x^2' });
  });

  it('代码围栏内的 $$ 行不被改写', () => {
    const doc = conv('```text\n$$not math$$\n```');
    expect(doc.blocks[0].code!.content).toContain('$$not math$$');
  });

  it('任务列表 done 状态', () => {
    const doc = conv('- [x] 完成\n- [ ] 未完成');
    expect(doc.blocks[0]).toMatchObject({ kind: 'todo', done: true });
    expect(doc.blocks[1]).toMatchObject({ kind: 'todo', done: false });
  });

  it('有序列表起始编号只在首项设置，无序列表不设置', () => {
    const doc = conv('3. 三\n3. 四\n\n- 甲\n- 乙');
    expect(doc.blocks[0]).toMatchObject({ kind: 'ordered', orderedStart: 3 });
    expect(doc.blocks[1].orderedStart).toBeUndefined();
    expect(doc.blocks[2]).toMatchObject({ kind: 'bullet' });
  });

  it('嵌套列表成为列表项子块', () => {
    const doc = conv('- 一级\n  - 二级\n    - 三级');
    const l1 = doc.blocks[0];
    expect(l1.kind).toBe('bullet');
    const l2 = l1.children![0];
    expect(l2.kind).toBe('bullet');
    expect(l2.children![0].kind).toBe('bullet');
  });

  it('引用块 → quote 容器包含子块', () => {
    const doc = conv('> 引用第一行\n> 引用第二行');
    expect(doc.blocks[0]).toMatchObject({ kind: 'quote' });
    expect(doc.blocks[0].children![0]).toMatchObject({ kind: 'text' });
  });

  it('GFM Alert → callout（emoji/配色），marker 被剥离', () => {
    const doc = conv('> [!WARNING]\n> 注意内容');
    const b = doc.blocks[0];
    expect(b.kind).toBe('callout');
    expect(b.callout).toEqual({ emoji: 'rotating_light', backgroundColor: 3, borderColor: 3 });
    expect(b.children![0].elements![0]).toMatchObject({ content: '注意内容' });
  });

  it('五种 Alert 类型全部映射', () => {
    for (const [tag, emoji] of [
      ['NOTE', 'bulb'],
      ['TIP', 'white_check_mark'],
      ['IMPORTANT', 'exclamation'],
      ['WARNING', 'rotating_light'],
      ['CAUTION', 'no_entry_sign'],
    ] as const) {
      const doc = conv(`> [!${tag}]\n> 内容`);
      expect(doc.blocks[0].callout!.emoji).toBe(emoji);
    }
  });

  it('表格：行列、单元格元素、列宽', () => {
    const doc = conv('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |');
    const t = doc.blocks[0];
    expect(t).toMatchObject({ kind: 'table', rows: 2, cols: 2 });
    expect(t.cells).toHaveLength(4);
    expect(t.cells![0][0].elements![0]).toMatchObject({ content: '甲' });
    expect(t.cells![3][0].elements![0]).toMatchObject({ content: '2' });
    expect(t.columnWidths).toHaveLength(2);
    expect(t.columnWidths![0]).toBeGreaterThan(0);
  });

  it('段落中的图片拆分为独立图片块，前后文本保留', () => {
    const doc = conv('前文 ![alt](./a.png) 后文');
    expect(doc.blocks).toHaveLength(3);
    expect(doc.blocks[0]).toMatchObject({ kind: 'text' });
    expect(doc.blocks[1]).toMatchObject({ kind: 'image', image: { kind: 'local', path: './a.png', alt: 'alt' } });
    expect(doc.blocks[2].elements![0]).toMatchObject({ content: ' 后文' });
  });

  it('远程图片与 data URI 识别', () => {
    const doc = conv('![](https://cdn.x.com/i.png)');
    expect(doc.blocks[0].image).toMatchObject({ kind: 'remote' });
    const doc2 = conv('![](data:image/png;base64,AAAA)');
    expect(doc2.blocks[0].image).toMatchObject({ kind: 'data' });
  });

  it('硬换行 → 文本中的 \\n', () => {
    const doc = conv('第一行  \n第二行');
    expect(doc.blocks[0].elements![0].content).toContain('\n');
  });

  it('分割线 → divider', () => {
    const doc = conv('---');
    expect(doc.blocks[0].kind).toBe('divider');
  });

  it('front-matter：title 与 folder 解析', () => {
    const doc = conv('---\ntitle: 自定义标题\nfolder: fld123\n---\n\n正文');
    expect(doc.title).toBe('自定义标题');
    expect(doc.frontmatter.folder).toBe('fld123');
  });

  it('front-matter 错误时降级并告警', () => {
    const doc = conv('---\ntitle: [broken\n---\n\n正文');
    expect(doc.title).toBe('未命名文档');
    expect(doc.warnings.some((w) => w.includes('front-matter'))).toBe(true);
  });

  it('脚注：引用保留为 [label]，定义追加到文末', () => {
    const doc = conv('一句话[^1]。\n\n[^1]: 脚注内容');
    // 引用与前后同样式文本合并为一个 run
    expect(doc.blocks[0].elements![0]).toMatchObject({ content: '一句话[1]。' });
    const last = doc.blocks[doc.blocks.length - 1];
    expect(last.kind).toBe('bullet');
    expect(last.elements![0]).toMatchObject({ content: '[1] ', style: { bold: true } });
    expect(last.elements![1]).toMatchObject({ content: '脚注内容' });
  });

  it('引用内嵌套列表', () => {
    const doc = conv('> - 项目一\n> - 项目二');
    expect(doc.blocks[0].kind).toBe('quote');
    expect(doc.blocks[0].children![0].kind).toBe('bullet');
  });
});
