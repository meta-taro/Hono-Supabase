# ============================================================
# マルチステージビルド
#
# Stage 1 (deps):        依存パッケージのインストール
# Stage 2 (development): 開発用（tsx watch でホットリロード）
# Stage 3 (builder):     TypeScript → JavaScript のビルド
# Stage 4 (production):  本番用（最小イメージ）
# ============================================================

# pnpm を有効にするベースイメージ
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine AS base
# corepack で pnpm を有効化（Node 22 に同梱）
RUN corepack enable pnpm

# ─────────────────────────────────────────────
# Stage 1: 依存パッケージのインストール
# ─────────────────────────────────────────────
FROM base AS deps
WORKDIR /app

# package.json と lockfile のみ先にコピー（Docker レイヤーキャッシュを活用）
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ─────────────────────────────────────────────
# Stage 2: 開発用（docker compose 用）
# ─────────────────────────────────────────────
FROM base AS development
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json ./
# app/ はボリュームマウントで上書きされるため COPY 不要

EXPOSE 3000
CMD ["pnpm", "dev"]

# ─────────────────────────────────────────────
# Stage 3: TypeScript ビルド
# ─────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ─────────────────────────────────────────────
# Stage 4: 本番用（最小イメージ）
# ─────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS production
WORKDIR /app

# セキュリティ: root 以外のユーザーで実行
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# 本番依存のみインストール
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod

# ビルド済み成果物のみコピー
COPY --from=builder /app/dist ./dist

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
