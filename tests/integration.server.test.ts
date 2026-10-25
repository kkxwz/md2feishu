import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { publishDocument } from '../src/publisher.js';
import { FeishuClient } from '../src/api/client.js';
import { parseMarkdown } from '../src/convert/parse.js';
import { convertDocument } from '../src/convert/blocks.js';
import { resolve } from 'node:path';

/**
 * 本地 mock 飞书服务器：还原文档/块/图片相关接口的行为，
 * 在不依赖真实凭证的情况下跑通「创建 → 写块 → 图片上传替换 → diff 更新」全链路。
 */

interface MockBlock {
  block_id: string;
  parent_id: string;
  children: string[];
  block_type: number;
  entity: Record<string, unknown> | null;
  deleted?: boolean;
}

interface MockDoc {
  title: string;
  blocks: Map<string, MockBlock>;
  pageId: string;
  idCounter: number;
}

const docs = new Map<string, MockDoc>();
let uploadCount = 0;
const uploads: { parentType: string; parentNode: string }[] = [];

function entityOf(blockType: number, body: Record<string, unknown>): Record<string, unknown> | null {
  const keys: Record<number, string> = {
    2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4', 7: 'heading5',
    8: 'heading6', 9: 'heading7', 10: 'heading8', 11: 'heading9',
    12: 'bullet', 13: 'ordered', 14: 'code', 15: 'quote', 17: 'todo',
    19: 'callout', 22: 'divider', 27: 'image', 31: 'table', 32: 'table_cell', 34: 'quote_container',
  };
  const key = keys[blockType];
  if (!key) return null;
  const value = body[key];
  return value === undefined ? null : (value as Record<string, unknown>);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolveBody) => {
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
  });
}

function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req: IncomingRequest, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const send = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (path.includes('tenant_access_token')) {
      return send({ code: 0, tenant_access_token: 't-mock', expire: 3600 });
    }

    const docMatch = path.match(/\/open-apis\/docx\/v1\/documents\/([^/]+)/);
    const docId = docMatch?.[1];
    const doc = docId ? docs.get(docId) : undefined;

    if (req.method === 'POST' && path === '/open-apis/docx/v1/documents') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const id = `doxcnMOCK${docs.size + 1000}`;
      const pageId = id; // page 块 id 与 document_id 相同（与飞书一致）
      const doc2: MockDoc = { title: body.title ?? '', blocks: new Map(), pageId, idCounter: 0 };
      doc2.blocks.set(pageId, { block_id: pageId, parent_id: '', children: [], block_type: 1, entity: { style: {}, elements: [{ text_run: { content: doc2.title } }] } });
      docs.set(id, doc2);
      return send({ code: 0, data: { document: { document_id: id, title: doc2.title, revision_id: 1 } } });
    }

    if (req.method === 'POST' && path.endsWith('/medias/upload_form')) {
      uploadCount++;
      const raw = (await readBody(req)).toString('latin1');
      const parentType = raw.match(/name="parent_type"\r?\n\r?\n([^\r\n]+)/)?.[1] ?? '';
      const parentNode = raw.match(/name="parent_node"\r?\n\r?\n([^\r\n]+)/)?.[1] ?? '';
      uploads.push({ parentType, parentNode });
      return send({ code: 0, data: { file_token: `file_mock_${uploadCount}` } });
    }

    if (!doc) return send({ code: 1770002, msg: 'doc not found' }, 404);

    if (req.method === 'GET' && docMatch && path.endsWith('/blocks')) {
      const items = [...doc.blocks.values()].filter((b) => !b.deleted).map((b) => ({
        block_id: b.block_id,
        parent_id: b.parent_id,
        children: b.children.slice(),
        block_type: b.block_type,
        ...(b.entity ? entityPayload(b) : {}),
      }));
      return send({ code: 0, data: { items, has_more: false } });
    }

    const descMatch = path.match(/\/blocks\/([^/]+)\/descendant$/);
    if (req.method === 'POST' && descMatch) {
      const parentId = descMatch[1];
      const parent = doc.blocks.get(parentId);
      if (!parent) return send({ code: 1770002, msg: 'parent not found' }, 404);
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const relations: { block_id: string; temporary_block_id: string }[] = [];
      const tempToReal = new Map<string, string>();
      for (const d of body.descendants ?? []) {
        const real = `doxcnB${++doc.idCounter}`;
        tempToReal.set(d.block_id, real);
        relations.push({ block_id: real, temporary_block_id: d.block_id });
      }
      for (const d of body.descendants ?? []) {
        const real = tempToReal.get(d.block_id)!;
        doc.blocks.set(real, {
          block_id: real,
          parent_id: parentId,
          children: (d.children ?? []).map((c: string) => tempToReal.get(c) ?? c),
          block_type: d.block_type,
          entity: entityOf(d.block_type, d),
        });
      }
      const realChildren = (body.children_id ?? []).map((c: string) => tempToReal.get(c) ?? c);
      const index = typeof body.index === 'number' && body.index >= 0 ? Math.min(body.index, parent.children.length) : parent.children.length;
      parent.children.splice(index, 0, ...realChildren);
      return send({ code: 0, data: { block_id_relations: relations, document_revision_id: doc.idCounter } });
    }

    const delMatch = path.match(/\/blocks\/([^/]+)\/children\/batch_delete$/);
    if (req.method === 'DELETE' && delMatch) {
      const parent = doc.blocks.get(delMatch[1]);
      if (!parent) return send({ code: 1770002, msg: 'parent not found' }, 404);
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const removed = parent.children.splice(body.start_index, body.end_index - body.start_index);
      const kill = (id: string) => {
        const b = doc.blocks.get(id);
        if (!b) return;
        b.deleted = true;
        for (const c of b.children) kill(c);
      };
      for (const id of removed) kill(id);
      return send({ code: 0, data: { document_revision_id: doc.idCounter } });
    }

    const patchMatch = path.match(/\/blocks\/([^/]+)$/);
    if (req.method === 'PATCH' && patchMatch) {
      const block = doc.blocks.get(patchMatch[1]);
      if (!block) return send({ code: 1770002, msg: 'block not found' }, 404);
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (body.update_text_elements && block.entity) {
        block.entity = { ...block.entity, elements: body.update_text_elements.elements };
        if (patchMatch[1] === doc.pageId) doc.title = (body.update_text_elements.elements[0] as { text_run?: { content?: string } })?.text_run?.content ?? doc.title;
      }
      if (body.replace_image && block.entity) {
        block.entity = { ...block.entity, token: body.replace_image.token };
      }
      return send({ code: 0, data: { document_revision_id: doc.idCounter } });
    }

    return send({ code: -1, msg: `mock 未实现: ${req.method} ${path}` }, 404);
  });

  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolveStart({ server, port: addr.port });
    });
  });
}

