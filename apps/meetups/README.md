# Meetups

Владелец данных и правил жизненного цикла сходки. Сейчас это контрактная граница среза: Protobuf-схема шести операций, C#-проект кодогенерации и F#-библиотека, которая ссылается на него. Исполняемого gRPC-сервера ещё нет.

Сгенерированный C# не коммитится: его пишет `Grpc.Tools` в `obj/` при `dotnet build`.

## Команды

Из корня репозитория:

```bash
just meetups-build
just meetups-test
```

Команда генерации — `dotnet build` контрактного проекта `apps/meetups/Meetups.Contracts`.

Тесты идут на xUnit v3 с Unquote и запускаются через Microsoft.Testing.Platform: runner выбран ключом `test` в корневом `global.json`, решение передаётся флагом `--solution`. Подробности и грабли — в [руководстве по локальной разработке](../../docs/development/local-development.md).
