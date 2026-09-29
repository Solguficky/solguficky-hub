#!/bin/sh
# Клиент живого пульта: аргументы склеиваются в одну команду и уходят
# POST-ом. Код 0 — команда исполнена, 22 — пульт отверг её или Telegram отказал
# (ответ всё равно напечатан), 7 — пульт не слушает: он поднимается
# `just telegram-live-console`.
#
#   sh tests/telegram-live/console/send.sh press Ближайшие сходки
#   sh tests/telegram-live/console/send.sh        # справка и готовность
set -eu

url="http://127.0.0.1:${LIVE_CONSOLE_PORT:-7358}/"

if [ "$#" -eq 0 ]; then
  exec curl -sS --fail-with-body "$url"
fi
printf '%s' "$*" | exec curl -sS --fail-with-body --data-binary @- "$url"