/** 从实体还原出 GET 风格的 payload（补默认值，模拟真实回读差异） */
function entityPayload(b: MockBlock): Record<string, unknown> {
  const keys: Record<number, string> = {
    2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4', 7: 'heading5',
    8: 'heading6', 9: 'heading7', 10: 'heading8', 11: 'heading9',
    12: 'bullet', 13: 'ordered', 14: 'code', 15: 'quote', 17: 'todo',
    19: 'callout', 22: 'divider', 27: 'image', 31: 'table', 32: 'table_cell', 34: 'quote_container',
  };
  const key = keys[b.block_type];
  if (!key) return {};
  const entity = b.entity ?? {};
  // 文本类实体补 align 默认值（GET 行为）
  if ('elements' in entity) return { [key]: { ...entity, style: { ...((entity as { style?: unknown }).style ?? {}), align: 1, folded: false } } };
  return { [key]: entity };
}

type IncomingRequest = IncomingMessage;

describe('本地 mock 服务器全链路', () => {
  let client: FeishuClient;
  let server: Server;
  let docId: string;

  const projectRoot = resolve(import.meta.dirname, '..');
  const baseDir = resolve(projectRoot, 'example');

  beforeAll(async () => {
    const started = await startServer();
    server = started.server;
    client = new FeishuClient({
      appId: 'mock',
      appSecret: 'mock',
      baseUrl: `http://127.0.0.1:${started.port}`,
      minIntervalMs: 0,
      uploadIntervalMs: 0,
    });
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const publish = async (md: string, update?: string, title?: string) => {
    const converted = convertDocument(parseMarkdown(md), { fallbackTitle: 't', titleFromHeading: false });
    return publishDocument(client, {
      title: title ?? converted.title,
      blocks: converted.blocks,
      baseDir,
      ...(update ? { update: { documentId: update } } : {}),
      log: () => {},
    });
  };

  /** 按顺序读取 page 子块的文本摘要 */
  const topLevelSummary = (): string[] => {
    const doc = docs.get(docId)!;
    const page = doc.blocks.get(doc.pageId)!;
    const textOf = (id: string): string => {
      const b = doc.blocks.get(id)!;
      if (b.block_type === 27) return `[img:${(b.entity as { token?: string } | null)?.token ?? '无'}]`;
      const els = (b.entity as { elements?: { text_run?: { content?: string }; equation?: { content?: string } }[] } | null)?.elements ?? [];
      return els.map((e) => e.text_run?.content ?? `$${e.equation?.content ?? ''}$`).join('');
    };
    return page.children.filter((id) => !doc.blocks.get(id)?.deleted).map(textOf);
  };

  it('创建文档 → 写入块 → 图片上传替换（三步链路）', async () => {
    const md = [
      '# H', // 标题保留（titleFromHeading: false）
      '',
      '第一段不变',
      '',
      '中间段',
      '',
      '![](assets/example.png)',
      '',
      '> [!TIP]',
      '> 高亮',
      '',
      '$$x^2$$',
      '',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '结尾段',
    ].join('\n');
    const result = await publish(md);
    docId = result.documentId;
    expect(result.created).toBe(true);
    expect(result.imageCount).toBe(1);
    expect(result.blockCount).toBeGreaterThan(10);

    const summary = topLevelSummary();
    expect(summary[0]).toBe('H');
    expect(summary[1]).toBe('第一段不变');
    expect(summary[2]).toBe('中间段');
    expect(summary[3]).toBe('[img:file_mock_1]');
    expect(summary).toContain('$\\displaystyle x^2$');
    expect(summary[summary.length - 1]).toBe('结尾段');

    // 图片上传参数：parent_type=docx_image，parent_node 为真实图片块 ID
    expect(uploads).toHaveLength(1);
    expect(uploads[0].parentType).toBe('docx_image');
    expect(uploads[0].parentNode).toMatch(/^doxcnB\d+$/);
  });

  it('diff 更新：改一段/增一段 → 未变块 block_id 保持（评论锚点不丢）', async () => {
    const doc = docs.get(docId)!;
    const pageBefore = doc.blocks.get(doc.pageId)!;
    const idsBefore = pageBefore.children.slice();
    const paragraphIdBefore = idsBefore[1]; // 「第一段不变」
    const imageIdBefore = idsBefore[3];

    const mdV2 = [
      '# H', '', '第一段不变', '', '中间段改了', '', '![](assets/example.png)', '',
      '新增段', '', '> [!TIP]', '> 高亮', '', '$$x^2$$', '',
      '| A | B |', '| - | - |', '| 1 | 2 |', '', '结尾段',
    ].join('\n');
    const result = await publish(mdV2, docId);
    expect(result.created).toBe(false);
    // 顶层 9 块 = 保留 7（H/第一段/图片/callout/公式/表格/结尾段）+ 补丁 1（中间段）+ 新增 1
    expect(result.diff).toMatchObject({ kept: 7, patched: 1, deleted: 0, inserted: 1 });
    expect(result.imageCount).toBe(0); // 图片未变，不重复上传

    const pageAfter = doc.blocks.get(doc.pageId)!;
    // 未变块的 block_id 原样保留
    expect(pageAfter.children).toContain(paragraphIdBefore);
    expect(pageAfter.children).toContain(imageIdBefore);

    const summary = topLevelSummary();
    const idx = summary.indexOf('中间段改了');
    expect(idx).toBeGreaterThan(0);
    expect(summary[idx + 1]).toBe('[img:file_mock_1]');
    expect(summary).toContain('新增段');
  });

  it('diff 更新：删除段落与标题重命名', async () => {
    const mdV3 = [
      '# H 改名', '', '中间段改了', '', '![](assets/example.png)', '', '新增段', '',
      '> [!TIP]', '> 高亮', '', '$$x^2$$', '',
      '| A | B |', '| - | - |', '| 1 | 2 |', '', '结尾段',
    ].join('\n');
    const result = await publish(mdV3, docId, '文档新标题');
    expect(result.diff).toMatchObject({ patched: 1, deleted: 1 }); // 「第一段不变」被删，H1 被补丁改名
    const summary = topLevelSummary();
    expect(summary[0]).toBe('H 改名');
    expect(summary).not.toContain('第一段不变');
    // 显式传入的 title 通过 page 块补丁更新成功
    expect(docs.get(docId)!.title).toBe('文档新标题');
  });
});
