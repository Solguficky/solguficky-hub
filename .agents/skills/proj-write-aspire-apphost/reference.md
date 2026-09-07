# Reference: рецепты AppHost

Правила — в [SKILL.md](SKILL.md). Здесь то, что пишется руками при добавлении узла, и ловушки, на которых этот каркас уже спотыкался.

Каркас живёт в `infra/apphost/Configuration/` и в reference не копируется: он один, и вторая копия разойдётся с ним. Ниже — только то, что появляется в новом коде.

| Нужно | Секция |
|---|---|
| Новая инфраструктура | §1 |
| Ресурс внутри ресурса (база в сервере) | §2 |
| Новый компонент | §3 |
| Компонент со сборкой и кодогенерацией | §4 |
| Компонент с секретом | §5 |
| Health по своему протоколу | §6 |
| Новый профиль и срез | §7 |
| Ловушки | §8 |

---

## 1. Новая инфраструктура

`Configuration/Infrastructure/<Name>Setup.cs`. Setup всегда создаёт ресурс: граф вызывает его только когда профиль владеет узлом, поэтому проверок владения внутри нет.

```csharp
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Infrastructure;

internal static class NatsSetup
{
    public static IResourceBuilder<NatsServerResource> Configure(ServiceGraphContext context) =>
        context.Builder
            .AddNats(AppHostNames.Resources.Nats)
            .WithImageTag("2.10-alpine")
            .WithJetStream();
}
```

Дальше: константа в `AppHostNames.Resources`, строка `topology.AddInfrastructure(R.Nats, NatsSetup.Configure)` в `Program.cs`, имя в `Infrastructure` профилей.

Версия образа фиксируется тегом. Плавающий `latest` в графе не появляется.

---

## 2. Ресурс внутри ресурса

База принадлежит серверу, а не профилю: её поднимает и именует setup сервера. В граф она попадает через `Publish`, в профиле не упоминается, в `depends` потребителя стоит имя базы.

```csharp
internal static class PostgresSetup
{
    public static IResourceBuilder<PostgresServerResource> Configure(ServiceGraphContext context)
    {
        var postgres = context.Builder
            .AddPostgres(AppHostNames.Resources.Postgres)
            .WithImageTag("16-alpine")
            .WithDataVolume("solguficky-postgres-data");

        context.Publish(
            AppHostNames.Resources.SolgufickyDb,
            postgres.AddDatabase(AppHostNames.Resources.SolgufickyDb));

        return postgres;
    }
}
```

---

## 3. Новый компонент

`Configuration/Services/<Name>Setup.cs`. Ни одного `if` про наличие зависимости: это работа bind-хелпера.

```csharp
using AppHost.Configuration.Extensions;
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Services;

internal static class TelegramBotSetup
{
    public static IResourceBuilder<IResourceWithEnvironment> Configure(ServiceGraphContext context)
    {
        var token = context.Builder.AddParameter("telegram-bot-token", secret: true);

        return context.Builder
            .AddJavaScriptApp(
                AppHostNames.Resources.TelegramBot,
                RepositoryPaths.App(context.Builder, "telegram-bot"),
                "start")
            .WithEnvironment("TELEGRAM_BOT_TOKEN", token)
            .BindEndpoint(context, AppHostNames.Resources.Identity, "grpc", "IDENTITY_GRPC_URL");
    }
}
```

Тип возврата берётся по фактическому ресурсу: `ExecutableResource` для процесса, `ProjectResource` для .NET-проекта, общий `IResourceWithEnvironment` — когда конкретный тип интеграции не нужен графу.

Bind-хелперы (`Configuration/Extensions/ResourceBindExtensions.cs`):

| Хелпер | Когда |
|---|---|
| `BindEndpoint(context, dependency, endpointName, envKey)` | зависимость слушает порт, компонент читает URL |
| `BindConnection<TSelf, TDependency>(context, dependency, envKey, expression)` | нужен connection string своей формы |

Оба no-op, если узла нет в запуске: компонент останется на своём конфиге, и AppHost не перепишет его молча.

---

## 4. Компонент со сборкой и кодогенерацией

Такие узлы принадлежат setup: в `depends` их нет, профиль их не перечисляет, на дашборде они висят детьми компонента.

