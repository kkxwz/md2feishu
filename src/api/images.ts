import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ImageSource } from '../types.js';

const execFileAsync = promisify(execFile);

export interface LoadedImage {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  width?: number;
  height?: number;
}

export interface MermaidRenderOptions {
  /** 渲染服务 URL 模板，{b64} 替换为 base64url 的图源码。默认 mermaid.ink，可换成自建 kroki */
  rendererTemplate?: string;
  /** 优先尝试本地 mmdc（@mermaid-js/mermaid-cli），默认 true */
  preferLocal?: boolean;
  fetchImpl?: typeof fetch;
  /** 本地渲染执行器（注入以便测试） */
  runLocal?: (source: string) => Promise<Uint8Array>;
  log?: (msg: string) => void;
}

const DEFAULT_MERMAID_TEMPLATE = 'https://mermaid.ink/img/{b64}';
let mmdcAvailable: boolean | null = null;

/**
 * mermaid → PNG 渲染链：本地 mmdc（若安装）→ 在线渲染服务 → 抛错（上层降级回代码块）。
 * 注意：在线模式会把图源码发送给渲染服务，介意隐私请自建 kroki 并配置 rendererTemplate。
 */
export async function renderMermaid(source: string, opts: MermaidRenderOptions = {}): Promise<LoadedImage> {
  const preferLocal = opts.preferLocal !== false;
  const runLocal = opts.runLocal ?? runLocalMmdc;

  if (preferLocal && mmdcAvailable !== false) {
    try {
      const bytes = await runLocal(source);
      mmdcAvailable = true;
      const sniffed = sniffImage(bytes);
      return {
        bytes,
        mimeType: sniffed?.mime ?? 'image/png',
        fileName: mermaidFileName(source, sniffed?.mime ?? 'image/png'),
        width: sniffed?.width,
        height: sniffed?.height,
      };
    } catch (err) {
      if (mmdcAvailable === null) {
        mmdcAvailable = (/ENOENT|not found/i.test((err as Error).message)) ? false : true;
      }
      opts.log?.(`本地 mmdc 渲染失败，改用在线服务：${(err as Error).message.slice(0, 120)}`);
    }
  }

  return renderMermaidOnline(source, opts.rendererTemplate ?? DEFAULT_MERMAID_TEMPLATE, opts.fetchImpl ?? fetch);
}

