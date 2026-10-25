/**
 * 飞书开放平台 HTTP 客户端：tenant_access_token 管理、并发控制、
 * 指数退避重试、错误码中文翻译。
 *
 * 并发模型（对应官方两条限流）：
 * - 应用级 3 QPS：全局「起步间隔」节流——只约束请求的发起时刻，
 *   不等待响应返回，网络往返可以流水线重叠，吞吐逼近 3 QPS 上限；
 * - 单文档 3 编辑/秒：按 channel（文档 ID）串行排队，保证同文档操作有序；
 * - 图片上传走 drive 域独立限速（默认 200ms 间隔），可与文档编辑并行。
 */

export interface FeishuClientOptions {
  appId?: string;
  appSecret?: string;
  /** 直接使用 user_access_token（优先于 app 凭证） */
  userToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 任意两个请求发起时刻的最小间隔（毫秒），默认 350 ≈ 2.8 QPS */
  minIntervalMs?: number;
  /** 图片上传请求的最小间隔（毫秒），默认 200（drive 域限速与文档编辑独立） */
  uploadIntervalMs?: number;
  log?: (msg: string) => void;
}

export class FeishuApiError extends Error {
  constructor(
    public readonly code: number,
    public readonly msg: string,
    public readonly endpoint: string,
    public readonly httpStatus?: number,
  ) {
    super(`飞书 API 错误 [${code}] ${msg}（${endpoint}）\n${hintFor(code)}`);
    this.name = 'FeishuApiError';
  }
}

const RETRYABLE_CODES = new Set([99991400]); // 应用请求频率超限

/** 常见错误码 → 中文排查建议 */
const ERROR_HINTS: Record<number, string> = {
  99991661: 'app_id 或 app_secret 不正确：请在飞书开放平台「凭证与基础信息」页核对，并确认应用已发布（版本管理→创建版本并发布）。',
  99991663: 'app_id 不正确或应用不存在：请核对 cli_a 开头的 App ID。',
  99991668: 'tenant_access_token 无效或已过期：请重新获取。',
  99991672: '授权错误：当前接口不适用所使用的 token 类型（tenant/user），或应用未开通对应权限范围。',
  99991679: 'IP 不在应用白名单内：请在开放平台「安全设置」中调整 IP 白名单。',
  99991400: '触发应用级限流（3 次/秒）：工具会自动退避重试，无需处理。',
  230002: '无权限：请把目标文件夹/文档/知识库共享给应用——右键资源「…→添加文档应用」或分享给应用（机器人），授予可编辑权限。',
  91403: '无权限：请把应用添加为协作者（可编辑）后重试。',
  1770002: '文档或资源不存在：请确认 ID 是否正确、文档未被删除、且应用有访问权限。',
  1770004: '文档块数量超上限：请拆分文档。',
  1770005: '块层级过深：请减少嵌套层级。',
  1770007: '单个块的子块数量超上限。',
  1770008: '文件尺寸超上限。',
  1770010: '表格列数超上限。',
  1770011: '表格单元格数量超上限。',
  1770035: '单次请求资源数超限（图片≤20）：工具会自动分批，如仍报错请反馈 issue。',
};

export function hintFor(code: number): string {
  return ERROR_HINTS[code] ?? '请根据错误码查阅 https://open.feishu.cn/document/server-docs/docs/error-codes 或提交 issue。';
}

interface TokenCache {
  token: string;
  expireAt: number;
}

export class FeishuClient {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly uploadIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private tokenCache: TokenCache | null = null;
  /** 全局起步时刻节流（应用 3 QPS） */
  private nextStartAt = 0;
  /** 按通道（一般传 documentId）串行，保证同文档编辑有序 */
  private channelTails = new Map<string, Promise<unknown>>();
  /** 上传独立队列与间隔 */
  private uploadChain: Promise<unknown> = Promise.resolve();
  private uploadNextStartAt = 0;

