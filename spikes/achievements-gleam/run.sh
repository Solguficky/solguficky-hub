#!/bin/sh
# Тулбокс спайка: Elixir 1.20 / OTP 28 + Gleam 1.19.2, сеть хоста ради прокси.
exec docker run --rm --network host -e HTTPS_PROXY -e HTTP_PROXY -e NO_PROXY \
  -e HEX_CACERTS_PATH=/etc/ssl/certs/ca-certificates.crt -e MIX_HOME=/w/.cache/mix -e HEX_HOME=/w/.cache/hex -v "$(cd "$(dirname "$0")" && pwd)":/w -w /w/"${SUB:-.}" spike-tb "$@"
