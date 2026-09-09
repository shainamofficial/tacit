#!/bin/sh
# Container entrypoint: one image, one process per container.
set -eu
cmd="${1:-${TACIT_PROCESS:-mcp}}"
[ "$#" -gt 0 ] && shift
case "$cmd" in
  mcp)
    export PORT="${PORT:-3333}"
    exec pnpm --silent mcp "$@"
    ;;
  admin)
    export PORT="${PORT:-3400}"
    exec pnpm --silent admin "$@"
    ;;
  migrate)
    exec pnpm --silent db:migrate "$@"
    ;;
  compile)
    exec pnpm --silent compile "$@"
    ;;
  seed)
    exec pnpm --silent seed:northwind "$@"
    ;;
  eval)
    exec pnpm --silent eval "$@"
    ;;
  *)
    echo "unknown process '$cmd' (mcp | admin | migrate | compile | seed | eval)" >&2
    exit 2
    ;;
esac