```csharp
var proto = context.Builder.AddExecutable(
    "identity-proto", "buf", repositoryRoot,
    "generate", "--template", "apps/identity/buf.gen.yaml");

var build = context.Builder
    .AddExecutable("identity-build", "go", identityPath, "build", "-o", binary, "./cmd/identity")
    .WaitForCompletion(proto);

var identity = context.Builder
    .AddExecutable(AppHostNames.Resources.Identity, binary, identityPath)
    .WithEndpoint(scheme: "http", name: "grpc", env: "ASPIRE_IDENTITY_GRPC_PORT")
    .WaitForCompletion(build);

proto.WithParentRelationship(identity);
build.WithParentRelationship(identity);
```

`WaitForCompletion` — для узла, который отработал и вышел. `WaitFor` — для узла, который должен стать здоровым. Одно не подменяет другое.

Команда и working directory совпадают с ручным запуском компонента. Порт назначает Aspire, компонент получает свой listen address через существующий environment contract:

```csharp
identity.WithEnvironment(
    "IDENTITY_GRPC_ADDR",
    ReferenceExpression.Create($":{grpc.Property(EndpointProperty.TargetPort)}"));
```

---

## 5. Секрет

```csharp
var token = context.Builder.AddParameter("telegram-bot-token", secret: true);
```

Объявляется внутри setup того компонента, которому нужен: профиль без этого компонента не спросит токен. Значение живёт в user secrets AppHost (`UserSecretsId` в `AppHost.csproj`), не в `appsettings*.json` и не в переменной в justfile.

---

## 6. Health по своему протоколу

`Running` — не готовность. Проверка идёт тем же протоколом, которым ходит потребитель, и регистрируется в DI AppHost:

```csharp
context.Builder.Services.AddHealthChecks().AddAsyncCheck(
    HealthCheck,
    cancellationToken => CheckAsync(grpc, cancellationToken),
    timeout: ProbeTimeout);

identity.WithHealthCheck(HealthCheck);
```

У пробы обязаны быть оба предела: deadline самого вызова и timeout всей проверки. Почему — §8.

---

## 7. Новый профиль и срез

Профиль — блок в `Topology:Profiles` (`infra/apphost/appsettings.json`). C# не трогается.

```json
"identity": {
  "Services": [ "identity" ],
  "Infrastructure": [ "postgres" ]
}
```

Пустой список означает «AppHost этим не владеет»: компонент запускает владелец, и AppHost не инжектит ему ничего.

```bash
just aspire identity
just aspire core -- --run-services identity
just aspire core -- --skip-services telegram-bot
TOPOLOGY__PROFILE=infra aspire run
```

Баннер на старте печатает, что материализовано и какие объявленные зависимости в запуск не попали. Он идёт в stdout AppHost, то есть в лог ресурса и в `~/.aspire/logs/`, а не в терминал: `aspire run` перехватывает вывод.

---

## 8. Ловушки

Каждая проверена на этом репозитории.

**`go run` не доставляет SIGTERM.** DCP останавливает ресурс сигналом, `go run` не пересылает его дочернему процессу. Graceful shutdown в `main.go` становится недостижим, процесс остаётся жить с занятым портом и открытым пулом PostgreSQL. Поэтому Go-компонент запускается собранным бинарником, а сборка вынесена в отдельный узел.

**Прокси DCP принимает TCP раньше сервера.** Health-проба успевает подключиться до того, как Go-сервер начал слушать, и `CheckAsync` ждёт бесконечно: цикл health молча зависает, `aspire wait` и любой `WaitFor` стоят без диагностики. Нужны оба предела — `deadline:` у вызова и `timeout:` у самой проверки.

**Отмена — не отказ.** gRPC отдаёт отмену как `RpcException(Cancelled)`, а health-инфраструктура отличает отмену от падения только по `OperationCanceledException`. Без `cancellationToken.ThrowIfCancellationRequested()` в `catch` штатная остановка выглядит на дашборде как `Unhealthy` с приложенным исключением.

**Вариантность требует `class`.** `IResourceBuilder<out T>` ковариантен, но generic-параметр участвует в variance conversion только как ссылочный тип. `where TDependency : IResource` не компилируется на `WaitFor`, нужно `where TDependency : class, IResource`.

**Не-ASCII в stdout ломается.** Вывод AppHost проходит через Aspire CLI и приходит в лог мохибейкой. Баннер и текст исключений пишутся по-английски; комментарии в коде остаются русскими.

**Профиль без сервисов.** Если материализовать инфраструктуру только по `depends` запущенных сервисов (как делает исходный эталон), профиль `infra` не поднимет ничего. Поэтому владение инфраструктурой берётся из профиля напрямую.

**`--run-services` не транзитивен.** Срез не подтягивает соседний сервис из `depends`. Это осознанно: узел вне среза принадлежит владельцу. Проверяй баннер — он называет такие зависимости поимённо.
