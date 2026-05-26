import type { AppLogger } from '@/shared/infrastructure/logger';
import type { EventPublisher } from '@/shared/application/event-publisher';
import type { OrderRepository, PlaceOrderItem } from '../domain/order.repository';
import type { Order } from '../domain/order';
import { CustomerId } from '../domain/customer-id.vo';
import { CakeId } from '../domain/cake-id.vo';
import { OrderQuantity } from '../domain/order-quantity.vo';
import { InvalidOrderError } from '../domain/order.errors';
import { orderPlacedEvent, toOrderPlacedWebhookEvent } from '../domain/order-placed.event';

// UseCase 入力 DTO はプリミティブ型のみ（domain VO は外部から見せない）。
export interface PlaceOrderInput {
  customerId: string;
  items: { cakeId: string; quantity: number }[];
}

// 業務手順:
//   1. プリミティブ → VO 変換（壊れた UUID / quantity はここで弾かれる）
//   2. 構造的不変条件の早期チェック（明細 0 件 / 同一商品の重複行）
//      → repository.place 経由で DB を巻き込む前に弾くことで、無駄な接続を防ぐ
//   3. repository.place() で「在庫減算 + 注文作成」をアトミック実行
//   4. 完成した Order に対して OrderPlaced ドメインイベントを発行
//      - 構造化ログ（observability 用）
//      - EventPublisher（webhook 配信 enqueue 用、Phase 10 Step 7 で導入）
//
// なぜ Order.create() を直接呼ばないのか:
//   - 本番経路は単価を DB 側でロック取得時にスナップショットする（価格改竄防止）
//   - そのため UseCase は「items[cakeId, quantity]」だけを渡し、
//     完成済みの Order を repository から受け取る
//   - Order.create() は in-memory リポジトリ + テスト経路でのみ使われる
//
// EventPublisher の失敗は注文確定を巻き戻さない:
//   - 副系（webhook 配信）が落ちても主系（注文確定）の成功は守る
//   - そのため publisher.publish() を try/catch で囲んで warn ログに留める
//   - publisher 側実装（WebhookEventPublisher）もこの方針に従い throw しないが、
//     念のため UseCase 側でも防御する（多重防御 + 将来別実装の差し替え耐性）
export const createPlaceOrderUseCase = (
  repo: OrderRepository,
  logger: AppLogger,
  publisher: EventPublisher,
) => {
  return async (input: PlaceOrderInput): Promise<Order> => {
    // 早期チェック: 明細 0 件は VO 変換前に弾く（VO 変換の例外より意味が明確）
    if (input.items.length === 0) {
      throw new InvalidOrderError('注文には商品が 1 つ以上必要です');
    }

    // VO 化（壊れた値はここで InvalidOrderError / InvalidOrderItemError として表面化）
    const customerId = CustomerId.from(input.customerId);
    const items: PlaceOrderItem[] = input.items.map((i) => ({
      cakeId: CakeId.from(i.cakeId),
      quantity: OrderQuantity.of(i.quantity),
    }));

    // 同一 cakeId が 2 行以上に分かれて来たら、業務的に意味が曖昧なので拒否する。
    // クライアント側で 1 行にまとめてもらう運用ポリシー。
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.cakeId.value)) {
        throw new InvalidOrderError('同一商品は 1 行にまとめて指定してください');
      }
      seen.add(item.cakeId.value);
    }

    const order = await repo.place({ customerId, items });

    // 構造化ログでの OrderPlaced イベント（既存の observability 経路、互換のため維持）。
    logger.info(orderPlacedEvent(order), 'OrderPlaced');

    // 外部 webhook 配信向けの publish。失敗しても注文確定は成功扱い。
    try {
      await publisher.publish(toOrderPlacedWebhookEvent(order));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown error';
      logger.warn(
        { orderId: order.id.value, message },
        'OrderPlaced イベントの publish に失敗（注文確定は成功扱い）',
      );
    }

    return order;
  };
};

export type PlaceOrderUseCase = ReturnType<typeof createPlaceOrderUseCase>;
