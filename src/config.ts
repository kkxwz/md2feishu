import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FeishuConfig {
  appId?: string;
  appSecret?: string;
  /** 形如 https://yourtenant.feishu.cn，用于拼接文档链接 */
  domain?: string;
  /** 默认目标文件夹 token */
  folder?: string;
  /** 默认知识库 space_id */
  wikiSpace?: string;
  /** mermaid 处理模式：code（默认）/ image */
  mermaidMode?: 'code' | 'image';
  /** mermaid 在线渲染服务 URL 模板（{b64} 占位），默认 mermaid.ink，可自建 kroki */
  mermaidRenderer?: string;
  /** 是否优先使用本地 mmdc 渲染 mermaid（默认 true） */
  mermaidPreferLocal?: boolean;
  /** 默认更新方式：diff（默认）/ rebuild */
  updateMode?: 'diff' | 'rebuild';
  /** 默认转换引擎：builtin（默认）/ official */
  engine?: 'builtin' | 'official';
  /** 块级公式是否加 \displaystyle（默认 true） */
  displayStyle?: boolean;
}

export function globalDir(): string {
  return join(homedir(), '.md2feishu');
}

export function globalConfigPath(): string {
  return join(globalDir(), 'config.json');
}

export function cachePath(): string {
  return join(globalDir(), 'cache.json');
}

function readJson(file: string): Record<string, unknown> {
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 配置合并优先级：显式路径 > 环境变量 > 项目本地 .md2feishu.json > 全局 ~/.md2feishu/config.json */
export function loadConfig(explicitPath?: string): FeishuConfig {
  const global = readJson(globalConfigPath()) as FeishuConfig;
  const local = readJson(join(process.cwd(), '.md2feishu.json')) as FeishuConfig;
  const explicit = explicitPath ? readJson(explicitPath) : {};
  const merged: FeishuConfig = { ...global, ...local, ...explicit };
  const env: Record<string, string | undefined> = {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    domain: process.env.FEISHU_DOMAIN,
    folder: process.env.FEISHU_FOLDER,
    wikiSpace: process.env.FEISHU_WIKI_SPACE,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v) (merged as Record<string, unknown>)[k] = v;
  }
  // 去掉空字符串
  for (const k of Object.keys(merged)) {
    if ((merged as Record<string, unknown>)[k] === '') delete (merged as Record<string, unknown>)[k];
  }
  return merged;
}

export function saveGlobalConfig(config: Partial<FeishuConfig>): void {
  const dir = globalDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = readJson(globalConfigPath());
  writeFileSync(globalConfigPath(), JSON.stringify({ ...current, ...config }, null, 2), 'utf-8');
}

export interface CacheEntry {
  docId: string;
  url?: string;
  wikiNodeToken?: string;
  title: string;
  hash: string;
  updatedAt: string;
}

interface CacheShape {
  files: Record<string, CacheEntry>;
}

export class SyncCache {
  private data: CacheShape = { files: {} };
  private readonly file: string;
  private loaded = false;

  constructor(file = cachePath()) {
    this.file = file;
  }

  private ensure(): void {
    if (this.loaded) return;
    const raw = readJson(this.file) as unknown as CacheShape;
    if (raw && typeof raw.files === 'object') this.data = { files: raw.files };
    this.loaded = true;
  }

  get(absPath: string): CacheEntry | undefined {
    this.ensure();
    return this.data.files[absPath];
  }

  set(absPath: string, entry: CacheEntry): void {
    this.ensure();
    this.data.files[absPath] = entry;
  }

  remove(absPath: string): void {
    this.ensure();
    delete this.data.files[absPath];
  }

  save(): void {
    this.ensure();
    const dir = globalDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8');
  }
}
