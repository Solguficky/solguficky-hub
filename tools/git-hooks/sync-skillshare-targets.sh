#!/usr/bin/env sh
# Раскладывает скиллы и роли подагентов из .skillshare/ по таргетам
# (.claude/skills/, .agents/skills/, .claude/agents/, .opencode/agents/).
#
#   sync-skillshare-targets.sh                 — режим хука post-merge
#   sync-skillshare-targets.sh <old> <new> <flag> — режим хука post-checkout
#
# Зачем хук, а не ручной шаг: дерево от приложения получает .claude/ копией
# из основного клона, и сессия читает роли до того, как агент успеет что-то
# запустить. Отстал основной клон — отстают все новые деревья, молча.
#
# Хук ничего не блокирует: post-хуки git и так не отменяют операцию, а
# отсутствие skillshare — нормальное состояние машины без agent tooling.
# Поэтому код возврата всегда 0, а сбой печатается одной строкой.

set -u

# post-checkout передаёт третьим аргументом 1 при смене ветки и 0 при
# checkout отдельных файлов; второй случай состав таргетов не меняет.
if [ "$#" -ge 3 ] && [ "$3" != "1" ]; then
    exit 0
fi

if ! command -v skillshare >/dev/null 2>&1; then
    exit 0
fi

# sync работает без сети и не трогает объявление зависимостей: его правит
# только install. Внешние скиллы, которых нет в источнике, sync считает
# локальными и не удаляет.
if skillshare sync --all -p >/dev/null 2>&1; then
    echo "skillshare: таргеты синхронизированы с .skillshare/"
else
    echo "skillshare: sync завершился с ошибкой, запусти вручную: skillshare sync --all -p" >&2
fi

exit 0
