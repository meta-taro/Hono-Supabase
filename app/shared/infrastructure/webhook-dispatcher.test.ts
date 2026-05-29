import { describe, it, expect } from 'vitest';
import type { WebhookEvent } from '@/shared/domain/webhook-event';
import { createFetchWebhookDispatcher } from './webhook-dispatcher';

// ---------------------------------------------------------------------------
// FetchWebhookDispatcher のユニットテスト
//   fake fetch で 2xx / 4xx / 5xx / timeout / network error を再現し、
//   結果が { kind, message } の規約どおりに分岐すること、
//   署名 / イベント識別子ヘッダが付与されることを検証する。
// ---------------------------------------------------------------------------

const EVENT: WebhookEvent = {
  event_id: 'evt-1',
  event_type: 'order.placed',
  occurred_at: '2026-05-26T00:00:00.000Z',
  data: {
    order_id: 'ord-1',
    customer_id: 'cus-1',
    items: [{ cake_id: 'cake-1', quantity: 1, unit_price: 500 }],
    total_amount: 500,
  },
};

const VALID_SECRET = 'a'.repeat(64);

const fixedNow = () => new Date('2026-05-26T00:00:00.000Z');

describe('FetchWebhookDispatcher.deliver', () => {
  it('2xx 応答は succeeded を返す', async () => {
    const fakeFetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const d = createFetchWebhookDispatcher({ fetcher: fakeFetch, now: fixedNow });
    const r = await d.deliver(EVENT, { url: 'https://example.com/hook', secret: VALID_SECRET });
    expect(r).toEqual({ kind: 'succeeded' });
  });

  it('3xx 応答も succeeded に倒す（リダイレクトも受信成功扱い）', async () => {
    const fakeFetch = (async () => new Response(null, { status: 301 })) as unknown as typeof fetch;
    const d = createFetchWebhookDispatcher({ fetcher: fakeFetch, now: fixedNow });
    const r = await d.deliver(EVENT, { url: 'https://example.com/hook', secret: VALID_SECRET });
    expect(r.kind).toBe('succeeded');
  });

  it('4xx 応答は failed + HTTP <status> メッセージ', async () => {
    const fakeFetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const d = createFetchWebhookDispatcher({ fetcher: fakeFetch, now: fixedNow });
    const r = await d.deliver(EVENT, { url: 'https://example.com/hook', secret: VALID_SECRET });
    expect(r).toEqual({ kind: 'failed', message: 'HTTP 404' });
  });

  it('5xx 応答は failed', async () => {
    const fakeFetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    const d = createFetchWebhookDispatcher({ fetcher: fakeFetch, now: fixedNow });
    const r = await d.deliver(EVENT, { url: 'https://example.com/hook', secret: VALID_SECRET });
    expect(r).toEqual({ kind: 'failed', message: 'HTTP 503' });
  });

  it('fetch が throw（ネットワーク不到達など）したら failed + 例外メッセージ', async () => {
    const fakeFetch = (async () => {
      throw new Error('ENOTFOUND example.invalid');
    }) as unknown as typeof fetch;
    const d = createFetchWebhookDispatcher({ fetcher: fakeFetch, now: fixedNow });
    const r = await d.deliver(EVENT, { url: 'https://example.invalid/hook', secret: VALID_SECRET });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') {
      expect(r.message).toBe('ENOTFOUND example.invalid');
    }
  });

  it('timeoutMs を超過すると AbortController で failed に倒す', async () => {
    // 50ms 後に解決する fake fetch を timeoutMs=10ms で叩く。
    const fakeFetch = ((_url: string, init: RequestInit | undefined) => {
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => {
          resolve(new Response(null, { status: 200 }));
        }, 50);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('The operation was aborted'));
        });
      });
    }) as unknown as typeof fetch;
    const d = createFetchWebhookDispatcher({ fetcher: fakeFetch, now: fixedNow, timeoutMs: 10 });
    const r = await d.deliver(EVENT, { url: 'https://example.com/hook', secret: VALID_SECRET });
    expect(r.kind).toBe('failed');
  });

  it('POST + JSON body + 署名 / イベント識別子ヘッダを必ず送る', async () => {
    let captured: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {
      url: '',
    };
    const fakeFetch = (async (url: string, init: RequestInit | undefined) => {
      const headers: Record<string, string> = {};
      const raw = init?.headers;
      if (raw instanceof Headers) {
        raw.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === 'string') headers[k.toLowerCase()] = v;
        }
      }
      captured = {
        url,
        method: init?.method,
        headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const d = createFetchWebhookDispatcher({ fetcher: fakeFetch, now: fixedNow });
    await d.deliver(EVENT, { url: 'https://example.com/hook', secret: VALID_SECRET });
    expect(captured.url).toBe('https://example.com/hook');
    expect(captured.method).toBe('POST');
    expect(captured.headers?.['content-type']).toContain('application/json');
    expect(captured.headers?.['x-webhook-event-id']).toBe('evt-1');
    expect(captured.headers?.['x-webhook-event-type']).toBe('order.placed');
    expect(captured.headers?.['x-webhook-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    // body は JSON.stringify(event) と一致する（署名と同じ raw 文字列）
    expect(captured.body).toBe(JSON.stringify(EVENT));
  });
});
