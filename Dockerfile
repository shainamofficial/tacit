# One image for every Tacit process (plan §2: Fly.io/Railway in P0–P1).
# The workspace runs from TypeScript sources through tsx, the same way it runs
# locally — no build step to drift from what CI typechecks and tests.
#   scripts/start.sh mcp      MCP server            (PORT 3333)
#   scripts/start.sh admin    connect flow          (PORT 3400)
#   scripts/start.sh migrate  apply migrations      (release command)
#   scripts/start.sh compile --org=<id> --budget=<usd>
#   scripts/start.sh seed     load the Northwind corpus (demo orgs only)
FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true
RUN corepack enable

WORKDIR /app
COPY . .
# Dev dependencies stay: tsx is the runtime, and the pipeline's eval tooling is part of the image
# (`seed`, `eval`) so a demo org can be exercised from a machine.
RUN pnpm install --frozen-lockfile && chmod +x scripts/start.sh

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV TACIT_STAGE_CACHE_DIR=/data/stage-cache
EXPOSE 3333 3400
ENTRYPOINT ["/app/scripts/start.sh"]
CMD ["mcp"]
