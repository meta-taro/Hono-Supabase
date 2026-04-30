import { describe, it, expect } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { errorHandler } from '@/lib/error-handler';
import { NotFoundError, ValidationError } from '@/lib/errors';

const buildTestApp = (): OpenAPIHono => {
  const app = new OpenAPIHono();
  app.get('/throw-app-error', () => {
    throw new NotFoundError('テストリソースが見つかりません');
  });
  app.get('/throw-validation-error', () => {
    throw new ValidationError('入力が不正です', [
      { field: 'price', message: '0より大きい整数を指定してください' },
    ]);
  });
  app.get('/throw-unknown', () => {
    throw new Error('boom');
  });
  app.onError(errorHandler);
  return app;
};

describe('errorHandler', () => {
  it('AppError を統一エラーレスポンス形式で返す', async () => {
    const app = buildTestApp();
    const res = await app.request('/throw-app-error');
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'テストリソースが見つかりません',
      },
    });
  });

  it('details があるときは details を含めて返す', async () => {
    const app = buildTestApp();
    const res = await app.request('/throw-validation-error');
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: Array<{ field: string; message: string }> };
    };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toEqual([
      { field: 'price', message: '0より大きい整数を指定してください' },
    ]);
  });

  it('想定外エラーは 500 INTERNAL_SERVER_ERROR で返す', async () => {
    const app = buildTestApp();
    const res = await app.request('/throw-unknown');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
  });
});
