#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import pc from 'picocolors';
import { parseMarkdown } from './convert/parse.js';
import { convertDocument } from './convert/blocks.js';
import { FeishuApiError, FeishuClient } from './api/client.js';
import { resolveDocumentId } from './api/endpoints.js';
import { planBatches, publishDocument, dryRunReplacer } from './publisher.js';
import { loadConfig, saveGlobalConfig, globalConfigPath, SyncCache } from './config.js';

const VERSION = '0.2.0';

const program = new Command();
program
  .name('md2feishu')
  .version(VERSION)
  .description('把 Markdown 发布为飞书云文档：表格 / 数学公式 / 代码块 / 图片上传 / 高亮块 / 知识库 / 增量同步');

program
  .command('init')
  .description('交互式初始化配置（飞书应用凭证等），写入 ~/.md2feishu/config.json')
  .action(async () => {
    await runInit();
  });

program
  .command('check')
  .description('校验配置与凭证是否可用（获取 tenant_access_token）')
  .option('--config <path>', '指定配置文件路径')
  .action(async (opts: { config?: string }) => {
    const config = loadConfig(opts.config);
    if (!config.appId || !config.appSecret) {
      fail('尚未配置应用凭证：请先运行 md2feishu init，或设置 FEISHU_APP_ID / FEISHU_APP_SECRET。');
    }
    const client = new FeishuClient({ appId: config.appId, appSecret: config.appSecret });
    try {
      const token = await client.getAccessToken();
      console.log(pc.green('✓ 凭证有效，tenant_access_token 获取成功。'));
      if (token) {
        try {
          const res = (await client.request<{ data: { app_name?: string } }>(
            'GET',
            `/open-apis/application/v6/applications/${config.appId}`,
          )) as { data?: { app_name?: string } };
          const name = res?.data?.app_name;
          if (name) console.log(`  应用名称：${name}`);
        } catch {
          console.log(pc.yellow('  （查询应用信息被拒绝，不影响使用，通常缺少 application:app:readonly 权限）'));
        }
      }
      console.log('\n发布前请确认：');
      console.log('  1. 应用已开通权限：docx:document、drive:drive（图片上传）、wiki:wiki（知识库）');
      console.log('  2. 应用已创建版本并发布（版本管理 → 创建版本 → 申请发布）');
      console.log('  3. 目标文件夹/知识库已共享给应用（授予可编辑权限）');
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

interface PushOptions {
  title?: string;
  folder?: string;
  wiki?: string;
  wikiParent?: string;
  update?: string;
  updateMode?: string;
  dryRun?: boolean;
  out?: string;
  forceNew?: boolean;
  noCache?: boolean;
  ext?: string;
  keepH1?: boolean;
  userToken?: string;
  config?: string;
  verbose?: boolean;
  mermaid?: string;
  engine?: string;
  displayStyle?: boolean;
}

program
  .command('push')
  .description('发布 Markdown 文件/目录到飞书（目录递归、支持增量更新）')
  .argument('<paths...>', 'Markdown 文件、目录或 -（stdin）')
  .option('-t, --title <title>', '文档标题（默认：front-matter > 首个 H1 > 文件名）')
  .option('-f, --folder <token>', '目标文件夹 token（也可在 front-matter/配置里指定）')
  .option('-w, --wiki <spaceId>', '发布到知识库 space')
  .option('-p, --wiki-parent <nodeToken>', '知识库父节点 token')
  .option('-u, --update <docUrl|id>', '覆盖更新指定文档（保留链接与位置，清空重建正文）')
  .option('-d, --dry-run', '只输出转换后的飞书块 JSON，不调用任何 API')
  .option('-o, --out <file>', 'dry-run 输出文件（默认打印到 stdout）')
  .option('--force-new', '忽略本地缓存，强制新建文档')
  .option('--no-cache', '本次不读写增量缓存')
  .option('--ext <ext>', '目录扫描的扩展名，逗号分隔（默认 md）')
  .option('--keep-h1', '不把首个 H1 作为文档标题（保留在正文里）')
  .option('--mermaid <mode>', 'mermaid 处理：code=纯文本代码块（默认） / image=渲染为图片', 'code')
  .option('--update-mode <mode>', '更新方式：diff=结构化增量（默认，保留未变块及评论） / rebuild=清空重建')
  .option('--engine <engine>', '转换引擎：builtin=内置（默认） / official=官方 Markdown 转块接口')
  .option('--no-display-style', '块级公式不加 \\displaystyle 前缀')
  .option('--user-token <token>', '使用 user_access_token 而非应用身份')
  .option('--config <path>', '指定配置文件路径')
  .option('-v, --verbose', '输出详细日志')
  .action(async (paths: string[], opts: PushOptions) => {
    await runPush(paths, opts).catch((err) => fail(err instanceof Error ? err.message : String(err)));
  });

program.parseAsync(process.argv).catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});

function fail(message: string): never {
  console.error(pc.red(`✗ ${message}`));
  process.exit(1);
}

async function runInit(): Promise<void> {
  console.log(pc.bold('md2feishu 配置向导'));
  console.log('先在飞书开放平台（https://open.feishu.cn）创建「企业自建应用」，然后填入以下信息：\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const appId = (await rl.question('App ID (cli_ 开头): ')).trim();
    const appSecret = (await rl.question('App Secret: ')).trim();
    const domain = (await rl.question('你的飞书域名，如 https://xxx.feishu.cn (可略): ')).trim();
    const folder = (await rl.question('默认目标文件夹 token (可略): ')).trim();
    const wikiSpace = (await rl.question('默认知识库 space_id (可略): ')).trim();
    if (!appId || !appSecret) {
      console.error(pc.red('✗ App ID 与 App Secret 不能为空'));
      process.exitCode = 1;
      return;
    }
    saveGlobalConfig({
      appId,
      appSecret,
      ...(domain ? { domain: domain.replace(/\/+$/, '') } : {}),
      ...(folder ? { folder } : {}),
      ...(wikiSpace ? { wikiSpace } : {}),
    });
    console.log(pc.green(`\n✓ 已保存到 ${globalConfigPath()}`));
    console.log('\n下一步：');
    console.log('  1. 在应用的「权限管理」中开通：docx:document、drive:drive、wiki:wiki');
    console.log('  2. 「版本管理」创建版本并发布');
    console.log('  3. 把目标文件夹/知识库共享给该应用（可编辑）');
    console.log('  4. 运行 md2feishu check 验证凭证');
    console.log('  5. 发布：md2feishu push hello.md');
  } finally {
    rl.close();
  }
}

interface FileJob {
  absPath: string;
  display: string;
  markdown: string;
}

async function collectFiles(paths: string[], exts: string[]): Promise<FileJob[]> {
  const jobs: FileJob[] = [];
  for (const p of paths) {
    if (p === '-') {
      jobs.push({
        absPath: 'stdin',
        display: '<stdin>',
        markdown: await readStdin(),
      });
      continue;
    }
    const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
    if (!existsSync(abs)) throw new Error(`路径不存在：${p}`);
    const s = await stat(abs);
    if (s.isDirectory()) {
      const found = await walk(abs, exts, abs);
      if (found.length === 0) throw new Error(`目录中没有 .${exts.join('/.')} 文件：${p}`);
      jobs.push(...found);
    } else {
      jobs.push({
        absPath: abs,
        display: p,
        markdown: await readFile(abs, 'utf-8'),
      });
    }
  }
  return jobs;
}

async function walk(root: string, exts: string[], dir: string): Promise<FileJob[]> {
  const out: FileJob[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(root, exts, full)));
    else if (exts.includes(e.name.replace(/^.*\./, '').toLowerCase())) {
      out.push({ absPath: full, display: relative(process.cwd(), full) || full, markdown: await readFile(full, 'utf-8') });
    }
  }
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

