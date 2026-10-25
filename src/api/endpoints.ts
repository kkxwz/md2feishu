import type { FeishuClient } from './client.js';

/** 创建 docx 文档，返回 document_id */
export async function createDocument(
  client: FeishuClient,
  title: string,
  folderToken?: string,
): Promise<string> {
  const res = await client.request<{ data: { document: { document_id: string } } }>('POST', '/open-apis/docx/v1/documents', {
    body: { title, ...(folderToken ? { folder_token: folderToken } : {}) },
  });
  return res.data.document.document_id;
}

export interface FeishuBlockInfo {
  block_id: string;
  parent_id?: string;
  children?: string[];
  block_type: number;
}

/** 获取文档所有块（自动分页） */
export async function listAllBlocks(client: FeishuClient, documentId: string): Promise<FeishuBlockInfo[]> {
  const items: FeishuBlockInfo[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.request<{ data: { items?: FeishuBlockInfo[]; page_token?: string; has_more?: boolean } }>(
      'GET',
      `/open-apis/docx/v1/documents/${documentId}/blocks`,
      { query: { page_size: 500, document_revision_id: -1, page_token: pageToken }, channel: `doc:${documentId}` },
    );
    items.push(...(res.data.items ?? []));
    pageToken = res.data.has_more ? res.data.page_token : undefined;
  } while (pageToken);
  return items;
}

export interface DescendantPayload {
  block_id: string;
  block_type: number;
  children?: string[];
  text?: unknown;
  heading1?: unknown;
  heading2?: unknown;
  heading3?: unknown;
  heading4?: unknown;
  heading5?: unknown;
  heading6?: unknown;
  heading7?: unknown;
  heading8?: unknown;
  heading9?: unknown;
  bullet?: unknown;
  ordered?: unknown;
  todo?: unknown;
  code?: unknown;
  callout?: unknown;
  quote_container?: unknown;
  divider?: unknown;
  image?: unknown;
  table?: unknown;
  table_cell?: unknown;
}

/**
 * 创建嵌套块（核心写入接口）：
 * POST /docx/v1/documents/:doc/blocks/:blockId/descendant
 * children_id 只放第一层子块的临时 ID；descendants 为整棵子树的扁平列表。
 * 返回 临时ID→真实ID 映射。index 为 -1 时追加到末尾。
 */
export async function createDescendants(
  client: FeishuClient,
  documentId: string,
  parentBlockId: string,
  childrenId: string[],
  descendants: DescendantPayload[],
  index?: number,
): Promise<Map<string, string>> {
  const res = await client.request<{
    data: { block_id_relations?: { block_id: string; temporary_block_id: string }[] };
  }>('POST', `/open-apis/docx/v1/documents/${documentId}/blocks/${parentBlockId}/descendant`, {
    query: { document_revision_id: -1 },
    body: index === undefined ? { children_id: childrenId, descendants } : { index, children_id: childrenId, descendants },
    channel: `doc:${documentId}`,
  });
  const map = new Map<string, string>();
  for (const rel of res.data.block_id_relations ?? []) map.set(rel.temporary_block_id, rel.block_id);
  return map;
}

/** 删除父块指定范围的子块：[startIndex, endIndex) 左闭右开 */
export async function batchDeleteChildren(
  client: FeishuClient,
  documentId: string,
  parentBlockId: string,
  startIndex: number,
  endIndex: number,
): Promise<void> {
  await client.request('DELETE', `/open-apis/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children/batch_delete`, {
    query: { document_revision_id: -1 },
    body: { start_index: startIndex, end_index: endIndex },
    channel: `doc:${documentId}`,
  });
}

/** 更新文档标题：通过 page 块（block_id = document_id）的 update_text_elements */
export async function updateDocumentTitle(client: FeishuClient, documentId: string, title: string): Promise<void> {
  await client.request('PATCH', `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}`, {
    query: { document_revision_id: -1 },
    body: { update_text_elements: { elements: [{ text_run: { content: title } }] } },
    channel: `doc:${documentId}`,
  });
}

/**
 * 原位补丁一个文本类块的内容（保留 block_id 与其上的评论）：
 * update_text_elements 替换元素；可选 update_text_style（fields: 1=对齐 2=done 4=语言 5=换行）。
 */
export async function patchTextBlock(
  client: FeishuClient,
  documentId: string,
  blockId: string,
  elements: unknown[],
  style?: { align?: number; done?: boolean; language?: number; wrap?: boolean },
): Promise<void> {
  const fields: number[] = [];
  if (style?.align !== undefined) fields.push(1);
  if (style?.done !== undefined) fields.push(2);
  if (style?.language !== undefined) fields.push(4);
  if (style?.wrap !== undefined) fields.push(5);
  const body: Record<string, unknown> = { update_text_elements: { elements } };
  if (fields.length > 0) {
    const styleObj: Record<string, unknown> = {};
    if (style?.align !== undefined) styleObj.align = style.align;
    if (style?.done !== undefined) styleObj.done = style.done;
    if (style?.language !== undefined) styleObj.language = style.language;
    if (style?.wrap !== undefined) styleObj.wrap = style.wrap;
    body.update_text_style = { style: styleObj, fields };
  }
  await client.request('PATCH', `/open-apis/docx/v1/documents/${documentId}/blocks/${blockId}`, {
    query: { document_revision_id: -1 },
    body,
    channel: `doc:${documentId}`,
  });
}

