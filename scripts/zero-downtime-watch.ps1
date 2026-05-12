# =============================================================================
# zero-downtime-watch.ps1
#   Phase 7 Step 9 (a) — 「ゼロダウンタイムデプロイ」体験用スクリプト（PowerShell 版）
#
#   何をする?:
#     指定した Worker の /health を 0.2 秒間隔で叩き続け、毎回
#       時刻  HTTP ステータス  レスポンスボディ
#     を 1 行ずつ表示する。デプロイ中にエラー（接続断・5xx・タイムアウト）が
#     起きたら ">>> ERROR" 行が混ざる。── 何も混ざらなければ無停止切替できている。
#
#   使い方（ターミナルを 2 枚開く）:
#     ── ターミナル A（このスクリプト = 監視ループ）──────────────────────
#       pnpm exec wrangler deployments list --env staging   # いまの稼働バージョンを確認（任意）
#       # PowerShell 7（pwsh）が無い環境（Windows 標準の 5.1）:
#       powershell -ExecutionPolicy Bypass -File .\scripts\zero-downtime-watch.ps1
#       # pwsh があるなら:  pwsh scripts/zero-downtime-watch.ps1   （いずれも Ctrl+C で停止）
#
#     ── ターミナル B（デプロイを打つ側）────────────────────────────────
#       pnpm wrangler:deploy:staging                        # ← これを実行（新バージョンに即時 100% 切替）
#       pnpm exec wrangler deployments list --env staging   # 新しい deployment が一覧の先頭に出たか確認
#
#     → ターミナル A のログを目視。200 OK が途切れず、">>> ERROR" が
#       1 行も出なければ「ゼロダウンタイムデプロイ」を体験できた、ということ。
#
#   オプション:
#     -Url       叩く URL（既定: staging の /health）
#     -IntervalSeconds  ポーリング間隔（既定: 0.2）
#   例: powershell -ExecutionPolicy Bypass -File .\scripts\zero-downtime-watch.ps1 -Url https://cake-shop-api.rzrhacympbmdkagoybba.workers.dev/health
# =============================================================================
[CmdletBinding()]
param(
  [string]$Url = 'https://cake-shop-api-staging.rzrhacympbmdkagoybba.workers.dev/health',
  [double]$IntervalSeconds = 0.2
)

Write-Host "watching $Url  (interval ${IntervalSeconds}s, Ctrl+C to stop)" -ForegroundColor Cyan

while ($true) {
  $t = Get-Date -Format 'HH:mm:ss.fff'
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
    "$t  $($r.StatusCode)  $($r.Content)"
  } catch {
    Write-Host "$t  >>> ERROR  $($_.Exception.Message)" -ForegroundColor Red
  }
  Start-Sleep -Seconds $IntervalSeconds
}
