#!/bin/sh
# Клиент пульта провода бота: аргументы склеиваются в одну команду и уходят
# POST-ом. Код 0 — команда исполнена, 22 — пульт отверг её (ответ всё равно
# напечатан), 7 — пульт не слушает: он поднимается `just contour-bot-console`.
#
#   sh tests/contour/bot-wire/console/send.sh alice press Ближайшие сходки
#   sh tests/contour/bot-wire/console/send.sh            # справка и готовность
set -eu

url="http://127.0.0.1:${BOT_CONSOLE_PORT:-7357}/"

if [ "$#" -eq 0 ]; then
  exec curl -sS --fail-with-body "$url"
fi
printf '%s' "$*" | exec curl -sS --fail-with-body --data-binary @- "$url"
