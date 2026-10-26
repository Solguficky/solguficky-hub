#!/bin/sh
# Тулбокс спайка: Elixir 1.20 / OTP 28, сеть хоста ради прокси; кэш hex/mix в .cache.
D="$(cd "$(dirname "$0")" && pwd)"
exec docker run --rm --network host -e HTTPS_PROXY -e HTTP_PROXY -e NO_PROXY \
  -e HEX_CACERTS_PATH=/etc/ssl/certs/ca-certificates.crt -e MIX_HOME=/w/.cache/mix -e HEX_HOME=/w/.cache/hex \
  -e MIX_ENV -v "$D":/w -w /w/"${SUB:-.}" spike-tb "$@"
