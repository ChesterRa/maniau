# 置き場所（Railway）で動かすイメージ。手元でも同じ定義から組み立てて確かめる。
# 入れるのは下の COPY に挙げた物だけ。鍵・手元だけの物・評価の記録は入れない（.dockerignore でも渡す前に除く）。
# 元のイメージは digest で固定する（同じ名札でも中身が替わるため）。上げる時は名札と digest を一緒に直す。
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# node を最初のプロセス（PID 1）にしない。PID 1 の node は止める信号（SIGTERM）を受けても止まらず、強制終了を
# 待つことになる。置き場所では docker run --init を使えないので、小さな init（tini）を入れて、信号を渡す。
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

# pnpm は、package.json の packageManager の版を corepack で使う（組み立ての時だけ。動かす時は使わない）。
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# 依存を入れる（package.json と lock が変わらなければ、この層を使い回す）。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/verify/package.json packages/verify/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# 動かす物と、画面を組み立てる物。サーバーは動く時に、デモの材料（data/demo）、移行の SQL（drizzle）、
# 読み取りの指示（src/reading/prompts）、画面の日本語の文（apps/web/src/locales）を読む。家庭の初期化と
# 知らせの確かめの台本（scripts）も、置き場所の中で動かせるように入れる。
COPY packages/core/tsconfig.json packages/core/
COPY packages/core/src packages/core/src
COPY packages/verify/tsconfig.json packages/verify/
COPY packages/verify/src packages/verify/src
COPY apps/server/tsconfig.json apps/server/
COPY apps/server/src apps/server/src
COPY apps/server/scripts apps/server/scripts
COPY apps/server/drizzle apps/server/drizzle
COPY apps/web/tsconfig.json apps/web/index.html apps/web/vite.config.ts apps/web/
COPY apps/web/public apps/web/public
COPY apps/web/src apps/web/src
COPY data/demo data/demo
RUN pnpm build

# 動かす時は root でない利用者で、pnpm を通さずに入口を直に動かす。容器の中に .env は無く、設定は置き場所の
# 環境変数だけ（PORT は置き場所で決める。無ければ 8787）。
USER node
WORKDIR /app/apps/server
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "src/main.ts"]
