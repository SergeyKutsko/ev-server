FROM node:18-alpine AS builder

ARG build

WORKDIR /usr/builder

COPY package.json pnpm-lock.yaml ./
COPY LICENSE NOTICE ./
COPY src ./src
COPY types ./types
COPY build ./build
COPY *.json ./
COPY docker/config.json ./src/assets/config.json
COPY webpack.config.js ./
COPY ./nginx/default.conf ./nginx/default.conf
COPY ./nginx/key ./nginx/key
COPY ./nginx/crt ./nginx/crt
COPY entrypoint.sh ./


RUN set -ex \
  && apk add --no-cache --virtual .gyp build-base python3 git \
  && corepack enable \
  && corepack prepare pnpm@latest --activate \
  && pnpm set progress=false \
  && pnpm config set depth 0 \
  && pnpm install --ignore-scripts \
  && pnpm build:prod \
  && apk del .gyp

FROM node:18-alpine

ARG STACK_TRACE_LIMIT=1024
ARG MAX_OLD_SPACE_SIZE=768

ENV NODE_OPTIONS="--stack-trace-limit=${STACK_TRACE_LIMIT} --max-old-space-size=${MAX_OLD_SPACE_SIZE}"

WORKDIR /usr/app
COPY --from=builder /usr/builder/node_modules ./node_modules
COPY --from=builder /usr/builder/dist ./dist
COPY --from=builder /usr/builder/nginx ./nginx
COPY --from=builder /usr/builder/entrypoint.sh ./entrypoint.sh

EXPOSE 80 8000 8010 8080 9090 9292

RUN set -ex && apk add --no-cache gcompat
RUN set -ex && apk add nginx

RUN adduser -D -g 'www' www
RUN chown -R www:www /var/lib/nginx

COPY ./nginx/default.conf /etc/nginx/nginx.conf
COPY ./nginx/key /etc/nginx/key
COPY ./nginx/crt /etc/nginx/crt

# For Profiler
RUN npm install -g pm2 clinic autocannon

# CMD /wait && node -r source-map-support/register --stack-trace-limit=1024 dist/start.js
# CMD pm2-runtime dist/start.js
