// Review の公開状態。
//   published … 公開中。GET 一覧 / 集計に乗る。
//   hidden    … 非公開（ワードフィルタや flag_count 超過で自動 hidden 化される予定。Phase 11 Step 4）。
//                投稿者本人と admin だけ閲覧可能（Step 5 admin API で実装）。GET 一覧には出さない。
//   removed   … 完全削除相当（admin による強制削除 or 投稿者の自己削除）。
//                行は残るが UNIQUE 制約から外れて再投稿可能になる（infrastructure 側の partial index で対応）。
export const REVIEW_STATUSES = ['published', 'hidden', 'removed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const isReviewStatus = (value: string): value is ReviewStatus =>
  (REVIEW_STATUSES as readonly string[]).includes(value);
