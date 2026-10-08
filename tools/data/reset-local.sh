#!/usr/bin/env sh
# Сбрасывает локальные данные этого рабочего дерева: тома PostgreSQL и NATS,
# которые AppHost заводит дереву (docs/development/local-development.md, «Тома
# данных принадлежат рабочему дереву»). Следующий `aspire run` начинает с
# пустых баз всех сервисов и пустой шины: миграции и топология JetStream
# применяются заново.
#
# Без --yes только печатает, что удалит. Тома других деревьев не трогает: свой
# том находится по хэшу полного пути дерева — тому же, что в имени тома
# считает AppHost (infra/apphost/AppHost/Configuration/Infrastructure/DataVolumes.cs).
# Регистр пути на Windows AppHost не различает, а этот скрипт различает: на
# Windows вне WSL он свой том может не найти и тогда так и скажет.
#
# Базы и шина сбрасываются вместе намеренно. Пустая база рядом со старой
# шиной перечитала бы окно стримов новыми durable, а пустая шина рядом со
# старыми базами оставила бы реплики Notifications без событий, которые их
# поправили бы.

set -eu

usage() {
    echo "usage: $0 [--yes]" >&2
    exit 2
}

confirm=false
case ${1:-} in
    "") ;;
    --yes) confirm=true ;;
    *) usage ;;
esac
[ $# -le 1 ] || usage

if ! docker info >/dev/null 2>&1; then
    echo "local-data-reset: Docker не отвечает — сбрасывать нечего или не на чем" >&2
    exit 1
fi

root=$(git rev-parse --show-toplevel)
if command -v sha256sum >/dev/null 2>&1; then
    hash=$(printf '%s' "$root" | sha256sum | cut -c1-8)
else
    hash=$(printf '%s' "$root" | shasum -a 256 | cut -c1-8)
fi

volumes=$(docker volume ls --format '{{.Name}}' \
    | grep -E "^solguficky-.+-${hash}-(postgres-data|nats-data)$" || true)

if [ -z "$volumes" ]; then
    echo "local-data-reset: у дерева $root томов нет — данные уже пусты"
    echo "local-data-reset: тома всех деревьев: docker volume ls --filter name=solguficky-"
    exit 0
fi

# Том под контейнером, даже остановленным, Docker не удалит. Отказ здесь, до
# первого удаления: иначе сброс прошёл бы наполовину — без базы, но со старой
# шиной, или наоборот.
busy=""
for volume in $volumes; do
    if [ -n "$(docker ps -aq --filter "volume=$volume")" ]; then
        busy="$busy $volume"
    fi
done
if [ -n "$busy" ]; then
    echo "local-data-reset: тома заняты контейнерами:$busy" >&2
    echo "local-data-reset: останови aspire run этого дерева и повтори" >&2
    exit 1
fi

if [ "$confirm" = false ]; then
    echo "local-data-reset: будут удалены тома дерева $root:"
    printf '  %s\n' $volumes
    echo "local-data-reset: удалить — just local-data-reset --yes"
    exit 0
fi

for volume in $volumes; do
    docker volume rm "$volume" >/dev/null
    echo "local-data-reset: удалён $volume"
done
echo "local-data-reset: следующий aspire run начнёт с пустых баз и пустой шины"
