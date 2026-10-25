import { describe, it, expect } from 'vitest';
import {
  sanitizeConvertBlocks,
  planOfficialBatches,
  extractImageSources,
} from '../src/engine-official.js';
import type { ConvertBlock } from '../src/api/endpoints.js';

const convertBlocks: ConvertBlock[] = [
  {
    block_id: 'root1',
    block_type: 2,
    parent_id: '',
    revision_id: 0,
    children: [],
    text: { style: { folded: false, align: 1 }, elements: [{ text_run: { content: 'hello', text_element_style: {} } }] },
  },
  {
    block_id: 'table1',
    block_type: 31,
    parent_id: '',
    revision_id: 0,
    children: ['cell1', 'cell2'],
    table: {
      property: {
        row_size: 1,
        column_size: 2,
        column_width: [100, 100],
        header_row: true,
        merge_info: [{ row_span: 1, col_span: 1 }, { row_span: 1, col_span: 1 }],
      },
    },
  },
  { block_id: 'cell1', block_type: 32, parent_id: 'table1', revision_id: 0, children: ['c1t'], table_cell: {} },
  { block_id: 'cell2', block_type: 32, parent_id: 'table1', revision_id: 0, children: ['c2t'], table_cell: {} },
  {
    block_id: 'c1t',
    block_type: 2,
    parent_id: 'cell1',
    revision_id: 0,
    children: [],
    text: { style: {}, elements: [{ text_run: { content: 'A' } }] },
  },
  {
    block_id: 'c2t',
    block_type: 2,
    parent_id: 'cell2',
    revision_id: 0,
    children: [],
    text: { style: {}, elements: [{ text_run: { content: 'B' } }] },
  },
  { block_id: 'img1', block_type: 27, parent_id: '', revision_id: 0, children: [], image: { width: 100, height: 50 } },
];

describe('sanitizeConvertBlocks', () => {
  it('剥离 revision_id/parent_id，删除表格 merge_info，保留实体与 children', () => {
    const map = sanitizeConvertBlocks(convertBlocks);
    const table = map.get('table1') as unknown as { table: { property: Record<string, unknown> }; children: string[] };
    expect(table.table.property.merge_info).toBeUndefined();
    expect(table.table.property.row_size).toBe(1);
    expect(table.table.property.header_row).toBe(true);
    expect(table.children).toEqual(['cell1', 'cell2']);
    expect((map.get('root1') as unknown as Record<string, unknown>).revision_id).toBeUndefined();
    expect((map.get('root1') as unknown as { text: unknown }).text).toBeTruthy();
  });
});

describe('planOfficialBatches', () => {
  it('按顶层子树分批并统计图片', () => {
    const map = sanitizeConvertBlocks(convertBlocks);
    const batches = planOfficialBatches(['root1', 'table1', 'img1'], map);
    expect(batches).toHaveLength(1);
    expect(batches[0].childrenId).toEqual(['root1', 'table1', 'img1']);
    expect(batches[0].descendants).toHaveLength(7);
    expect(batches[0].imageIds).toEqual(['img1']);
  });

  it('大量子树时按 900/18 限额拆批', () => {
    const many: ConvertBlock[] = Array.from({ length: 25 }, (_, i) => ({
      block_id: `img${i}`,
      block_type: 27,
      children: [],
      image: {},
    }));
    const map = sanitizeConvertBlocks(many);
    const batches = planOfficialBatches(many.map((b) => b.block_id), map);
    expect(batches.length).toBe(2);
    expect(batches[0].imageIds).toHaveLength(18);
    expect(batches[1].imageIds).toHaveLength(7);
  });
});

describe('extractImageSources', () => {
  it('按顺序提取 Markdown 图片 src（含标题写法）', () => {
    const md = '前 ![a](./x.png) 中 ![b](https://y.com/z.jpg "标题") 后';
    expect(extractImageSources(md)).toEqual(['./x.png', 'https://y.com/z.jpg']);
  });
});
