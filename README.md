# md2feishu

> 强大而易用的 Markdown → 飞书云文档发布工具。一个命令，把 Markdown 变成排版精美的飞书文档。
>
> [简体中文](README.md) · [English](README.en.md)

[![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-green)](https://nodejs.org) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE) [![Tests](https://img.shields.io/badge/tests-88%20passed-brightgreen)](#开发) [![CI](https://img.shields.io/badge/CI-github--actions-2088FF)](./.github/workflows/ci.yml)

<p align="center">
  <a href="#快速开始3-分钟">快速开始</a> ·
  <a href="#为什么又一个-md2feishu">功能</a> ·
  <a href="#markdown-语法支持">语法支持</a> ·
  <a href="#已知限制">已知限制</a> ·
  <a href="#作为库使用">库用法</a> ·
  <a href="#贡献">贡献</a>
</p>

## 为什么又一个 md2feishu？

GitHub 上已有若干 Markdown→飞书的工具，但调研（feishu-cli、feishu-docx、feishu-markdown、obsidian 同步插件等 8 个代表项目）后发现几乎每家都缺几块拼图。本项目的差异化：

| 能力 | md2feishu | 一般现有工具 |
| --- | --- | --- |
| **GFM 表格** | ✓ 原生飞书表格（任意行数、表头行、自动列宽） | 常见痛点：9 行限制、逐格填充慢 |
| **数学公式** | ✓ 行内 + 块级（KaTeX，块级自动加 `\displaystyle` 渲染上下标） | 多数不支持，最好的也只降级为行内 |
| **mermaid** | ✓ `--mermaid image` 渲染为图（本地 mmdc → 在线服务 → 自动回退代码块） | 分裂：图片/不支持/偷懒占位 |
| **GFM Alerts**（`> [!NOTE]`） | ✓ 映射为飞书高亮块（5 种配色/emoji） | 几乎无人支持 |
| **图片** | ✓ 本地/远程/data URI 自动下载并上传，自动读取尺寸 | 多数只支持本地，或仅放占位 |
| **更新已有文档** | ✓ **结构化 diff 原位更新**：未变块与评论原样保留，只补丁/删除/新增变化区间 | 多为删旧建新（链接丢失）或整篇覆盖 |
| **增量同步** | ✓ 内容哈希未变自动跳过，目录级批量 | 各家自搞一套或没有 |
| **知识库发布** | ✓ 指定 space / 父节点 | 覆盖不全 |
| **front-matter** | ✓ 标题/文件夹/知识库随文件声明 | 无人支持 |
| **转换引擎** | ✓ builtin 精确控制 + `--engine official` 官方 Markdown 转块接口兜底 | 单一引擎 |
| **使用形态** | CLI + 可编程 npm 库 | 单一形态 |
| **错误体验** | ✓ 常见错误码中文翻译 + 排查建议 | 原始报错 |

## 安装

```bash
# 本地开发安装（当前仓库）
npm install
npm run build
npm link        # 之后即可全局使用 md2feishu / md2f

# 或作为依赖
npm install md2feishu
```

要求 Node.js ≥ 18.17（零原生依赖，跨平台）。

## 快速开始（3 分钟）

### 1. 创建飞书应用（一次性）

1. 打开 [飞书开放平台](https://open.feishu.cn) → **创建企业自建应用**
2. **凭证与基础信息** 页拿到 `App ID` / `App Secret`
3. **权限管理** 开通（搜索勾选后点开通）：
   - `docx:document` — 创建及编辑新版文档
   - `drive:drive` — 上传图片素材（用不到图片可不选）
   - `wiki:wiki` — 知识库读写（不用知识库可不选）
4. **版本管理** → 创建版本 → 申请发布（管理员审核通过即生效）
5. **把资源共享给应用**（关键！否则会报 230002 无权限）：
   - 发布到文件夹：右键目标文件夹 → 分享 → 添加应用为协作者（可编辑）
   - 发布到知识库：知识库设置 → 添加成员 → 搜索应用名（可编辑）

### 2. 初始化配置

```bash
md2feishu init     # 交互式填入 App ID / Secret / 域名等，写入 ~/.md2feishu/config.json
md2feishu check    # 验证凭证是否可用
```

### 3. 发布

```bash
md2feishu push hello.md                          # 发布到应用云空间根目录
md2feishu push hello.md --folder fldcnXXXX       # 发布到指定文件夹
md2feishu push docs/                             # 整个目录递归发布
md2feishu push notes/ --wiki 7123456789          # 发布到知识库
md2feishu push readme.md --update https://x.feishu.cn/docx/doxcnXXXX   # 原位更新已有文档
```

再次 push 同一文件时自动进入**增量模式**：内容没变直接跳过，变了则原位更新（链接不变）。

## 命令一览

```
md2feishu init                              交互式配置向导
md2feishu check                             校验凭证与权限准备状态
md2feishu push <paths...> [options]         发布文件/目录/stdin

push 选项：
  -t, --title <title>       文档标题（默认：front-matter > 首个 H1 > 文件名）
  -f, --folder <token>      目标文件夹 token
  -w, --wiki <spaceId>      发布到知识库
  -p, --wiki-parent <token> 知识库父节点 token
  -u, --update <docUrl|id>  更新指定文档（默认 diff 增量，链接不变）
  -d, --dry-run             只输出转换后的飞书块 JSON（不调用 API，可离线）
  -o, --out <file>          dry-run 结果写入文件
      --force-new           忽略缓存强制新建
      --no-cache            本次不读写增量缓存
      --ext <ext>           目录扫描扩展名（默认 md，逗号分隔）
      --keep-h1             不消费首个 H1 作为标题
      --mermaid <mode>      mermaid：code=纯文本（默认）/ image=渲染图片
      --update-mode <mode>  更新方式：diff=结构化增量（默认，保留未变块及评论）/ rebuild=清空重建
      --engine <engine>     转换引擎：builtin（默认）/ official（官方接口，需 docx:document.block:convert 权限）
      --no-display-style    块级公式不加 \displaystyle 前缀
      --user-token <token>  使用 user_access_token
      --config <path>       指定配置文件
  -v, --verbose             详细日志（限流重试、图片处理、diff 统计等）
```

也支持标准输入：`cat note.md | md2feishu push - --title "随手记"`。

再次 push 同一文件时自动进入**增量模式**：内容没变直接跳过；变了则做**结构化 diff 更新**——未变的块原样保留（块上的评论不丢、手动调整的图片尺寸不重置），只对变化块打补丁、按区间删除/新增，通常几秒完成；`--update-mode rebuild` 可退回清空重建。批量推目录时不同文档并行流水线，吞吐贴近官方 3 QPS 上限。

## front-matter 支持

在 Markdown 头部声明发布目标，命令行选项优先级更高：

```yaml
---
title: 季度汇报
folder: fldcnXXXX          # 目标文件夹
wiki_space: "7123456789"   # 或发布到知识库
wiki_parent: wikcnXXXX     # 知识库父节点
---
```

## Markdown 语法支持

| 语法 | 转换结果 |
| --- | --- |
| `# ~ ######` 标题 | 飞书标题 1–6 级（首个 H1 默认作为文档标题，`--keep-h1` 关闭） |
| **粗** *斜* ~~删~~ `码` [链](…) | 富文本 run + 局部样式，链接 URL 自动编码 |
| 列表（含无限嵌套） | 无序/有序块，嵌套层级成为子块 |
| `3. ` 起始编号 | 有序块 `sequence` 样式 |
| `- [x]` 任务 | 待办块（勾选状态保留） |
| `> ` 引用 | 引用容器（可嵌套任意内容） |
| `> [!NOTE/TIP/IMPORTANT/WARNING/CAUTION]` | 高亮块（蓝/绿/紫/黄/红 + 对应 emoji） |
| GFM 表格 | 原生表格块：任意行数、首行表头、按内容自动列宽 |
| ``` 围栏代码 | 代码块，70+ 语言枚举映射（ts/js/py/go/rust/sql/yaml/…） |
| ```mermaid | 默认纯文本代码块；`--mermaid image` 渲染为图片（失败自动回退） |
| `$...$` 行内公式 | 行内公式元素（KaTeX） |
| `$$...$$` 块级公式 | 独立公式段，自动加 `\displaystyle` 渲染 display 样式 |
| `![alt](src)` 图片 | 自动上传：本地（相对路径）/ 远程（自动下载）/ data URI，自动读取像素尺寸 |
| `---` 分割线 | 分割线块 |
| 硬换行（行尾两空格） | 段内软换行 |
| 脚注 `[^1]` | 引用保留 `[1]` 标记，定义汇总到文末列表 |
| front-matter | 标题与发布目标 |
| HTML 注释 | 忽略；`<br>` 转软换行；`<img>` 提取为图片块；其余 HTML 忽略 |

## 配置

优先级：命令行 > 环境变量 > 项目本地 `.md2feishu.json` > 全局 `~/.md2feishu/config.json`。

```jsonc
// ~/.md2feishu/config.json
{
  "appId": "cli_xxx",
  "appSecret": "xxx",
  "domain": "https://yourtenant.feishu.cn",  // 用于拼接文档链接（可选）
  "folder": "fldcnXXX",                       // 默认目标文件夹（可选）
  "wikiSpace": "7123456789",                  // 默认知识库（可选）
  "mermaidMode": "image",                     // mermaid 默认模式（可选）
  "mermaidRenderer": "https://kroki.internal/mermaid/png/{b64}",  // 自建渲染服务（可选，默认 mermaid.ink）
  "mermaidPreferLocal": true,                 // 优先本地 mmdc（默认 true）
  "updateMode": "diff",                       // 默认更新方式（可选）
  "engine": "builtin"                         // 默认转换引擎（可选）
}
```

环境变量：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_DOMAIN`、`FEISHU_FOLDER`、`FEISHU_WIKI_SPACE`。

增量缓存在 `~/.md2feishu/cache.json`（路径 → 文档 ID/链接/内容哈希），删除即重置。

## 已知限制

- **mermaid**：飞书代码块语言枚举无 Mermaid。默认按纯文本代码块插入；`--mermaid image` 渲染为 PNG（本地 mmdc 优先，未安装则用 mermaid.ink 在线渲染——图源码会发给该服务，介意隐私请自建 kroki 并配置 `mermaidRenderer`；全部失败自动回退代码块）。
- **块级公式**：飞书 OpenAPI 当前没有独立公式块类型，块级公式用「仅含公式元素的文本块」承载，并自动加 `\displaystyle` 让积分/求和上下标渲染在符号上下方（`--no-display-style` 关闭）。
- **diff 更新的边界**：① 只换了图片内容而前后文与尺寸都没变时，diff 会按位置保留旧图（此时用 `--update-mode rebuild` 强制重建）；② 有序列表起始编号变化不触发更新（飞书 API 读回的 sequence 不稳定，比对时忽略）；③ 引用/表格等容器内部变化时整个容器重建，容器内子块上的评论会丢。
- **限流**：官方限制单应用 3 次/秒、单文档 3 次编辑/秒。工具按文档通道串行 + 全局起步间隔流水线化，批量推多文档时逼近 3 QPS 上限；单篇大文档受官方限制仍需等待。
- 单请求块数 ≤1000、图片 ≤20，已自动分批。

## 首次真机验证清单（v0.2 新能力）

真实推送到飞书后，建议按此清单快速验收：

1. **块级公式**：发一篇含 `$$\int$$` 的文档，看公式是否正常渲染、积分上下标是否在符号上下方（`\displaystyle` 生效）。
2. **mermaid**：`md2feishu push x.md --mermaid image -v`，观察渲染走本地还是在线、图是否出现在文档里。
3. **diff 更新**：push 一篇 → 在飞书里给某段加一条**块级评论** → 修改 Markdown 另一段 → 再 push（应显示「保留 X / 补丁 1」）→ 确认评论还在、修改生效。
4. **并发**：push 一个多文件目录 `-v`，观察不同文档请求交错、总耗时明显低于逐篇串行。

## 作为库使用

```ts
import { parseMarkdown, convertDocument, publishDocument, FeishuClient } from 'md2feishu';

const parsed = parseMarkdown(await readFile('a.md', 'utf-8'));
const doc = convertDocument(parsed, { fallbackTitle: 'a' });

const client = new FeishuClient({ appId: 'cli_x', appSecret: 'xxx' });
const result = await publishDocument(client, {
  title: doc.title,
  blocks: doc.blocks,
  baseDir: process.cwd(),
  folderToken: 'fldcnXXX',
});
console.log(result.url, result.blockCount);
```

## 贡献

欢迎提交 Issue 和 Pull Request！

```bash
npm test          # vitest（88 个用例）
npm run build     # tsc 产物到 dist/
npm run typecheck
node dist/cli.js push example/demo.md --dry-run   # 离线检查转换结果
```

项目结构：`src/convert/*`（Markdown AST → 内部块模型）、`src/api/*`（飞书 HTTP 客户端/端点/图片）、`src/publisher.ts`（分批规划与发布流程）、`src/cli.ts`（命令行）。

## License

MIT
