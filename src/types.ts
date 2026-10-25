/**
 * 内部文档块模型：Markdown AST 与飞书 API payload 之间的中间表示。
 * 转换器（convert/*）产出 BlockNode 树，发布器（publisher.ts）负责上传。
 */

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  inlineCode?: boolean;
  linkUrl?: string;
}

export type InlineElement =
  | { type: 'text'; content: string; style: TextStyle }
  | { type: 'equation'; content: string };

export type ImageKind = 'local' | 'remote' | 'data' | 'mermaid';

export interface ImageSource {
  /** 原始 src，用于去重与日志 */
  src: string;
  kind: ImageKind;
  /** 本地图片的绝对/相对路径 */
  path?: string;
  /** 图片二进制内容（data URI 解码或远程下载后） */
  data?: Uint8Array;
  /** 文件名（含扩展名），上传时使用 */
  fileName?: string;
  /** 从内容推断的 MIME 类型 */
  mimeType?: string;
  alt?: string;
}

export type BlockKind =
  | 'text'
  | 'heading'
  | 'bullet'
  | 'ordered'
  | 'todo'
  | 'code'
  | 'quote'
  | 'equation'
  | 'divider'
  | 'image'
  | 'table'
  | 'callout';

export interface CalloutStyle {
  emoji: string;
  backgroundColor: number;
  borderColor: number;
}

export interface BlockNode {
  kind: BlockKind;
  /** heading 级别 1-9 */
  level?: number;
  /** text/heading/bullet/ordered/todo 的行内内容 */
  elements?: InlineElement[];
  /** code 块 */
  code?: { content: string; language: number; rawLanguage: string };
  /** 块级公式 LaTeX */
  latex?: string;
  /** todo 是否完成 */
  done?: boolean;
  /** 有序列表起始编号（飞书块级样式） */
  orderedStart?: number;
  /** image */
  image?: ImageSource;
  /** 上传后回填的 file_token */
  imageToken?: string;
  /** 加载后探测的展示尺寸 */
  imageWidth?: number;
  imageHeight?: number;
  /** table */
  rows?: number;
  cols?: number;
  /** 行优先；每格为该单元格内的块列表 */
  cells?: BlockNode[][];
  columnWidths?: number[];
  /** callout */
  callout?: CalloutStyle;
  /** 容器（quote/callout）的子块；或列表项内的后续内容/嵌套列表 */
  children?: BlockNode[];
  /** 源 Markdown 行号（诊断用） */
  line?: number;
}

export interface Frontmatter {
  title?: string;
  folder?: string;
  wiki_space?: string;
  wiki_parent?: string;
  [key: string]: unknown;
}

export interface ConvertedDoc {
  /** 用于创建文档的标题 */
  title: string;
  frontmatter: Frontmatter;
  blocks: BlockNode[];
  /** 转换过程中的非致命警告 */
  warnings: string[];
}
