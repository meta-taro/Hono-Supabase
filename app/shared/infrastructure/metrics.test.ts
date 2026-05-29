import { describe, it, expect, vi } from 'vitest';
import {
  createAnalyticsEngineRecorder,
  createNoopMetricsRecorder,
  statusClass,
  type AnalyticsBinding,
  type AnalyticsDataPoint,
  type RequestMetricInput,
} from './metrics';

// ---------------------------------------------------------------------------
// statusClass
//   HTTP ステータスを粗い分類（'1xx' 〜 '5xx'）に丸める。
//   index に入れる値で、SQL の WHERE で 5xx 率を出す用途のため、
//   境界（199/200/299/300/399/400/499/500）の挙動を全て押さえる。
// ---------------------------------------------------------------------------

describe('statusClass', () => {
  it.each<[number, string]>([
    [100, '1xx'],
    [199, '1xx'],
    [200, '2xx'],
    [204, '2xx'],
    [299, '2xx'],
    [300, '3xx'],
    [399, '3xx'],
    [400, '4xx'],
    [404, '4xx'],
    [499, '4xx'],
    [500, '5xx'],
    [503, '5xx'],
    [599, '5xx'],
  ])('status=%d → "%s"', (status, expected) => {
    expect(statusClass(status)).toBe(expected);
  });

  it('範囲外（負値・0）は "1xx" に倒す（防御的）', () => {
    expect(statusClass(0)).toBe('1xx');
    expect(statusClass(-1)).toBe('1xx');
  });
});

// ---------------------------------------------------------------------------
// createAnalyticsEngineRecorder
//   writeDataPoint(event) に { blobs, doubles, indexes } 形式で 1 イベントを書く。
//   blob の並び順は metrics.ts のコメントで定義した順序（method/route/status_class/env/app_version）
//   を厳密に守ること。SQL 側で blob1=method 前提でクエリを書くため、並び換えは破壊的変更。
// ---------------------------------------------------------------------------

const baseInput: RequestMetricInput = {
  method: 'GET',
  route: '/v1/cakes',
  status: 200,
  duration_ms: 42,
  env: 'staging',
  app_version: 'abc123',
};

describe('createAnalyticsEngineRecorder', () => {
  const setup = () => {
    const writeDataPoint = vi.fn<(event?: AnalyticsDataPoint) => void>();
    const binding: AnalyticsBinding = { writeDataPoint };
    return { binding, writeDataPoint };
  };

  it('blob/double/index を期待通りの並び順で書く（2xx）', () => {
    const { binding, writeDataPoint } = setup();
    const recorder = createAnalyticsEngineRecorder(binding);

    recorder.recordRequest(baseInput);

    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['GET', '/v1/cakes', '2xx', 'staging', 'abc123'],
      doubles: [42],
      indexes: ['2xx'],
    });
  });

  it('5xx は status_class が "5xx" になる（blob3 と index 両方）', () => {
    const { binding, writeDataPoint } = setup();
    const recorder = createAnalyticsEngineRecorder(binding);

    recorder.recordRequest({ ...baseInput, status: 503 });

    const call = writeDataPoint.mock.calls[0]?.[0];
    expect(call?.blobs?.[2]).toBe('5xx');
    expect(call?.indexes?.[0]).toBe('5xx');
  });

  it('4xx も同様に分類される', () => {
    const { binding, writeDataPoint } = setup();
    const recorder = createAnalyticsEngineRecorder(binding);

    recorder.recordRequest({ ...baseInput, status: 404 });

    const call = writeDataPoint.mock.calls[0]?.[0];
    expect(call?.blobs?.[2]).toBe('4xx');
    expect(call?.indexes?.[0]).toBe('4xx');
  });

  it('duration_ms は doubles[0] に乗る', () => {
    const { binding, writeDataPoint } = setup();
    const recorder = createAnalyticsEngineRecorder(binding);

    recorder.recordRequest({ ...baseInput, duration_ms: 1234 });

    const call = writeDataPoint.mock.calls[0]?.[0];
    expect(call?.doubles).toEqual([1234]);
  });
});

// ---------------------------------------------------------------------------
// createNoopMetricsRecorder
//   Node ローカル / テスト / Workers binding 未注入時に使う。
//   呼ばれても落ちないことと、副作用がないことを確認するだけ。
// ---------------------------------------------------------------------------

describe('createNoopMetricsRecorder', () => {
  it('recordRequest を呼んでも例外を投げない', () => {
    const recorder = createNoopMetricsRecorder();
    expect(() => {
      recorder.recordRequest(baseInput);
    }).not.toThrow();
  });
});
