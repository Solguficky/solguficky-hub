# Meetups

Владелец данных и правил жизненного цикла сходки. Сейчас это скелет: gRPC-сервер отвечает на шесть операций контракта заглушкой, домена и базы ещё нет.

Сгенерированный C# не коммитится: его пишет `Grpc.Tools` в `obj/` при `dotnet build`. Рукописного кода в `Meetups.Contracts` быть не должно — это условие обратимости из [ADR-025](../../docs/decisions/ADR-025-meetups-fsharp-stack.md), и его держит `just meetups-contracts-check`, а не внимательность ревьюера.

## Устройство

```text
Meetups/
  Observability/BoundaryLog.fs        интерцептор каркаса лога
  Transport/Placeholder.fs            заглушечные ответы, живут до PER-54
  Transport/MeetupsGrpcService.fs     диспетчер шести операций
  Host.fs                             composition root
  Program.fs                          точка входа
```

Порядок `<Compile Include>` — направление зависимостей: файл видит только объявленное выше. `Domain/`, `Slices/` и `Infrastructure/` появятся вместе с первым срезом; заводить их пустыми нельзя, это отклонённый [ADR-033](../../docs/decisions/ADR-033-meetups-functional-vertical-slices.md) жёсткий шаблон.

Класс `MeetupsGrpcService` — диспетчер, а не место логики. ASP.NET Core принимает реализацию сервиса одним классом со всеми операциями сразу, поэтому `Api.fs` внутри среза для gRPC невозможен; как это раскладывается, описывает [норматив](../../docs/standards/architecture/functional-slices.md#grpc). Ветвление по содержимому запроса в этом файле означает, что граница поехала.

`Host.build` вынесен из `Program.fs` отдельной функцией, чтобы интеграционный тест поднимал ровно тот же хост, что и запуск.

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

Команда генерации — `dotnet build` контрактного проекта `apps/meetups/Meetups.Contracts`.

Тесты идут на xUnit v3 с Unquote и запускаются через Microsoft.Testing.Platform: runner выбран ключом `test` в корневом `global.json`, решение передаётся флагом `--solution`. Подробности и грабли — в [руководстве по локальной разработке](../../docs/development/local-development.md).

`Meetups.UnitTests` проверяет форму схемы, заглушку и ветки отказа границы без хоста. `Meetups.IntegrationTests` поднимает настоящий Kestrel на свободном порту, ходит в него настоящим gRPC-каналом и проверяет шесть операций, `grpc.health.v1` и каркас лога границы; фикстура лежит в `Infrastructure/`, сценарии — в `Scenarios/`. Записывающий логгер и фейковый `ServerCallContext` нужны обоим проектам и живут в `Meetups.TestKit`.

## Ручная проверка

Профиль `meetups` поднимает сервис один, без Identity и PostgreSQL:

```bash
just aspire meetups
```

Порт назначает Aspire, поэтому адрес читается из `aspire describe`, а не берётся фиксированным:

```bash
grpcurl -plaintext localhost:<порт> list
```
