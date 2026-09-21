# Notifications (C# / Orleans)

> Локальные правила сервиса. Общие — в корневом [AGENTS.md](../../AGENTS.md), ответственность и границы — в [docs/services/notifications.md](../../docs/services/notifications.md), стек — в [ADR-029](../../docs/decisions/ADR-029-notifications-orleans-stack.md).

Сейчас в репозитории лежит **скелет**: силос Orleans, своя база, миграции при старте и один грин-заглушка. Подписки и gRPC — PER-71, реплика чужих фактов — PER-215, задание напоминания и sweeper — PER-222, потребление шины и доставка — PER-72.

## Что здесь нельзя

- **Не добавляй grain storage provider.** Он не зарегистрирован намеренно: источник истины остаётся в PostgreSQL, а отсутствие провайдера делает это исполнимым правилом, а не пунктом на review — `[PersistentState]` уронит старт силоса. Доменные данные грин читает и пишет через Dapper в свои таблицы.
- **Не заводи второй механизм миграций.** Схему сервиса и таблицы membership Orleans применяет один DbUp; [standards/data/postgresql.md](../../docs/standards/data/postgresql.md) запрещает два журнала на одну схему.
- **Не пиши код руками в `Notifications.Contracts`.** Проект generated-only, это условие обратимости; держит его `tools/notifications/check-contracts-generated.sh`.

## Миграции

- Имя скрипта — `NNN_описание.sql`, номера строго возрастают. Проверку делает не документация, а `Migrations.List`: мимо норматива названный скрипт роняет старт.
- Скрипты идемпотентны. Вендорные скрипты Orleans приходят из upstream **не** идемпотентными — в них нет ни одного `IF NOT EXISTS`, — и адаптируются при вендоринге; список правок стоит в шапке каждого файла.
- Подстановка переменных DbUp выключена и включать её нельзя: `$func$` в теле PL/pgSQL она разбирает как своё имя переменной.

## Orleans

- Версия и провайдеры: Orleans 10.3.1, clustering через `Microsoft.Orleans.Clustering.AdoNet` в своей базе. Reminders появятся вместе с PER-222.
- Порты силоса берутся из конфигурации (`Orleans:SiloPort`, `Orleans:GatewayPort`) с штатными умолчаниями. Переопределяет их тот, кто поднимает второй силос на той же машине: тест рестарта и параллельное рабочее дерево.
- Вопросы по примитивам Orleans — скилл `orleans` и роль `proj-orleans-specialist`; они же знают границы этого сервиса.

## Тесты

Стек задан [standards/testing/testing-strategy.md](../../docs/standards/testing/testing-strategy.md): xUnit v3 на Microsoft.Testing.Platform, Shouldly, Moq. Форма имени — [standards/testing/naming.md](../../docs/standards/testing/naming.md).

Интеграционные тесты поднимают PostgreSQL через Testcontainers и без Docker пропускаются — **кроме CI**, где отсутствие контейнера красит джобу. Не превращай этот отказ в пропуск: зелёный прогон на пропущенных тестах хуже отсутствия тестов.

`Orleans.TestingHost` не используется: он строит свой кластер со своими провайдерами и проверял бы фикстуру вместо конфигурации сервиса. Тесты поднимают тот же composition root, что и запуск.