  constructor(private readonly options: FeishuClientOptions) {
    this.baseUrl = options.baseUrl ?? 'https://open.feishu.cn';
    this.minIntervalMs = options.minIntervalMs ?? 350;
    this.uploadIntervalMs = options.uploadIntervalMs ?? 200;
    this.fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  get usingUserToken(): boolean {
    return Boolean(this.options.userToken);
  }

  /** 同步预约下一个请求的发起时刻（原子，避免并发读到同一起点） */
  private reserveMainStart(): number {
    const now = Date.now();
    const start = Math.max(now, this.nextStartAt);
    this.nextStartAt = start + this.minIntervalMs;
    return start;
  }

  private reserveUploadStart(): number {
    const now = Date.now();
    const start = Math.max(now, this.uploadNextStartAt);
    this.uploadNextStartAt = start + this.uploadIntervalMs;
    return start;
  }

  private runChannel<T>(channel: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.channelTails.get(channel) ?? Promise.resolve();
    const p = tail
      .catch(() => undefined)
      .then(async () => {
        const start = this.reserveMainStart();
        if (start > Date.now()) await sleep(start - Date.now());
        return fn();
      })
      .finally(() => {
        if (this.channelTails.get(channel) === p) this.channelTails.delete(channel);
      });
    this.channelTails.set(channel, p);
    return p;
  }

  private async runUpload<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.uploadChain;
    const p = (async () => {
      await prev.catch(() => undefined);
      const start = this.reserveUploadStart();
      if (start > Date.now()) await sleep(start - Date.now());
      return fn();
    })();
    this.uploadChain = p;
    return p;
  }

  async getAccessToken(): Promise<string> {
    if (this.options.userToken) return this.options.userToken;
    if (this.tokenCache && this.tokenCache.expireAt > Date.now() + 60_000) return this.tokenCache.token;
    if (!this.options.appId || !this.options.appSecret) {
      throw new Error('缺少飞书应用凭证：请先运行 md2feishu init，或设置 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量。');
    }
    const res = await this.runChannel('auth', () =>
      this.fetchImpl(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.options.appId, app_secret: this.options.appSecret }),
      }),
    );
    const body = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new FeishuApiError(body.code ?? -1, body.msg ?? '获取 tenant_access_token 失败', '/auth/v3/tenant_access_token/internal', res.status);
    }
    this.tokenCache = { token: body.tenant_access_token, expireAt: Date.now() + (body.expire ?? 3600) * 1000 };
    return this.tokenCache.token;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    init: { query?: Record<string, string | number | undefined>; body?: unknown; channel?: string } = {},
  ): Promise<T> {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
    const channel = init.channel ?? 'default';

    let attempt = 0;
    while (true) {
      attempt++;
      const token = await this.getAccessToken();
      let res: Response;
      try {
        res = await this.runChannel(channel, () =>
          this.fetchImpl(url.toString(), {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(payload ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
            },
            body: payload,
          }),
        );
      } catch (err) {
        if (attempt < 4) {
          this.options.log?.(`网络错误，重试 (${attempt}/3)：${(err as Error).message}`);
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(`网络请求失败：${(err as Error).message}（${url.pathname}）`);
      }
      const text = await res.text();
      let body: { code?: number; msg?: string } = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        if (attempt < 4 && (res.status === 429 || res.status >= 500)) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(`飞书返回了非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 200)}`);
      }
      const retryable = res.status === 429 || res.status >= 500 || RETRYABLE_CODES.has(body.code ?? -1);
      if (retryable && attempt < 4) {
        this.options.log?.(`被限流/服务错误（HTTP ${res.status}，code ${body.code}），退避重试 (${attempt}/3)`);
        await sleep(backoffMs(attempt));
        continue;
      }
      if (body.code !== 0) {
        throw new FeishuApiError(body.code ?? -1, body.msg ?? '未知错误', url.pathname, res.status);
      }
      return body as T;
    }
  }

  /** multipart 上传（图片素材），走 drive 域独立限速 */
  async uploadForm<T = unknown>(path: string, form: FormData): Promise<T> {
    let attempt = 0;
    while (true) {
      attempt++;
      const token = await this.getAccessToken();
      let res: Response;
      try {
        res = await this.runUpload(() =>
          this.fetchImpl(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: form,
          }),
        );
      } catch (err) {
        if (attempt < 4) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(`上传失败：${(err as Error).message}`);
      }
      const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
      const retryable = res.status === 429 || res.status >= 500 || RETRYABLE_CODES.has(body.code ?? -1);
      if (retryable && attempt < 4) {
        await sleep(backoffMs(attempt));
        continue;
      }
      if (body.code !== 0) {
        throw new FeishuApiError(body.code ?? -1, body.msg ?? '上传失败', path, res.status);
      }
      return body as T;
    }
  }
}

function backoffMs(attempt: number): number {
  return 600 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
