---
name: proj-write-aspire-apphost
description: Писать и ревьюить Aspire AppHost этого репозитория — граф узлов, профили как данные, полиглотные ресурсы Go и Node, bind без ветвлений, health и живой gate. Использовать при правках infra/apphost, добавлении компонента или инфраструктуры, смене профилей и Aspire hosting packages.
---

# Писать Aspire AppHost

Aspire — единственная локальная оркестрация проекта ([ADR-021](../../../docs/decisions/ADR-021-aspire-local-orchestration.md)). Подтверждённые ограничения и живой gate — в [local-development.md](../../../docs/development/local-development.md), граница local и production — в [infrastructure.md](../../../docs/architecture/infrastructure.md). Здесь форма кода и порядок работы. Рецепты с кодом — в [reference.md](reference.md).

AppHost — не скрипт `AddExecutable`/`WithReference`, а граф имён с отложенной материализацией. Composition root объявляет узлы и связи, профиль решает, какими узлами AppHost владеет в этом запуске, `ServiceGraph.Build()` материализует только их.

## Инварианты

1. `Program.cs` объявляет граф и ничего больше. Образы, порты, команды и ключи environment в нём не появляются.
2. Профиль — данные в `Topology:Profiles`, а не код. Новый профиль не трогает C#.
3. Setup не читает имя профиля и не ветвится по нему. Он спрашивает граф: ресурс есть — bind и `WaitFor`, нет — AppHost молчит, компонент читает свой конфиг.
4. Одно логическое имя на узел: константа в `AppHostNames`, имя ресурса Aspire, ключ профиля, аргумент `aspire wait`, имя в документации.
5. `depends` в `AddService` — единственный источник зависимостей. Что setup биндит, то объявлено в `depends`.
6. Узлы сборки и кодогенерации принадлежат setup компонента, а не графу: в `depends` их нет, профиль их не перечисляет.
7. Connection string и адрес отдаются под ключом, который компонент реально читает. Ключ диктует компонент, а не конвенция AppHost.
8. Секрет — только `AddParameter(secret: true)` и только внутри setup того компонента, которому он нужен. В `appsettings*.json` секретов нет.
9. Всё, что печатается или летит в исключение, — по-английски: stdout AppHost проходит через Aspire CLI и ломает не-ASCII. Комментарии в коде остаются русскими.

Нарушил пункт — поправь модель, а не обходи его в setup.

## Владение, а не режимы

AppHost либо владеет узлом и поднимает его, либо не трогает его. Третьего состояния нет: `Off` из прежней модели — это просто отсутствие имени в профиле.

| Род узла | Регистрация | Материализуется | Иначе |
|---|---|---|---|
| infrastructure | `AddInfrastructure` | имя в `Infrastructure` профиля | контейнер не стартует, bind — no-op |
| service | `AddService` | имя в `Services` профиля | компонент не стартует, его запускает владелец |

Инфраструктура материализуется потому, что её назвал профиль, а не потому, что от неё зависит запущенный сервис. Это отличие от исходного эталона, и оно намеренное: иначе профиль без сервисов (`infra`) не поднял бы ничего.

`--run-services` меняет срез, а не wiring. Соседний сервис из `depends`, которого нет в срезе, не подтягивается — он остаётся владельцу. Чтобы это не было тихим, баннер топологии на старте отдельно перечисляет объявленные зависимости, которых в запуске нет.

## Структура

```
infra/apphost/
  Program.cs                                  composition root
  appsettings.json                            Topology:Profile + Topology:Profiles
  Configuration/
    AppHostNames.cs                           имена узлов
    RepositoryPaths.cs                        пути компонентов от корня репозитория
    ProfileResolver.cs                        --profile | TOPOLOGY__PROFILE, --run-services
    Models/ProfileConfig.cs                   списки владения
    Topology/ServiceGraph.cs                  реестр, валидация, порядок, баннер
    Topology/ServiceGraphContext.cs           builder, профиль, материализованные узлы
    Extensions/ResourceBuilderExtensions.cs   ApplyIf
    Extensions/ResourceBindExtensions.cs      BindEndpoint, BindConnection
    Infrastructure/                           один файл на backing store
    Services/                                 один файл на компонент
```

Другой расклад без причины не выдумывай.

## Composition root

```csharp
var builder = DistributedApplication.CreateBuilder(args);
var profile = ProfileResolver.Resolve(builder.Configuration);
var topology = new ServiceGraph(builder, profile);

topology.AddInfrastructure(R.Postgres, PostgresSetup.Configure);
topology.AddInfrastructure(R.Nats, NatsSetup.Configure);

topology.AddService(R.Identity, [R.Postgres], IdentitySetup.Configure);
topology.AddService(R.TelegramBot, [R.Identity], TelegramBotSetup.Configure);

topology.Build();
builder.Build().Run();
```

