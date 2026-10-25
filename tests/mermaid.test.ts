import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/convert/parse.js';
import { convertDocument } from '../src/convert/blocks.js';
import { renderMermaid } from '../src/api/images.js';
import { preloadImages } from '../src/publisher.js';

const MERMAID_SRC = 'graph TD; A-->B;';

/** 1x1 红色 PNG */
const tinyPng = () => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x00, 0x00, 0x00, 0x0d], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  b[18] = 0; b[19] = 1; b[23] = 1;
  return b;
};

describe('mermaid 模式（转换器）', () => {
  it('默认 code：降级为纯文本代码块并提示 --mermaid image', () => {
    const doc = convertDocument(parseMarkdown('```mermaid\ngraph TD; A-->B;\n```'), { fallbackTitle: 't' });
    expect(doc.blocks[0].code).toMatchObject({ language: 1, rawLanguage: 'mermaid' });
    expect(doc.warnings.some((w) => w.includes('--mermaid image'))).toBe(true);
  });

  it('image 模式：转换为图片节点（kind=mermaid）', () => {
    const doc = convertDocument(parseMarkdown('```mermaid\ngraph TD; A-->B;\n```'), {
      fallbackTitle: 't',
      mermaidMode: 'image',
    });
    expect(doc.blocks[0]).toMatchObject({ kind: 'image', image: { kind: 'mermaid', src: MERMAID_SRC } });
  });
});

describe('renderMermaid 渲染链', () => {
  it('本地 mmdc 优先使用', async () => {
    const img = await renderMermaid(MERMAID_SRC, {
      preferLocal: true,
      runLocal: async () => tinyPng(),
      fetchImpl: async () => {
        throw new Error('不应访问在线服务');
      },
    });
    expect(img.mimeType).toBe('image/png');
    expect(img.fileName).toMatch(/^mermaid-[0-9a-f]{8}\.png$/);
    expect(img.width).toBe(1);
  });

  it('本地失败自动落到在线渲染（URL 模板 {b64}）', async () => {
    let requestedUrl = '';
    const img = await renderMermaid('graph TD; A-->B;', {
      runLocal: async () => {
        throw new Error('spawn ENOENT');
      },
      fetchImpl: (async (input: RequestInfo | URL) => {
        requestedUrl = String(input);
        return new Response(tinyPng(), { headers: { 'Content-Type': 'image/png' } });
      }) as typeof fetch,
    });
    expect(img.mimeType).toBe('image/png');
    const b64 = Buffer.from('graph TD; A-->B;', 'utf-8').toString('base64url');
    expect(requestedUrl).toBe(`https://mermaid.ink/img/${b64}`);
  });

  it('自定义渲染模板（自建 kroki）', async () => {
    let requestedUrl = '';
    await renderMermaid('graph TD;', {
      preferLocal: false,
      rendererTemplate: 'https://kroki.mycompany.com/mermaid/png/{b64}',
      fetchImpl: (async (input: RequestInfo | URL) => {
        requestedUrl = String(input);
        return new Response(tinyPng(), { headers: { 'Content-Type': 'image/png' } });
      }) as typeof fetch,
    });
    expect(requestedUrl).toMatch(/^https:\/\/kroki\.mycompany\.com\/mermaid\/png\//);
  });

  it('全部失败时抛错，preloadImages 把节点降级回代码块', async () => {
    const doc = convertDocument(parseMarkdown('```mermaid\ngraph TD;\n```'), {
      fallbackTitle: 't',
      mermaidMode: 'image',
    });
    const failures = await preloadImages(doc.blocks, '/tmp', undefined, (async () => {
      throw new Error('HTTP 503');
    }) as typeof fetch, {
      preferLocal: false,
      fetchImpl: (async () => {
        throw new Error('HTTP 503');
      }) as typeof fetch,
    });
    expect(failures).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe('code');
    expect(doc.blocks[0].code).toMatchObject({ language: 1, content: 'graph TD;' });
    expect(doc.blocks[0].code!.rawLanguage).toContain('mermaid');
  });
});
