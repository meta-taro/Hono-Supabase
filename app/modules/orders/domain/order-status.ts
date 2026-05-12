// Phase 5 では PLACED（受注確定）/ CANCELED（キャンセル済み）の 2 値で表現する。
// PAID / SHIPPED / DELIVERED 等は決済機能を載せる Phase 8（仮）以降に追加する。
// 文字列リテラル union を採用しているのは、
//   - Zod / DB CHECK 制約と表現が完全一致して読み手に優しい
//   - enum と違って tree-shaking が効く / Workers でも問題なく動く
// から。
export type OrderStatus = 'PLACED' | 'CANCELED';

export const ORDER_STATUSES: readonly OrderStatus[] = ['PLACED', 'CANCELED'];

export const isOrderStatus = (value: unknown): value is OrderStatus =>
  typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