Новый компонент = константа в `AppHostNames` + строка `AddService` + файл setup + имя в нужных профилях. Больше ничего.

## Профиль

```json
"Topology": {
  "Profile": "core",
  "Profiles": {
    "infra": { "Infrastructure": [ "postgres", "nats" ] },
    "core":  { "Services": [ "identity", "telegram-bot" ], "Infrastructure": [ "postgres" ] }
  }
}
```

Имя активного профиля: `--profile <name>` перекрывает `Topology:Profile` (env `TOPOLOGY__PROFILE`). Неизвестный профиль, ссылка на незарегистрированный узел и цикл в `depends` падают до построения графа, с перечнем допустимых значений.

## Полиглот

В репозитории нет ни одного .NET-сервиса: Identity — Go через `AddExecutable`, Telegram Bot — Node через `AddJavaScriptApp`. Поэтому узел графа типизирован по `IResourceBuilder<T>`, а не по `ProjectResource`, а `AddInfrastructure` и `AddService` обобщены по `T`. `IResourceBuilder<out T>` ковариантен, поэтому bind-хелперы работают через `IResourceWithEndpoints` и не знают конкретный тип зависимости.

Появится F#-сервис (Meetups) или Orleans (Notifications) — он придёт обычным `AddProject` в тот же граф, без изменения модели.

## Workflow

### Добавить компонент

1. Константа в `AppHostNames.Resources`.
2. `Configuration/Services/<Name>Setup.cs` — рецепт в [reference.md](reference.md).
3. Строка `AddService(name, depends, Setup.Configure)` в `Program.cs`.
4. Имя в `Services` тех профилей, где AppHost должен его поднимать.
5. Сборка и кодогенерация компонента — внутри его setup, через `WaitForCompletion` и `WithParentRelationship`.
6. Health по штатному протоколу компонента. `Running` без readiness-проверки не считается `Healthy`.

### Добавить инфраструктуру

1. Константа и ключ профиля — одна строка.
2. `Configuration/Infrastructure/<Name>Setup.cs`; setup всегда создаёт ресурс, проверок владения внутри нет.
3. `AddInfrastructure` в composition root.
4. Имя в `Infrastructure` профилей, где AppHost её поднимает; потребители перечисляют её в `depends` и биндят хелпером.
5. Ресурс, принадлежащий другому ресурсу (база внутри сервера), публикуется через `context.Publish` и в профиле не упоминается.

### Обновить Aspire

Все `Aspire.AppHost.Sdk` и `Aspire.Hosting.*` держи на одной stable-линии. Перед правкой сверь фактический API: `aspire integration search`, `aspire docs api search`, `aspire --help`. Версия CLI и версия AppHost могут различаться, пример из документации вслепую не переноси.

Lifecycle — через `aspire-orchestration`, состояние и логи — через `aspire-monitoring`. Они не заменяют контур задачи и `just verify`.

## Проверка

Механика:

1. `dotnet build` для `infra/apphost`.
2. Неизвестный профиль, незарегистрированный узел в профиле и битый `depends` дают понятный отказ до старта ресурсов.
3. `just verify` зелёный.

Живой gate: запусти точный AppHost через agent-safe lifecycle из `aspire-orchestration`, дождись ресурсов через `aspire wait`, сверь граф и health через `aspire describe`, проверь баннер топологии и логи через `aspire-monitoring`, возьми endpoint из Aspire и выполни тот же протокольный вызов, что при ручном запуске. Профили проверяются отдельными запусками, после каждого AppHost останавливается штатно.

Статус «не проверено» в документации снимает только живой gate. Зелёная сборка его не заменяет.

## Запреты

- Простыня wiring или `switch` по компонентам в `Program.cs`.
- Захардкоженный список профилей или их семантика в C#.
- `if (profile.Name == ...)` внутри setup.
- Ручной `if (resource is not null)` там, где есть bind-хелпер.
- Bind зависимости, которой нет в `depends`.
- Второй ключ для того же узла (`Postgres` против `postgres`).
- Регистрация узла, который не назван ни одним профилем.
- Секрет в `appsettings*.json`.
- Русский текст в исключениях и в том, что печатается в лог.
- Узел сборки в `depends` или в профиле.

## Границы

Skill не проектирует сервисы, production deployment, MCP и межсервисные контракты. Новый ресурс добавляется только в срезе своей Linear-задачи. Mock-узлы для внешнего HTTP в графе пока не заведены: в репозитории нет исходящей HTTP-зависимости, которую надо стабить. Появится — заводится третьим родом узла, а не режимом инфраструктуры.

Изменение готово, когда `Program.cs` читается как граф, профиль не хранит второй список зависимостей, setup не знает имени профиля, каждый материализованный ресурс достигает `Healthy`, а документированные команды повторяют фактически выполненный gate.
