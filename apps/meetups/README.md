# Meetups

Владелец данных и правил жизненного цикла сходки. Сейчас это скелет с применённой схемой: gRPC-сервер отвечает на шесть операций контракта заглушкой, домена ещё нет.

Сгенерированный C# не коммитится: его пишет `Grpc.Tools` в `obj/` при `dotnet build`. Рукописного кода в `Meetups.Contracts` быть не должно — это условие обратимости из [ADR-025](../../docs/decisions/ADR-025-meetups-fsharp-stack.md), и его держит `just meetups-contracts-check`, а не внимательность ревьюера.

## Устройство

```text
Meetups/
  Migrations/00001_meetups_schema.sql схема состояния и журнала
  Migrations.fs                       прогон встроенных SQL-миграций
  Observability/BoundaryLog.fs        интерцептор каркаса лога
  Transport/Placeholder.fs            заглушечные ответы, живут до PER-54
  Transport/MeetupsGrpcService.fs     диспетчер шести операций
  Host.fs                             composition root
  Program.fs                          точка входа; применяет миграции
```

Порядок `<Compile Include>` — направление зависимостей: файл видит только объявленное выше. `Domain/`, `Slices/` и `Infrastructure/` появятся вместе с первым срезом; заводить их пустыми нельзя, это отклонённый [ADR-033](../../docs/decisions/ADR-033-meetups-functional-vertical-slices.md) жёсткий шаблон.

Класс `MeetupsGrpcService` — диспетчер, а не место логики. ASP.NET Core принимает реализацию сервиса одним классом со всеми операциями сразу, поэтому `Api.fs` внутри среза для gRPC невозможен; как это раскладывается, описывает [норматив](../../docs/standards/architecture/functional-slices.md#grpc). Ветвление по содержимому запроса в этом файле означает, что граница поехала.

`Host.build` вынесен из `Program.fs` отдельной функцией, чтобы интеграционный тест поднимал ровно тот же хост, что и запуск. Миграции применяет `Program`, а не `Host.build`: gRPC-тесты каркаса по-прежнему не требуют базу.

## Транспорт и готовность

Kestrel настроен на h2c: gRPC без TLS требует HTTP/2, а plaintext-endpoint без ALPN не умеет договариваться о версии. Отсюда два следствия:

- `MapDefaultEndpoints` из ServiceDefaults не вызывается — `/health` и `/alive` на таком endpoint недостижимы;
- готовность сервис отдаёт по `grpc.health.v1`. Источником состояния остаётся реестр health checks из ServiceDefaults, gRPC-сервис — только его витрина. Ту же пробу использует Aspire.

Reflection включена безусловно, как в Identity: без неё каждая ручная проверка `grpcurl` требует `-import-path` и `-proto`.

## Команды

Из корня репозитория:

```bash
just meetups-build
just meetups-test
just meetups-contracts-check
just meetups-run
```

`MEETUPS_DATABASE_URL` обязателен для `meetups-run`: процесс применяет миграции до прослушивания. Интеграционные тесты схемы требуют PostgreSQL; без `MEETUPS_DATABASE_URL` и без доступного `127.0.0.1:5432` они пропускаются, в CI — нет.

Команда генерации — `dotnet build` контрактного проекта `apps/meetups/Meetups.Contracts`.

Тесты идут на xUnit v3 с Unquote и запускаются через Microsoft.Testing.Platform: runner выбран ключом `test` в корневом `global.json`, решение передаётся флагом `--solution`. Подробности и грабли — в [руководстве по локальной разработке](../../docs/development/local-development.md).

`Meetups.UnitTests` проверяет форму контракта, заглушку, ветки отказа границы и состав встроенных миграций без хоста. `Meetups.IntegrationTests` поднимает настоящий Kestrel на свободном порту, ходит в него настоящим gRPC-каналом и проверяет шесть операций, `grpc.health.v1` и каркас лога границы; отдельно применяет миграции на изолированной базе и проверяет ограничения схемы. Фикстуры лежат в `Infrastructure/`, сценарии — в `Scenarios/`. Записывающий логгер и фейковый `ServerCallContext` нужны обоим проектам и живут в `Meetups.TestKit`.

## Ручная проверка

Профиль `meetups` поднимает сервис вместе с PostgreSQL; Identity в него не входит:

```bash
just aspire meetups
```

Порт назначает Aspire, поэтому адрес читается из `aspire describe`, а не берётся фиксированным:

```bash
grpcurl -plaintext localhost:<порт> list
```
