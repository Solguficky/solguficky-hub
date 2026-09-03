---
name: proj-write-fsharp
description: Писать и ревьюить F#: доменные типы, Option/Result, error flow, чистые функции, .NET/Protobuf interop и порядок файлов .fsproj. Использовать при правках .fs, .fsi, .fsproj или F#-модулей; тесты дополняет proj-test-fsharp, вертикальные срезы — proj-write-fsharp-vsa.
---

# Писать F#-код

Языковой норматив — [languages/fsharp.md](../../../docs/standards/languages/fsharp.md). Этот skill задаёт порядок применения, но не заменяет standard.

## 1. Собери локальный контекст

Прочитай ближайший `AGENTS.md`, `.fsproj`, соседние модули и настроенные build/test/lint/format commands. Затем открой [F# standard](../../../docs/standards/languages/fsharp.md). Конфигурация проекта определяет target framework, версии пакетов, formatter и analyzers; не вводи отсутствующий инструмент по памяти.

Если изменение касается generated C# contracts или Protobuf mapping, прочитай [Protobuf standard](../../../docs/standards/contracts/protobuf.md). Сам `.proto` меняется только через `proj-change-contract`.

## 2. Проведи trusted boundary

Найди место, где nullable C#, Protobuf message, database row или внешний response превращается в F#-тип. Снаружи считай данные недоверенными; внутри не протаскивай DTO и повторные primitive checks.

Для значения с инвариантом дай constructor, возвращающий `Result`. Взаимоисключающие состояния вырази DU, отсутствие — `option`, а pattern match оставь исчерпывающим.

## 3. Отдели решение от эффектов

Доменная функция получает все факты значениями и не читает часы, UUID generator, random, environment, сеть или базу. Workflow собирает эффекты вокруг неё через минимальные функции или record of functions. Container DI и lifecycle ресурсов остаются в composition root.

Expected failure возвращай именованным error DU. Unexpected exception не превращай в строку или успешный пустой результат: сохрани причину и отобрази её на границе согласно политике сервиса.

## 4. Поддержи граф компиляции

При добавлении или переносе файла обнови `<Compile Include>` в `.fsproj` в том же изменении. Проверь, что порядок отражает направление зависимостей и не создаёт общий модуль ради обхода цикла.

## 5. Проверь изменение

Для F#-тестов примени `proj-test-fsharp`. Запусти настроенные one-shot команды, как минимум `dotnet build` и затронутый test project. Просмотри warnings: exhaustiveness и nullability не закрываются широким catch-all или подавлением без причины.

Изменение готово, когда публичные сигнатуры показывают допустимые состояния и ошибки, эффекты остаются на краю, interop DTO не прошли в домен, а `.fsproj` воспроизводит граф модулей.
