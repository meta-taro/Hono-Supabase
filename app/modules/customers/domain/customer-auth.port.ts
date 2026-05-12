// ---------------------------------------------------------------------------
// CustomerAuthPort = サインアップ機能の domain interface（hexagonal の「port」）。
//
// 何のために存在するか:
//   application 層は「Supabase Auth」という具体技術を知ってはいけない。
//   サインアップに必要な振る舞いだけを domain 用語で抽象化し、
//   実装（Adapter）は infrastructure 層に置く。
//
// 戻り値が authUserId だけになっている理由:
//   サインアップ完了時点では customers 行はまだ DB トリガによって挿入された
//   直後で、application 層は CustomerRepository.findByAuthUserId() で
//   Customer Entity を取り直す。「ID だけ通す」設計にしておくことで、
//   この port は「auth ユーザーを作る」責務だけに専念できる。
// ---------------------------------------------------------------------------
export interface CustomerSignUpInput {
  email: string;
  password: string;
  name: string;
}

export interface CustomerSignUpResult {
  authUserId: string;
}

export interface CustomerAuthPort {
  signUp(input: CustomerSignUpInput): Promise<CustomerSignUpResult>;
}
