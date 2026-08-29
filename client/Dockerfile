# Client image (STORY-015).
#
# NOT BUILT OR RUN — see server/Dockerfile.
#
# Vite output is static files, so the runtime stage is a web server and none of
# the build toolchain. Nothing from `deps` reaches the final image.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci --include-workspace-root --workspace client
COPY client ./client
RUN npm run build --workspace client

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/client/dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
