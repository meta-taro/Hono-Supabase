import { ValidationError, ConflictError, NotFoundError } from '@/shared/domain/errors';

// ドメイン例外は shared/domain/errors の AppError 体系を継承する。
// これにより error-handler が自動で 400 / 404 / 409 へマッピングしてくれる。

// 注文構造（item 数 0 件・上限超過・同一 cake 重複等）に関する不変条件違反。
export class InvalidOrderError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOrderError';
  }
}

// OrderQuantity / OrderItem の値が不正なとき。
export class InvalidOrderItemError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOrderItemError';
  }
}

// 在庫不足は「業務的に競合した」ことなので CONFLICT (409) として扱う。
// VALIDATION_ERROR (400) ではない理由: 入力自体は正しい（在庫の状態と競合しただけ）。
export class InsufficientStockError extends ConflictError {
  constructor(cakeId: string, available: number, requested: number) {
    super(
      `商品 (id=${cakeId}) の在庫が不足しています（在庫: ${String(available)}, 要求: ${String(requested)}）`,
    );
    this.name = 'InsufficientStockError';
  }
}

// 注文に含まれる cakeId が cakes に存在しない（削除済み等）。
// 業務的には「無効な参照」なので NOT_FOUND ではなく VALIDATION_ERROR が筋に近いが、
// CLAUDE.md の API 設計では「指定リソースなし = 404」を採用するため NotFoundError を選択する。
export class CakeNotFoundInOrderError extends NotFoundError {
  constructor(cakeId: string) {
    super(`注文された商品 (id=${cakeId}) は存在しません`);
    this.name = 'CakeNotFoundInOrderError';
  }
}

// 注文者の customerId が customers に存在しない。
// Phase 6 で JWT から customer_id を引く設計に変えるとほぼ起きなくなるが、
// 防御的にマッピングを残す（service_role 経由の管理 API 等で発生し得る）。
export class CustomerNotFoundInOrderError extends NotFoundError {
  constructor(customerId: string) {
    super(`注文者の顧客 (id=${customerId}) は存在しません`);
    this.name = 'CustomerNotFoundInOrderError';
  }
}

// GET /v1/orders/:id で対象が見つからない場合。
export class OrderNotFoundError extends NotFoundError {
  constructor(orderId: string) {
    super(`注文 (id=${orderId}) が見つかりません`);
    this.name = 'OrderNotFoundError';
  }
}
