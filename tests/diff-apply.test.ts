import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/convert/parse.js';
import { convertDocument } from '../src/convert/blocks.js';
import { applyDiffUpdate } from '../src/diff.js';
import { FeishuClient } from '../src/api/client.js';

interface Call {
  method: string;
  path: string;
  body?: unknown;
  query?: string;
}

/** 构造带脚本的假飞书后端 */
function makeScriptedBackend(existingItems: unknown[]) {
  const calls: Call[] = [];
  let descendantRelations: { block_id: string; temporary_block_id: string }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body, query: url.search });
    const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { headers: { 'Content-Type': 'application/json' } });
    if (url.pathname.includes('tenant_access_token')) {
      // token 接口的字段在顶层，不在 data 里
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-1', expire: 3600 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'GET' && url.pathname.endsWith('/blocks')) {
      return json({ items: existingItems, has_more: false });
    }
    if (method === 'POST' && url.pathname.includes('/descendant')) {
      const relations = body?.children_id?.map((id: string, i: number) => ({ block_id: `real_${i}_${id}`, temporary_block_id: id })) ?? [];
      descendantRelations = relations;
      return json({ block_id_relations: relations, document_revision_id: 99 });
    }
    if (method === 'DELETE') return json({ document_revision_id: 100 });
    if (method === 'PATCH') return json({ document_revision_id: 101 });
    void descendantRelations;
    return json({});
  };
  return {
    calls,
    client: new FeishuClient({ appId: 'a', appSecret: 's', fetchImpl, minIntervalMs: 0, uploadIntervalMs: 0 }),
  };
}

const textBlock = (id: string, content: string, children: string[] = []) => ({
  block_id: id,
  parent_id: 'DOCPAGE',
  children,
  block_type: 2,
  text: { style: { align: 1 }, elements: [{ text_run: { content, text_element_style: {} } }] },
});

const page = (children: string[]) => ({
  block_id: 'DOCPAGE',
  parent_id: '',
  children,
  block_type: 1,
  page: { style: {}, elements: [] },
});

function blocksOf(md: string) {
  return convertDocument(parseMarkdown(md), { fallbackTitle: 't', titleFromHeading: false }).blocks;
}

describe('applyDiffUpdate（脚本化后端）', () => {
  it('中间块变化 → 原位补丁，不动首尾块', async () => {
    const backend = makeScriptedBackend([page(['t1', 't2', 't3']), textBlock('t1', '甲'), textBlock('t2', '乙'), textBlock('t3', '丙')]);
    const summary = await applyDiffUpdate(backend.client, 'DOCPAGE', blocksOf('甲\n\n乙二\n\n丙'), () => {});

    expect(summary.kept).toBe(2);
    expect(summary.patched).toBe(1);
    expect(summary.deleted).toBe(0);
    expect(summary.inserted).toBe(0);

    const patch = backend.calls.find((c) => c.method === 'PATCH');
    expect(patch).toBeTruthy();
    expect((patch!.body as { update_text_elements: { elements: { text_run: { content: string } }[] } }).update_text_elements.elements[0].text_run.content).toBe('乙二');
    expect(backend.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(backend.calls.some((c) => c.method === 'POST' && c.path.includes('descendant'))).toBe(false);
  });

  it('首块删除+尾部新增 → 删除区间正确；尾部插入先于头部删除应用（index=末尾）', async () => {
    const backend = makeScriptedBackend([page(['t1', 't2']), textBlock('t1', '旧'), textBlock('t2', '保留')]);
    const summary = await applyDiffUpdate(backend.client, 'DOCPAGE', blocksOf('保留\n\n新结尾'), () => {});

    expect(summary.kept).toBe(1);
    expect(summary.deleted).toBe(1);
    expect(summary.inserted).toBe(1);

    const del = backend.calls.find((c) => c.method === 'DELETE')!;
    expect(del.body).toEqual({ start_index: 0, end_index: 1 });

    // 降序应用：先在末尾（index=2）插入，再删除头部，最终顺序为 [保留, 新结尾]
    const ins = backend.calls.find((c) => c.method === 'POST' && c.path.includes('descendant'))!;
    expect(ins.body).toMatchObject({ index: 2 });
    expect((ins.body as { children_id: string[] }).children_id).toHaveLength(1);
    expect(backend.calls.indexOf(ins)).toBeLessThan(backend.calls.indexOf(del));
  });

  it('完全相同 → 不产生任何写请求（token 请求除外）', async () => {
    const backend = makeScriptedBackend([page(['t1']), textBlock('t1', '一样')]);
    const summary = await applyDiffUpdate(backend.client, 'DOCPAGE', blocksOf('一样'), () => {});
    expect(summary.kept).toBe(1);
    expect(summary.patched + summary.deleted + summary.inserted).toBe(0);
    const writes = backend.calls.filter((c) => c.method !== 'GET' && !c.path.includes('tenant_access_token'));
    expect(writes).toHaveLength(0);
  });

  it('代码块语言变化 → patch 携带 update_text_style.language', async () => {
    const backend = makeScriptedBackend([
      page(['c1']),
      {
        block_id: 'c1', parent_id: 'DOCPAGE', children: [], block_type: 14,
        code: { style: { language: 49, wrap: true }, elements: [{ text_run: { content: 'print(1)' } }] },
      },
    ]);
    const summary = await applyDiffUpdate(backend.client, 'DOCPAGE', blocksOf('```javascript\nprint(1)\n```'), () => {});
    expect(summary.patched).toBe(1);
    const patch = backend.calls.find((c) => c.method === 'PATCH')!;
    const body = patch.body as { update_text_style?: { style: { language?: number }; fields: number[] } };
    expect(body.update_text_style?.style.language).toBe(30);
    expect(body.update_text_style?.fields).toContain(4);
  });
});
