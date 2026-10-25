export { parseMarkdown, type ParsedMarkdown } from './convert/parse.js';
export { convertDocument, plainText, type ConvertOptions } from './convert/blocks.js';
export { convertInline, mergeElements } from './convert/inline.js';
export { mapCodeLanguage, CODE_LANGUAGE } from './convert/languages.js';
export { FeishuClient, FeishuApiError, hintFor, type FeishuClientOptions } from './api/client.js';
export {
  createDocument,
  createDescendants,
  batchDeleteChildren,
  updateDocumentTitle,
  uploadDocxImage,
  replaceImageToken,
  createWikiDocxNode,
  getWikiNode,
  resolveDocumentId,
  listAllBlocks,
  type DescendantPayload,
  type WikiNodeInfo,
} from './api/endpoints.js';
export { loadImage, sniffImage, displaySize, renderMermaid, type MermaidRenderOptions } from './api/images.js';
export {
  patchTextBlock,
  convertMarkdownBlocks,
  type ConvertBlock,
} from './api/endpoints.js';
export {
  planBatches,
  buildTopPayloads,
  collectImages,
  preloadImages,
  publishDocument,
  clearDocument,
  dryRunReplacer,
  type PublishBatch,
  type PublishOptions,
  type PublishResult,
  type TopPayload,
  type UpdateMode,
} from './publisher.js';
export { applyDiffUpdate, planDiffOps, type DiffSummary } from './diff.js';
export {
  publishWithOfficialEngine,
  sanitizeConvertBlocks,
  planOfficialBatches,
  extractImageSources,
} from './engine-official.js';
export { loadConfig, saveGlobalConfig, SyncCache, globalConfigPath, type FeishuConfig, type CacheEntry } from './config.js';
export type * from './types.js';
