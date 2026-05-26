// ---------------------------------------------------------------------------
// WebhookSubscription Entity（webhooks コンテキストの集約根）
//
//   配信先 URL と HMAC 鍵を保持する。
//
//   なぜ class ではなく interface + factory に分けないか:
//     現状この entity は「読み書きのデータ容れ物」が主用途で振る舞いが薄い。
//     ただし将来 active/inactive のトグルや URL バリデーションを増やすことを見越して
//     class 形式にしておく（cake.ts と同じ判断）。
// ---------------------------------------------------------------------------

const URL_MAX_LENGTH = 2048;
const SECRET_MIN_LENGTH = 32;
const SECRET_MAX_LENGTH = 256;

export class WebhookSubscriptionInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSubscriptionInvalidError';
  }
}

const assertUrl = (url: string): void => {
  if (url.length === 0 || url.length > URL_MAX_LENGTH) {
    throw new WebhookSubscriptionInvalidError(
      `URL は 1〜${String(URL_MAX_LENGTH)} 文字で指定してください`,
    );
  }
  // http/https 以外を弾く。Workers fetch も http(s) しか受け付けないため業務上も妥当。
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new WebhookSubscriptionInvalidError('URL は http または https である必要があります');
    }
  } catch (e) {
    if (e instanceof WebhookSubscriptionInvalidError) throw e;
    throw new WebhookSubscriptionInvalidError('URL の形式が不正です');
  }
};

const assertSecret = (secret: string): void => {
  if (secret.length < SECRET_MIN_LENGTH || secret.length > SECRET_MAX_LENGTH) {
    throw new WebhookSubscriptionInvalidError(
      `secret は ${String(SECRET_MIN_LENGTH)}〜${String(SECRET_MAX_LENGTH)} 文字で指定してください`,
    );
  }
};

export class WebhookSubscription {
  private constructor(
    public readonly id: string,
    public readonly url: string,
    public readonly secret: string,
    public readonly description: string | null,
    public readonly active: boolean,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}

  // 新規作成: id / createdAt / updatedAt はアプリ側で採番（テスト容易性のため）。
  // 本番経路では DB 側 default で gen_random_uuid()/now() を採用するため、
  // 実 Repository は INSERT 後に DB の値で reconstruct する。
  static create(input: {
    id: string;
    url: string;
    secret: string;
    description?: string | null;
    active?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  }): WebhookSubscription {
    assertUrl(input.url);
    assertSecret(input.secret);
    const now = new Date();
    return new WebhookSubscription(
      input.id,
      input.url,
      input.secret,
      input.description ?? null,
      input.active ?? true,
      input.createdAt ?? now,
      input.updatedAt ?? now,
    );
  }

  // 永続化からの復元: VO 化なしで信頼するが、URL / secret は再検証する（Fail-Fast）。
  static reconstruct(props: {
    id: string;
    url: string;
    secret: string;
    description: string | null;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): WebhookSubscription {
    assertUrl(props.url);
    assertSecret(props.secret);
    return new WebhookSubscription(
      props.id,
      props.url,
      props.secret,
      props.description,
      props.active,
      props.createdAt,
      props.updatedAt,
    );
  }
}