/** 把已上传素材设置到图片块（replace_image） */
export async function replaceImageToken(
  client: FeishuClient,
  documentId: string,
  imageBlockId: string,
  fileToken: string,
): Promise<void> {
  await client.request('PATCH', `/open-apis/docx/v1/documents/${documentId}/blocks/${imageBlockId}`, {
    query: { document_revision_id: -1 },
    body: { replace_image: { token: fileToken } },
    channel: `doc:${documentId}`,
  });
}

/** 官方引擎：Markdown/HTML → 文档块（不落盘，需 docx:document.block:convert 权限） */
export async function convertMarkdownBlocks(
  client: FeishuClient,
  content: string,
  contentType: 'markdown' | 'html' = 'markdown',
): Promise<{ firstLevelBlockIds: string[]; blocks: ConvertBlock[] }> {
  const res = await client.request<{
    data: { first_level_block_ids?: string[]; blocks?: ConvertBlock[] };
  }>('POST', '/open-apis/docx/v1/documents/blocks/convert', {
    body: { content_type: contentType, content },
  });
  return { firstLevelBlockIds: res.data.first_level_block_ids ?? [], blocks: res.data.blocks ?? [] };
}

/** 官方 convert 接口返回的块结构 */
export interface ConvertBlock {
  block_id: string;
  block_type: number;
  children?: string[];
  parent_id?: string;
  revision_id?: number;
  text?: Record<string, unknown>;
  heading1?: Record<string, unknown>;
  heading2?: Record<string, unknown>;
  heading3?: Record<string, unknown>;
  heading4?: Record<string, unknown>;
  heading5?: Record<string, unknown>;
  heading6?: Record<string, unknown>;
  heading7?: Record<string, unknown>;
  heading8?: Record<string, unknown>;
  heading9?: Record<string, unknown>;
  bullet?: Record<string, unknown>;
  ordered?: Record<string, unknown>;
  todo?: Record<string, unknown>;
  code?: Record<string, unknown>;
  quote?: Record<string, unknown>;
  callout?: Record<string, unknown>;
  quote_container?: Record<string, unknown>;
  divider?: Record<string, unknown>;
  image?: Record<string, unknown>;
  table?: { property?: Record<string, unknown> } & Record<string, unknown>;
  table_cell?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 上传图片素材并挂到指定图片块（parent_type=docx_image），返回 file_token */
export async function uploadDocxImage(
  client: FeishuClient,
  imageBlockId: string,
  fileName: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(bytes)], { type: mimeType }), fileName);
  form.append('file_name', fileName);
  form.append('parent_type', 'docx_image');
  form.append('parent_node', imageBlockId);
  form.append('size', String(bytes.byteLength));
  const res = await client.uploadForm<{ data: { file_token: string } }>(
    '/open-apis/drive/v1/medias/upload_form',
    form,
  );
  return res.data.file_token;
}

export interface WikiNodeInfo {
  space_id: string;
  node_token: string;
  obj_token: string;
  obj_type: string;
  title: string;
}

/** 在知识库创建 docx 节点，返回节点信息（obj_token 即 document_id） */
export async function createWikiDocxNode(
  client: FeishuClient,
  spaceId: string,
  title: string,
  parentNodeToken?: string,
): Promise<WikiNodeInfo> {
  const res = await client.request<{ data: { node: WikiNodeInfo } }>(
    'POST',
    `/open-apis/wiki/v2/spaces/${spaceId}/nodes`,
    { body: { obj_type: 'docx', node_type: 'origin', title, ...(parentNodeToken ? { parent_node_token: parentNodeToken } : {}) } },
  );
  return res.data.node;
}

/** 解析知识库节点 token → 实际文档 token */
export async function getWikiNode(client: FeishuClient, token: string): Promise<WikiNodeInfo> {
  const res = await client.request<{ data: { node: WikiNodeInfo } }>('GET', '/open-apis/wiki/v2/spaces/get_node', {
    query: { token, obj_type: 'wiki' },
  });
  return res.data.node;
}

/** 从文档 URL / 纯 token 解析出 document_id；wiki 链接会自动解析为 obj_token */
export async function resolveDocumentId(
  client: FeishuClient,
  input: string,
): Promise<{ documentId: string; wikiNodeToken?: string }> {
  const trimmed = input.trim();
  // https://xxx.feishu.cn/docx/<id> 或 /wiki/<node>
  const urlMatch = trimmed.match(/(?:feishu\.cn|larksuite\.com)\/(docx|wiki)\/([A-Za-z0-9]+)/);
  if (urlMatch) {
    if (urlMatch[1] === 'docx') return { documentId: urlMatch[2] };
    const node = await getWikiNode(client, urlMatch[2]);
    return { documentId: node.obj_token, wikiNodeToken: node.node_token };
  }
  if (/^(doxcn|wikcn)[A-Za-z0-9]+/.test(trimmed)) {
    if (trimmed.startsWith('wikcn')) {
      const node = await getWikiNode(client, trimmed);
      return { documentId: node.obj_token, wikiNodeToken: node.node_token };
    }
    return { documentId: trimmed };
  }
  throw new Error(`无法识别的文档地址或 ID："${trimmed}"（支持 https://x.feishu.cn/docx/xxx、/wiki/xxx 或 doxcn/wikcn 开头的 token）`);
}
