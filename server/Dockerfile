# API image (STORY-015).
#
# NOT BUILT OR RUN. Docker is not installed on the machine this was written on,
# so this file has never been executed — it is a reviewed starting point, not a
# tested artefact, and the README says so beside it. Treating an unbuilt
# Dockerfile as a finished deployment is the failure this story is most likely
# to produce.
# Base images are pinned by digest (STORY-034). A tag like `22-alpine` is a
# name for whatever was pushed last; the same Dockerfile built on two days can
# produce two different images, and a vulnerability scan of one says nothing
# about the other. The tag stays beside the digest so a person can read it.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/
# The workspace root install, without the client's build toolchain.
RUN npm ci --omit=dev --workspace server --include-workspace-root

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
WORKDIR /app
# Never root. A container that runs as root turns a code-execution bug into a
# host problem.
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY package.json ./
COPY server ./server
USER app

ENV NODE_ENV=production
EXPOSE 4000

# Liveness, not readiness: this decides whether to restart the container, and a
# missing migration is not something a restart fixes. The platform's own
# readiness probe should call /api/ready — see the README.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so the process is PID 1 and receives SIGTERM directly. Under a
# shell wrapper the signal goes to the shell and the graceful shutdown this
# story added never runs.
CMD ["node", "server/src/index.js"]