/** 去掉 YAML front-matter（official 引擎直接吃原始 Markdown） */
export function stripFrontmatter(markdown: string): string {
  const m = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? markdown.slice(m[0].length) : markdown;
}

async function runPush(paths: string[], opts: PushOptions): Promise<void> {
  const exts = (opts.ext ?? 'md').split(',').map((e) => e.trim().toLowerCase());
  const jobs = await collectFiles(paths, exts);

  const config = loadConfig(opts.config);
  const userToken = opts.userToken ?? process.env.FEISHU_USER_TOKEN;
  const needClient = !opts.dryRun;
  if (needClient && !userToken && (!config.appId || !config.appSecret)) {
    throw new Error('缺少飞书应用凭证：请先运行 md2feishu init，或设置 FEISHU_APP_ID / FEISHU_APP_SECRET。');
  }
  const log = opts.verbose ? (m: string) => console.log(pc.gray(`  ${m}`)) : undefined;
  const client = new FeishuClient({
    appId: config.appId,
    appSecret: config.appSecret,
    userToken,
    log,
  });

  const cache = opts.noCache ? null : new SyncCache();
  const dryRunFiles: unknown[] = [];
  const results: { display: string; url?: string; status: string }[] = [];
  let failures = 0;

  if (opts.update && jobs.length > 1) {
    throw new Error('--update 每次只能搭配一个文件');
  }

  for (const job of jobs) {
    const baseDir = job.absPath === 'stdin' ? process.cwd() : resolve(job.absPath, '..');
    const fallbackTitle = job.absPath === 'stdin' ? '未命名文档' : (job.absPath.split('/').pop() ?? '未命名文档').replace(/\.[^.]+$/, '');
    try {
      const parsed = parseMarkdown(job.markdown);
      const mermaidMode = (opts.mermaid === 'image' ? 'image' : (config.mermaidMode === 'image' ? 'image' : 'code')) as 'code' | 'image';
      const displayStyle = opts.displayStyle !== false && config.displayStyle !== false;
      const converted = convertDocument(parsed, {
        title: opts.title && jobs.length === 1 ? opts.title : undefined,
        fallbackTitle,
        titleFromHeading: !opts.keepH1,
        displayStyle,
        mermaidMode,
      });
      for (const w of converted.warnings) log?.(`⚠ ${w}`);

      if (opts.dryRun) {
        const batches = planBatches(converted.blocks);
        dryRunFiles.push({
          file: job.display,
          title: converted.title,
          frontmatter: converted.frontmatter,
          warnings: converted.warnings,
          batches: batches.map((b) => ({ children_id: b.childrenId, descendants: b.descendants })),
        });
        results.push({ display: job.display, status: pc.cyan('dry-run') });
        continue;
      }

      const hash = createHash('sha256').update(job.markdown).digest('hex');
      const updateMode = (opts.updateMode === 'rebuild' || config.updateMode === 'rebuild' ? 'rebuild' : 'diff') as 'diff' | 'rebuild';
      const engine = (opts.engine === 'official' || config.engine === 'official' ? 'official' : 'builtin') as 'builtin' | 'official';
      const commonPublish = {
        title: converted.title,
        blocks: converted.blocks,
        baseDir,
        domain: config.domain,
        log,
        engine,
        markdownSource: engine === 'official' ? stripFrontmatter(job.markdown) : undefined,
        mermaid: {
          ...(config.mermaidRenderer ? { rendererTemplate: config.mermaidRenderer } : {}),
          preferLocal: config.mermaidPreferLocal !== false,
        },
      };

      // 目标解析：--update > 缓存 > wiki > folder
      let publishOpts: Parameters<typeof publishDocument>[1];
      let cached = job.absPath === 'stdin' ? undefined : cache?.get(job.absPath);
      if (opts.forceNew) cached = undefined;

      if (opts.update) {
        const resolved = await resolveDocumentId(client, opts.update);
        publishOpts = {
          ...commonPublish,
          update: { documentId: resolved.documentId, mode: updateMode },
        };
      } else if (cached?.docId) {
        if (cached.hash === hash) {
          results.push({ display: job.display, url: cached.url, status: pc.gray('未变更，跳过') });
          continue;
        }
        publishOpts = {
          ...commonPublish,
          update: { documentId: cached.docId, mode: updateMode },
        };
      } else {
        const wikiSpace = opts.wiki ?? (converted.frontmatter.wiki_space as string | undefined) ?? config.wikiSpace;
        const folder = opts.folder ?? (converted.frontmatter.folder as string | undefined) ?? config.folder;
        if (wikiSpace) {
          const parentNodeToken = opts.wikiParent ?? (converted.frontmatter.wiki_parent as string | undefined);
          publishOpts = {
            ...commonPublish,
            wiki: { spaceId: String(wikiSpace), ...(parentNodeToken ? { parentNodeToken: String(parentNodeToken) } : {}) },
          };
        } else {
          publishOpts = {
            ...commonPublish,
            ...(folder ? { folderToken: folder } : {}),
          };
        }
      }

      const result = await publishDocument(client, publishOpts);
      if (cache && job.absPath !== 'stdin') {
        cache.set(job.absPath, {
          docId: result.documentId,
          url: result.url,
          title: converted.title,
          hash,
          updatedAt: new Date().toISOString(),
        });
        cache.save();
      }
      const engineTag = result.engine === 'official' ? pc.magenta('官方引擎') : '';
      const status = result.created
        ? pc.green(`已创建 · ${result.blockCount} 块`)
        : result.diff
          ? pc.yellow(`已增量更新 · 保留 ${result.diff.kept} / 补丁 ${result.diff.patched} / 删 ${result.diff.deleted} / 增 ${result.diff.inserted}`)
          : pc.yellow(`已更新 · ${result.blockCount} 块`);
      const suffix = result.imageCount > 0 ? ` · 图片 ${result.imageCount}` : '';
      results.push({ display: job.display, url: result.url, status: [status + suffix, engineTag].filter(Boolean).join(' ') });
    } catch (err) {
      failures++;
      const message = err instanceof FeishuApiError ? err.message : err instanceof Error ? err.message : String(err);
      console.error(pc.red(`✗ ${job.display}：${message}`));
      results.push({ display: job.display, status: pc.red('失败') });
    }
  }

  if (opts.dryRun) {
    const json = JSON.stringify({ tool: 'md2feishu', version: VERSION, files: dryRunFiles }, dryRunReplacer, 2);
    if (opts.out) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(opts.out, json, 'utf-8');
      console.log(pc.green(`✓ dry-run 结果已写入 ${opts.out}（${jobs.length} 个文件）`));
    } else {
      console.log(json);
    }
    return;
  }

  console.log();
  console.log(pc.bold('发布结果：'));
  for (const r of results) {
    const link = r.url ? `  ${pc.cyan(r.url)}` : '';
    console.log(`  ${r.display}${link ? link : ''}  ${r.status}`);
  }
  if (failures > 0) process.exitCode = 1;
}
