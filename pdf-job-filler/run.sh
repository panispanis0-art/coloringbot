#!/usr/bin/env bash
# Linux/macOS: ./run.sh web | bot | dev
cd "$(dirname "$0")"
case "${1:-web}" in
  web) [ -f web/dist/index.html ] || npm run build; npm run preview ;;
  dev) npm run dev ;;
  bot) npm run bot ;;
  *) echo "usage: ./run.sh web|dev|bot"; exit 1 ;;
esac