async function renderMermaidOnline(source: string, template: string, fetchImpl: typeof fetch): Promise<LoadedImage> {
  const b64 = Buffer.from(source, 'utf-8').toString('base64url');
  if (b64.length > 3500 && !template.includes('{post}')) {
    throw new Error('mermaid 图源过长（>3500 字符的 base64），在线服务大概率拒绝；请安装本地 mmdc 或精简图表');
  }
  const url = template.includes('{b64}') ? template.replace('{b64}', b64) : `${template}${b64}`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; md2feishu/0.2)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`在线渲染服务返回 HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new Error('在线渲染服务返回的不是图片');
  return {
    bytes,
    mimeType: sniffed.mime,
    fileName: mermaidFileName(source, sniffed.mime),
    width: sniffed?.width,
    height: sniffed?.height,
  };
}

function mermaidFileName(source: string, mimeType: string): string {
  const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? '.jpg' : mimeType.includes('svg') ? '.svg' : mimeType.includes('gif') ? '.gif' : '.png';
  return `mermaid-${createHash('sha256').update(source).digest('hex').slice(0, 8)}${ext}`;
}

/** 用本地 mmdc 渲染（需 npm i -g @mermaid-js/mermaid-cli） */
async function runLocalMmdc(source: string): Promise<Uint8Array> {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(joinPath(tmpdir(), 'md2feishu-'));
  try {
    const input = `${dir}/in.mmd`;
    const output = `${dir}/out.png`;
    await writeFile(input, source, 'utf-8');
    await execFileAsync('mmdc', ['-i', input, '-o', output, '-b', 'white'], { timeout: 60_000 });
    return new Uint8Array(await readFile(output));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function joinPath(...parts: string[]): string {
  return parts.join('/').replaceAll('//', '/');
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const MAX_BYTES = 30 * 1024 * 1024;

/**
 * 加载图片内容：本地路径（相对 Markdown 文件所在目录解析）、远程 URL（下载）、data URI、
 * mermaid 源码（渲染为 PNG）。
 */
export async function loadImage(
  image: ImageSource,
  baseDir: string,
  fetchImpl: typeof fetch = fetch,
  mermaidOpts?: MermaidRenderOptions,
): Promise<LoadedImage> {
  if (image.kind === 'mermaid') return renderMermaid(image.src, { ...mermaidOpts, fetchImpl });
  if (image.kind === 'data') return loadDataUri(image.src);
  if (image.kind === 'remote') return loadRemote(image.src, fetchImpl);
  return loadLocal(image.path ?? image.src, baseDir);
}

async function loadLocal(path: string, baseDir: string): Promise<LoadedImage> {
  const abs = isAbsolute(path) ? path : resolve(baseDir, path);
  const bytes = new Uint8Array(await readFile(abs));
  const ext = extname(abs).toLowerCase();
  const sniffed = sniffImage(bytes);
  const mimeType = sniffed?.mime ?? MIME_BY_EXT[ext] ?? 'image/png';
  return {
    bytes,
    mimeType,
    fileName: sanitizeName(basename(abs), mimeType),
    width: sniffed?.width,
    height: sniffed?.height,
  };
}

async function loadRemote(url: string, fetchImpl: typeof fetch): Promise<LoadedImage> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; md2feishu/0.1)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`下载远程图片失败：HTTP ${res.status}（${url}）`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error(`图片超过 30MB 上限（${url}）`);
  const bytes = new Uint8Array(buf);
  const sniffed = sniffImage(bytes);
  const mime = sniffed?.mime ?? res.headers.get('content-type')?.split(';')[0] ?? '';
  if (!mime.startsWith('image/')) throw new Error(`不是可识别的图片（content-type: ${mime || '未知'}，${url}）`);
  const urlName = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
  return {
    bytes,
    mimeType: mime,
    fileName: sanitizeName(urlName, mime),
    width: sniffed?.width,
    height: sniffed?.height,
  };
}

function loadDataUri(src: string): LoadedImage {
  const match = src.match(/^data:([^;,]+)?(;base64)?,(.*)$/is);
  if (!match) throw new Error(`无法解析 data URI：${src.slice(0, 50)}…`);
  const [, mime, isBase64, data] = match;
  const bytes = isBase64
    ? new Uint8Array(Buffer.from(data, 'base64'))
    : new Uint8Array(Buffer.from(decodeURIComponent(data), 'utf-8'));
  const sniffed = sniffImage(bytes);
  const finalMime = sniffed?.mime ?? mime ?? 'image/png';
  const ext = Object.entries(MIME_BY_EXT).find(([, m]) => m === finalMime)?.[0] ?? '.png';
  return {
    bytes,
    mimeType: finalMime,
    fileName: `image${ext}`,
    width: sniffed?.width,
    height: sniffed?.height,
  };
}

function sanitizeName(name: string, mime: string): string {
  const ext = Object.entries(MIME_BY_EXT).find(([, m]) => m === mime)?.[0] ?? '.png';
  let n = (name || 'image').replace(/[\\/:*?"<>|\s]+/g, '_');
  if (!/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(n)) n += ext;
  return n.slice(0, 100);
}

interface SniffResult {
  mime: string;
  width?: number;
  height?: number;
}

/** 魔数识别图片类型与尺寸（PNG/GIF/BMP/JPEG/WebP），SVG 仅识别类型 */
export function sniffImage(b: Uint8Array): SniffResult | null {
  if (b.length < 8) return null;
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const w = b.length >= 24 ? readU32BE(b, 16) : undefined;
    const h = b.length >= 24 ? readU32BE(b, 20) : undefined;
    return { mime: 'image/png', width: w, height: h };
  }
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return {
      mime: 'image/gif',
      width: b.length >= 10 ? readU16LE(b, 6) : undefined,
      height: b.length >= 10 ? readU16LE(b, 8) : undefined,
    };
  }
  // BMP
  if (b[0] === 0x42 && b[1] === 0x4d) {
    return {
      mime: 'image/bmp',
      width: b.length >= 26 ? Math.abs(readI32LE(b, 18)) : undefined,
      height: b.length >= 26 ? Math.abs(readI32LE(b, 22)) : undefined,
    };
  }
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      // SOF0~SOF15（除 DHT/JPG/DAC）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          mime: 'image/jpeg',
          height: readU16BE(b, i + 5),
          width: readU16BE(b, i + 7),
        };
      }
      const len = readU16BE(b, i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return { mime: 'image/jpeg' };
  }
  // WebP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const format = String.fromCharCode(b[12], b[13], b[14]);
    if (format === 'VP8' && b.length >= 30) {
      return { mime: 'image/webp', width: readU16LE(b, 26) & 0x3fff, height: readU16LE(b, 28) & 0x3fff };
    }
    if (format === 'VP8L' && b.length >= 25) {
      const bits = readU32LE(b, 21);
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (format === 'VP8X' && b.length >= 30) {
      return {
        mime: 'image/webp',
        width: (readU24LE(b, 24) + 1),
        height: (readU24LE(b, 27) + 1),
      };
    }
    return { mime: 'image/webp' };
  }
  // SVG（文本）
  const head = new TextDecoder('latin1').decode(b.slice(0, 512)).trimStart().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return { mime: 'image/svg+xml' };
  return null;
}

function readU16BE(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function readU16LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function readU32BE(b: Uint8Array, o: number): number {
  return (b[o] * 2 ** 24) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
}
function readU32LE(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 2 ** 24;
}
function readI32LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
}
function readU24LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}

/** 生成用于展示的图片块尺寸：等比缩放，宽度不超过 maxW */
export function displaySize(width?: number, height?: number, maxW = 780): { width: number; height: number } | undefined {
  if (!width || !height || width <= 0 || height <= 0) return undefined;
  if (width <= maxW) return { width, height };
  return { width: maxW, height: Math.round((height * maxW) / width) };
}

export { MAX_BYTES };
