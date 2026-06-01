// 「役立った」投票トグルの結果。cake / shop の両レビュー・付与/取消のすべてで共通。
//   helpfulCount: 操作後の現在の投票数（reviews.helpful_count / shop_reviews.helpful_count に一致）
//   voted:        操作後に呼び出しユーザーが投票している状態か（付与=true / 取消=false）
export interface HelpfulVoteResult {
  helpfulCount: number;
  voted: boolean;
}
