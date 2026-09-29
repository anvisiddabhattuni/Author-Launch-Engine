# API image (STORY-015).
#
# BUILT AND RUN (STORY-054, 2026-09-28): built with Docker under Colima and run
# on a local Kubernetes cluster (k3s) through the Helm chart in deploy/helm/.
# Written in STORY-015 without Docker and never executed until then; the first
# real build found three faults a review had not (noted where they were fixed).
# Not yet run: on a cloud cluster, or behind a real load balancer.
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
# npm workspaces hoist every dependency to the root node_modules, so
# server/node_modules usually does not exist — and the COPY below failed on
# the first real build (STORY-054). Created empty when there is nothing in it.
RUN npm ci --omit=dev --workspace server --include-workspace-root && mkdir -p server/node_modules

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
WORKDIR /app
# Never root. A container that runs as root turns a code-execution bug into a
# host problem.
# A numeric id (STORY-054): Kubernetes' runAsNonRoot can only verify a
# number, and refused to start pods whose image named its user.
RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY package.json ./
COPY server ./server
USER 10001

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
