#!/usr/bin/env bash
# =============================================================================
# zero-downtime-watch.sh
#   Phase 7 Step 9 (a) — 「ゼロダウンタイムデプロイ」体験用スクリプト（bash 版）
#   PowerShell 版（zero-downtime-watch.ps1）と同じことを bash でやる。
#
#   何をする?:
#     指定した Worker の /health を 0.2 秒間隔で叩き続け、毎回
#       時刻  HTTP ステータス
#     を 1 行ずつ表示する。接続断・5xx・タイムアウトが起きたら "ERROR" 行が混ざる。
#     何も混ざらなければ無停止切替できている。
#
#   使い方（ターミナルを 2 枚開く）:
#     ── ターミナル A（このスクリプト = 監視ループ）──────────────────────
#       pnpm exec wrangler deployments list --env staging   # いまの稼働バージョンを確認（任意）
#       bash scripts/zero-downtime-watch.sh                 # 監視開始（Ctrl+C で停止）
#
#     ── ターミナル B（デプロイを打つ側）────────────────────────────────
#       pnpm wrangler:deploy:staging                        # ← これを実行（新バージョンに即時 100% 切替）
#       pnpm exec wrangler deployments list --env staging   # 新しい deployment が一覧の先頭に出たか確認
#
#   オプション（位置引数）:
#     $1  叩く URL（既定: staging の /health）
#     $2  ポーリング間隔秒（既定: 0.2）
#   例: bash scripts/zero-downtime-watch.sh https://cake-shop-api.rzrhacympbmdkagoybba.workers.dev/health
# =============================================================================
set -u
URL="${1:-https://cake-shop-api-staging.rzrhacympbmdkagoybba.workers.dev/health}"
INTERVAL="${2:-0.2}"

echo "watching ${URL}  (interval ${INTERVAL}s, Ctrl+C to stop)"

while true; do
  printf '%s  ' "$(date +%H:%M:%S.%3N)"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL" || echo '000')"
  if [ "$code" = "200" ]; then
    echo "$code"
  else
    echo ">>> ERROR  http_code=$code"
  fi
  sleep "$INTERVAL"
done
