# Client image (STORY-015).
#
# BUILT AND RUN (STORY-054) — see server/Dockerfile.
#
# Vite output is static files, so the runtime stage is a web server and none of
# the build toolchain. Nothing from `deps` reaches the final image.
# Base images are pinned by digest (STORY-034). A tag like `22-alpine` is a
# name for whatever was pushed last; the same Dockerfile built on two days can
# produce two different images, and a vulnerability scan of one says nothing
# about the other. The tag stays beside the digest so a person can read it.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci --include-workspace-root --workspace client
COPY client ./client
# vite.config.js imports the one CSP both the UI and the API send (STORY-031).
# It has no imports of its own; without it the first real build failed (STORY-054).
COPY server/src/services/securityHeaders.js ./server/src/services/securityHeaders.js
# STORY-030: a public build does not show the demo passwords on its login page.
ENV VITE_SHOW_DEMO_LOGINS=false
RUN npm run build --workspace client

FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0 AS runtime
# nginx-unprivileged rather than nginx (STORY-034): the stock image starts its
# master process as root. This one runs as uid 101 and listens on 8080 — the
# port nginx.conf already used — so a flaw in nginx is not a root shell.
COPY --from=build /app/client/dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
