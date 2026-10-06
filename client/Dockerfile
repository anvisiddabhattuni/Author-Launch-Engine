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

# 1.30.5 (stable) since 2026-10-06: Clair's first real scan found 157 known
# vulnerabilities in the 1.27 image's Alpine packages (OpenSSL 3.3.3, zlib,
# c-ares). Digest from Docker Hub for the 2026-10-05 build, not from memory.
FROM nginxinc/nginx-unprivileged:1.30.5-alpine@sha256:15c994d10d6d78658721c3bcafff14cb281fba2a4bdf9d5ba92c416a472516e3 AS runtime
# nginx-unprivileged rather than nginx (STORY-034): the stock image starts its
# master process as root. This one runs as uid 101 and listens on 8080 — the
# port nginx.conf already used — so a flaw in nginx is not a root shell.
COPY --from=build /app/client/dist /usr/share/nginx/html
# A template (STORY-061): the image's entrypoint substitutes the resolver and
# upstream at start. Defaults suit Compose; the chart sets ALE_API_UPSTREAM.
COPY client/nginx.conf /etc/nginx/templates/default.conf.template
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    ALE_API_UPSTREAM=api:4000
EXPOSE 8080
