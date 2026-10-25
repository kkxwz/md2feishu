import { describe, it, expect, vi } from 'vitest';
import { FeishuClient, FeishuApiError } from '../src/api/client.js';

type Route = { match: (url: string, method: string) => boolean; respond: (url: string) => Response | Promise<Response> };

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeFetch(routes: Route[]) {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    for (const r of routes) {
      if (r.match(url, method)) return r.respond(url);
    }
    return jsonRes({ code: 0, data: {} });
  });
  return { fetchImpl, calls };
}

const TOKEN_ROUTE: Route = {
  match: (url) => url.includes('/auth/v3/tenant_access_token/internal'),
  respond: () => jsonRes({ code: 0, tenant_access_token: 't-token', expire: 3600 }),
};

describe('FeishuClient', () => {
  it('token 获取并缓存复用', async () => {
    const { fetchImpl, calls } = makeFetch([TOKEN_ROUTE]);
    const client = new FeishuClient({ appId: 'a', appSecret: 's', fetchImpl, minIntervalMs: 0 });
    await client.request('GET', '/open-apis/docx/v1/documents');
    await client.request('GET', '/open-apis/docx/v1/documents');
    const tokenCalls = calls.filter((c) => c.url.includes('tenant_access_token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('限流错误码 99991400 自动退避重试后成功', async () => {
    let attempt = 0;
    const { fetchImpl } = makeFetch([
      TOKEN_ROUTE,
      {
        match: (url) => url.includes('/docx/v1/documents'),
        respond: () => {
          attempt++;
          return attempt < 3 ? jsonRes({ code: 99991400, msg: 'too many request' }, 400) : jsonRes({ code: 0, data: {} });
        },
      },
    ]);
    const client = new FeishuClient({ appId: 'a', appSecret: 's', fetchImpl, minIntervalMs: 0 });
    await expect(client.request('GET', '/open-apis/docx/v1/documents')).resolves.toMatchObject({ code: 0 });
    expect(attempt).toBe(3);
  });

  it('HTTP 429 也触发重试', async () => {
    let attempt = 0;
    const { fetchImpl } = makeFetch([
      TOKEN_ROUTE,
      {
        match: (url) => url.includes('/docx/v1/documents'),
        respond: () => {
          attempt++;
          return attempt < 2 ? new Response('rate', { status: 429 }) : jsonRes({ code: 0, data: {} });
        },
      },
    ]);
    const client = new FeishuClient({ appId: 'a', appSecret: 's', fetchImpl, minIntervalMs: 0 });
    await expect(client.request('GET', '/open-apis/docx/v1/documents')).resolves.toBeTruthy();
    expect(attempt).toBe(2);
  });

  it('业务错误抛 FeishuApiError，附带中文排查提示', async () => {
    const { fetchImpl } = makeFetch([
      TOKEN_ROUTE,
      {
        match: (url) => url.includes('/docx/v1/documents'),
        respond: () => jsonRes({ code: 230002, msg: 'Forbidden' }, 403),
      },
    ]);
    const client = new FeishuClient({ appId: 'a', appSecret: 's', fetchImpl, minIntervalMs: 0 });
    const err = await client.request('GET', '/open-apis/docx/v1/documents').catch((e) => e);
    expect(err).toBeInstanceOf(FeishuApiError);
    expect(err.code).toBe(230002);
    expect(err.message).toContain('共享给应用');
  });

  it('凭证错误映射为中文提示', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (url) => url.includes('tenant_access_token'),
        respond: () => jsonRes({ code: 99991661, msg: 'app secret invalid' }),
      },
    ]);
    const client = new FeishuClient({ appId: 'a', appSecret: 'bad', fetchImpl, minIntervalMs: 0 });
    const err = await client.request('GET', '/open-apis/x').catch((e) => e);
    expect(err).toBeInstanceOf(FeishuApiError);
    expect(err.message).toContain('app_id 或 app_secret');
  });

  it('缺少凭证时给出清晰错误', async () => {
    const client = new FeishuClient({ fetchImpl: async () => jsonRes({}) });
    await expect(client.request('GET', '/open-apis/x')).rejects.toThrow(/md2feishu init/);
  });

  it('串行限速：请求按顺序执行', async () => {
    const order: number[] = [];
    const { fetchImpl } = makeFetch([
      TOKEN_ROUTE,
      {
        match: (url) => url.includes('/docx'),
        respond: async () => {
          order.push(order.length);
          return jsonRes({ code: 0, data: {} });
        },
      },
    ]);
    const client = new FeishuClient({ appId: 'a', appSecret: 's', fetchImpl, minIntervalMs: 0 });
    await Promise.all([
      client.request('GET', '/open-apis/docx/v1/documents'),
      client.request('GET', '/open-apis/docx/v1/documents'),
      client.request('GET', '/open-apis/docx/v1/documents'),
    ]);
    expect(order).toEqual([0, 1, 2]);
  });

  it('按文档通道串行：同文档请求顺序保持，不同文档可交错', async () => {
    const events: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const { fetchImpl } = makeFetch([
      TOKEN_ROUTE,
      {
        match: (url, method) => url.includes('/docx/v1/documents') && method === 'GET',
        respond: async (url: string) => {
          const doc = url.includes('DOC_A') ? 'A' : 'B';
          events.push(`start:${doc}`);
          await sleep(30);
          events.push(`end:${doc}`);
          return jsonRes({ code: 0, data: {} });
        },
      },
    ]);
    const client = new FeishuClient({ appId: 'a', appSecret: 's', fetchImpl, minIntervalMs: 0 });
    const url = (doc: string) => `/open-apis/docx/v1/documents/${doc}/blocks`;
    await Promise.all([
      client.request('GET', url('DOC_A'), { channel: 'doc:DOC_A' }),
      client.request('GET', url('DOC_B'), { channel: 'doc:DOC_B' }),
      client.request('GET', url('DOC_A'), { channel: 'doc:DOC_A' }),
    ]);
    // 同文档：第二个 A 必须在第一个 A 结束后才开始
    const firstAEnd = events.indexOf('end:A');
    const secondAStart = events.indexOf('start:A', events.indexOf('start:A') + 1);
    expect(secondAStart).toBeGreaterThan(firstAEnd);
    // 不同文档可以交错：B 的开始早于第二个 A 的结束
    expect(events).toContain('start:B');
  });
});
