import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/convert/parse.js';
import { convertDocument } from '../src/convert/blocks.js';
import { planBatches } from '../src/publisher.js';
import type { DescendantPayload } from '../src/api/endpoints.js';

function payloadsOf(md: string) {
  const doc = convertDocument(parseMarkdown(md), { fallbackTitle: 't', titleFromHeading: false });
  const batches = planBatches(doc.blocks);
  return batches;
}

function allDescendants(md: string): DescendantPayload[] {
  return payloadsOf(md).flatMap((b) => b.descendants);
}

describe('planBatches payload 结构', () => {
  it('标题与文本块的 payload 形状', () => {
    const list = allDescendants('# T\n\n正文 **粗**');
    const heading = list.find((b) => b.block_type === 3);
    expect(heading?.heading1).toMatchObject({
      elements: [{ text_run: { content: 'T' } }],
    });
    const text = list.find((b) => b.block_type === 2);
    expect(text?.text).toMatchObject({
      elements: [
        { text_run: { content: '正文 ' } },
        { text_run: { content: '粗', text_element_style: { bold: true } } },
      ],
    });
  });

  it('链接 URL 被编码', () => {
    const list = allDescendants('[点我](https://a.b/c?x=1&y=2)');
    const text = list.find((b) => b.block_type === 2) as unknown as {
      text: { elements: { text_run: { text_element_style: { link: { url: string } } } }[] };
    };
    expect(text.text.elements[0].text_run.text_element_style.link.url).toBe(
      encodeURIComponent('https://a.b/c?x=1&y=2'),
    );
  });

  it('表格：cells 为 table_cell 子块，单元格内容为文本块，header_row 打开', () => {
    const list = allDescendants('| A | B |\n| --- | --- |\n| 1 | 2 |');
    const table = list.find((b) => b.block_type === 31) as unknown as {
      children: string[];
      table: { property: { row_size: number; column_size: number; header_row: boolean; column_width: number[] } };
    };
    expect(table.table.property).toMatchObject({ row_size: 2, column_size: 2, header_row: true });
    expect(table.table.property.column_width).toHaveLength(2);
    expect(table.children).toHaveLength(4);
    const cellIds = new Set(table.children);
    const cells = list.filter((b) => b.block_type === 32);
    expect(cells).toHaveLength(4);
    for (const cell of cells) expect(cellIds.has(cell.block_id)).toBe(true);
    const contents = list.filter((b) => b.block_type === 2);
    expect(contents).toHaveLength(4);
    for (const c of cells) {
      expect(c.children).toHaveLength(1);
    }
  });

  it('callout payload：配色 + emoji_id + 子块', () => {
    const list = allDescendants('> [!TIP]\n> 好提示');
    const callout = list.find((b) => b.block_type === 19) as unknown as {
      callout: { background_color: number; border_color: number; emoji_id: string };
      children: string[];
    };
    expect(callout.callout).toEqual({ background_color: 4, border_color: 4, emoji_id: 'white_check_mark' });
    expect(callout.children.length).toBeGreaterThan(0);
    const child = list.find((b) => b.block_id === callout.children[0]);
    expect(child?.block_type).toBe(2);
  });

  it('引用容器 payload：quote_container 空结构体 + 子块', () => {
    const list = allDescendants('> 引用');
    const quote = list.find((b) => b.block_type === 34) as unknown as { quote_container: unknown; children: string[] };
    expect(quote.quote_container).toEqual({});
    expect(list.find((b) => b.block_id === quote.children[0])?.block_type).toBe(2);
  });

  it('代码块：language + wrap', () => {
    const list = allDescendants('```python\nprint(1)\n```');
    const code = list.find((b) => b.block_type === 14) as unknown as {
      code: { elements: { text_run: { content: string } }[]; style: { language: number } };
    };
    expect(code.code.elements[0].text_run.content).toBe('print(1)');
    expect(code.code.style.language).toBe(49);
  });

  it('待办与有序列表样式', () => {
    const list = allDescendants('- [x] 完成');
    const todo = list.find((b) => b.block_type === 17) as unknown as { todo: { style: { done: boolean } } };
    expect(todo.todo.style.done).toBe(true);

    const list2 = allDescendants('5. 第五');
    const ordered = list2.find((b) => b.block_type === 13) as unknown as { ordered: { style: { sequence?: string } } };
    expect(ordered.ordered.style.sequence).toBe('5');
  });

  it('分割线与公式块', () => {
    const list = allDescendants('---\n\n$$E=mc^2$$');
    expect(list.find((b) => b.block_type === 22)?.divider).toEqual({});
    const eq = list.find((b) => b.block_type === 2 && (b as { text?: { elements?: unknown[] } }).text?.elements?.[0]
      ? ((b as { text: { elements: { equation?: { content: string } }[] } }).text.elements[0].equation?.content === '\\displaystyle E=mc^2')
      : false);
    expect(eq).toBeTruthy();
  });

  it('图片块：空 image 实体 + 尺寸', () => {
    const md = '![](a.png)';
    const doc = convertDocument(parseMarkdown(md), { fallbackTitle: 't' });
    doc.blocks[0].imageWidth = 1000;
    doc.blocks[0].imageHeight = 500;
    const [batch] = planBatches(doc.blocks);
    const img = batch.descendants.find((b) => b.block_type === 27) as unknown as { image: { width?: number; height?: number } };
    expect(img.image).toEqual({ width: 780, height: 390 });
    expect(batch.imageRefs).toHaveLength(1);
  });
});

describe('planBatches 分批策略', () => {
  it('超过 900 块自动拆分为多批，children_id 只含顶层', () => {
    const md = Array.from({ length: 1000 }, (_, i) => `段落 ${i}`).join('\n\n');
    const doc = convertDocument(parseMarkdown(md), { fallbackTitle: 't' });
    const batches = planBatches(doc.blocks);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      expect(b.descendants.length).toBeLessThanOrEqual(900);
      expect(b.childrenId.length).toBeGreaterThan(0);
      // children_id 全部出现在 descendants 中
      const ids = new Set(b.descendants.map((d) => d.block_id));
      for (const id of b.childrenId) expect(ids.has(id)).toBe(true);
    }
    const total = batches.reduce((s, b) => s + b.descendants.length, 0);
    expect(total).toBe(1000);
  });

  it('图片超过 18 张按图片上限拆批', () => {
    const md = Array.from({ length: 25 }, (_, i) => `![](img${i}.png)`).join('\n\n');
    const doc = convertDocument(parseMarkdown(md), { fallbackTitle: 't' });
    const batches = planBatches(doc.blocks);
    expect(batches.length).toBe(2);
    expect(batches[0].imageRefs.length).toBe(18);
    expect(batches[1].imageRefs.length).toBe(7);
  });

  it('临时 block_id 全局唯一', () => {
    const list = allDescendants('# T\n\n- a\n  - b\n\n| A | B |\n| - | - |\n| 1 | 2 |');
    const ids = list.map((b) => b.block_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
