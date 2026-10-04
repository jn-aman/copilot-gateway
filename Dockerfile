FROM --platform=$BUILDPLATFORM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
FROM dependencies AS build
COPY . .
RUN bun run check

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
WORKDIR /app
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun LICENSE NOTICE ./
RUN mkdir -p /data && chown bun:bun /data && chmod 700 /data
LABEL org.opencontainers.image.title="Copilot Gateway" \
      org.opencontainers.image.description="OpenAI and Anthropic compatible Copilot inference gateway" \
      org.opencontainers.image.licenses="MIT"
USER bun
ENV HOST=0.0.0.0 NODE_ENV=production XDG_DATA_HOME=/data
EXPOSE 4141
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD bun -e 'fetch("http://127.0.0.1:"+(process.env.PORT||4141)+"/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["bun", "dist/main.js", "start"]
