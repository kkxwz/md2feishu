# md2feishu

> A powerful yet easy-to-use CLI that publishes Markdown as Feishu (Lark) cloud documents — in a single command.

[简体中文](README.md) · English

## Highlights

Most existing Markdown→Feishu tools miss a few pieces; this project fills the gaps (a survey of 8 representative tools guided the feature set):

- **GFM tables** → native Feishu tables (unlimited rows, header row, auto column widths)
- **Math** → inline and block-level KaTeX formulas (block formulas auto-prefixed with `\displaystyle`)
- **GFM Alerts** (`> [!NOTE]` etc.) → Feishu callout blocks (5 color/emoji presets)
- **Images** → local / remote / data URIs auto-downloaded, uploaded, and size-sniffed
- **In-place updates** → structural diff keeps unchanged blocks (and their comments) intact; only patches/inserts/deletes what changed
- **Incremental sync** → content-hash skip, directory-level batch push, multi-document pipelining close to the 3 QPS API cap
- **Wiki publishing** → target a space and parent node; front-matter declares title/folder/wiki per file
- **Mermaid** → `--mermaid image` renders diagrams (local mmdc → online renderer → falls back to a code block)
- **Dual engines** → precise built-in converter + `--engine official` (Feishu's own Markdown→blocks API) as a compatibility fallback
- **Friendly errors** → common Feishu error codes translated into actionable Chinese hints

## Getting Started

```bash
npm install
npm run build
npm link        # gives you the global `md2feishu` / `md2f` commands

md2feishu init     # interactive setup: Feishu App ID/Secret → ~/.md2feishu/config.json
md2feishu check    # verify credentials
md2feishu push example/demo.md -v
```

Requires Node.js ≥ 18.17. You need a Feishu custom app with `docx:document`, `drive:drive`, and (optionally) `wiki:wiki` scopes, and the target folder/wiki shared to the app. See the [Chinese README](README.md) for the full 5-minute permission guide.

## Usage

```bash
md2feishu push hello.md                          # publish to the app's cloud space root
md2feishu push hello.md --folder fldcnXXXX       # target folder
md2feishu push docs/                             # publish a whole directory recursively
md2feishu push notes/ --wiki 7123456789          # publish to a wiki space
md2feishu push readme.md --update https://x.feishu.cn/docx/doxcnXXXX   # update in place
md2feishu push a.md --dry-run                    # offline: dump the converted block JSON
```

Re-pushing an unchanged file is skipped automatically; a changed file is updated via structural diff (link stays, untouched blocks keep their comments).

## Markdown Support

Headings (first H1 becomes the doc title), inline styles, links, nested lists, task lists, ordered-list start numbers, blockquotes, GFM alerts, tables, fenced code (70+ language enum mapping), inline/block math, images, horizontal rules, hard breaks, footnotes, and YAML front-matter. See the [Chinese README](README.md) for the full mapping table and known limitations.

## Library Usage

```ts
import { parseMarkdown, convertDocument, publishDocument, FeishuClient } from 'md2feishu';

const doc = convertDocument(parseMarkdown(md), { fallbackTitle: 'a' });
const client = new FeishuClient({ appId: 'cli_x', appSecret: 'xxx' });
const result = await publishDocument(client, {
  title: doc.title, blocks: doc.blocks, baseDir: process.cwd(), folderToken: 'fldcnXXX',
});
```

## Support the Author

If this project helps you, consider buying me a coffee ☕

<p align="center">
  <img src="docs/images/wechat-donate.png" width="200" alt="WeChat Donate QR Code">
</p>

## Contributing

Issues and pull requests are welcome!

```bash
npm test          # 88 vitest cases (converter / publisher / diff / mock-server e2e)
npm run typecheck
npm run build
node dist/cli.js push example/demo.md --dry-run   # offline conversion check
```

## License

MIT
