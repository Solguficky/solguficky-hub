# Auction Service: Локальная Разработка

Руководство по настройке окружения и запуску Auction Service локально на C# + Akka.NET.

## Предварительные требования

### Обязательные

- **.NET 8 SDK** (минимум 8.0.100)
- **Docker** и **Docker Compose** (для PostgreSQL, NATS)
- **Git**

### Рекомендуемые

- **Visual Studio 2022** / **Rider** / **VS Code** с C# extension
- **NATS CLI** (`nats`) для отладки сообщений
- **pgAdmin** или **DBeaver** для инспекции Event Store

## Быстрый старт

```bash
cd services/auction-service

dotnet restore
dotnet build
dotnet run --project src/AuctionService
```

Сервис будет доступен на:
- gRPC: `localhost:8080`

## 1. Установка .NET 8 SDK

### Windows

**Через winget:**
```powershell
winget install Microsoft.DotNet.SDK.8
```

**Через installer:**
1. Скачайте [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
2. Запустите installer
3. Проверьте установку:
   ```powershell
   dotnet --version
   ```

### macOS

```bash
brew install dotnet@8
```

### Linux (Ubuntu/Debian)

```bash
wget https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb -O packages-microsoft-prod.deb
sudo dpkg -i packages-microsoft-prod.deb
rm packages-microsoft-prod.deb

sudo apt-get update
sudo apt-get install -y dotnet-sdk-8.0
```

## 2. Настройка Cursor / VS Code

### Установка C# Extension

1. Откройте Cursor/VS Code
2. Установите **C# Dev Kit** (Microsoft)
   - ID: `ms-dotnettools.csdevkit`
3. Откройте проект: `services/auction-service/AuctionService.sln`
4. OmniSharp LSP запустится автоматически

### Настройка IntelliSense

Создайте `.vscode/settings.json` (если используете VS Code):
```json
{
  "omnisharp.enableRoslynAnalyzers": true,
  "omnisharp.enableEditorConfigSupport": true,
  "omnisharp.enableImportCompletion": true,
  "editor.formatOnSave": true,
  "csharp.format.enable": true
}
```

### Горячие клавиши

- **F5** — запустить с отладчиком
- **Ctrl+Shift+B** — собрать проект
- **Ctrl+.** — Quick Actions (добавить using, fix suggestions)

## 3. Локальная инфраструктура

### Запуск PostgreSQL и NATS через Docker Compose

```bash
cd ../..

docker-compose up -d postgres nats
```

Это запустит:
- **PostgreSQL** (Event Store): `localhost:5432`
  - Database: `auction`
  - User: `auction`
  - Password: `auction`
- **NATS** (Message Bus): `localhost:4222`
  - NATS Management: `http://localhost:8222`

### Проверка статуса

```bash
docker-compose ps

docker logs solguficky-postgres
docker logs solguficky-nats
```

### Инициализация Event Store

При первом запуске Akka.Persistence автоматически создаст таблицы в PostgreSQL:
- `public.events` — Event Journal
- `public.snapshots` — Snapshots

Проверить можно через psql:
```bash
docker exec -it solguficky-postgres psql -U auction -d auction

\dt
SELECT * FROM events LIMIT 10;
```

## 4. Запуск сервиса

### Вариант 1: dotnet run

```bash
cd services/auction-service

dotnet run --project src/AuctionService
```

Логи будут в stdout (JSON формат).

### Вариант 2: dotnet watch (Hot Reload)

```bash
dotnet watch run --project src/AuctionService
```

Изменения в `.cs` файлах автоматически перекомпилируются и перезагружаются.

### Вариант 3: Docker

```bash
docker-compose up auction-service
```

## 5. Конфигурация

### appsettings.json (defaults)

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Akka": "Information"
    }
  },
  "Akka": {
    "Persistence": {
      "ConnectionString": "Host=localhost;Port=5432;Database=auction;Username=auction;Password=auction"
    }
  },
  "Nats": {
    "Url": "nats://localhost:4222"
  },
  "Grpc": {
    "Port": 8080
  }
}
```

### Environment Variables (overrides)

```bash
export Akka__Persistence__ConnectionString="Host=prod-db;Database=auction"
export Nats__Url="nats://prod-nats:4222"
export Grpc__Port="9090"

dotnet run
```

### Профили (Development / Production)

`appsettings.Development.json`:
```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Debug",
      "Akka": "Debug"
    }
  }
}
```

Автоматически применяется при `ASPNETCORE_ENVIRONMENT=Development`.

## 6. Тестирование

### Unit-тесты (акторы)

```bash
dotnet test
```

### Конкретный тест

```bash
dotnet test --filter "FullyQualifiedName~LotActorTests.ShouldAcceptValidBid"
```

### С покрытием кода

```bash
dotnet test --collect:"XPlat Code Coverage"
```

## 7. Отладка

### Логирование

Сервис использует **Serilog** с JSON форматом:
```json
{
  "@t": "2025-10-24T12:34:56.789Z",
  "@mt": "Bid placed: {UserId} - {Amount}",
  "UserId": 42,
  "Amount": 150.0,
  "SourceContext": "AuctionService.Domain.Lot.LotActor"
}
```

Для human-readable логов в dev режиме:
```csharp
Log.Logger = new LoggerConfiguration()
    .WriteTo.Console(theme: AnsiConsoleTheme.Code)
    .CreateLogger();
```

### Отладка акторов

Включите Akka logging:
```hocon
akka {
  loglevel = DEBUG
  loggers = ["Akka.Logger.Serilog.SerilogLogger, Akka.Logger.Serilog"]
}
```

Лог будет включать:
- Сообщения акторов
- Persistence events
- Supervision events

### Просмотр Event Store

```bash
docker exec -it solguficky-postgres psql -U auction -d auction

SELECT
  persistence_id,
  sequence_nr,
  event_payload::json->>'$type' AS event_type,
  event_payload
FROM events
WHERE persistence_id = 'lot-1'
ORDER BY sequence_nr;
```

### NATS CLI для отладки сообщений

**Установка:**
```bash
brew install nats-io/nats-tools/nats

curl -sf https://binaries.nats.dev/nats-io/natscli/nats@latest | sh
```

**Подписка на события:**
```bash
nats sub "events.auction.>" --translate "jq ."
```

**Публикация команды:**
```bash
echo '{"eventId":"event-1","lotId":1,"userId":42,"amount":150.0}' | \
  nats pub commands.auction.place-bid --count=1
```

### Grafana + Loki (централизованные логи)

```bash
docker-compose up -d grafana loki promtail
```

- Grafana UI: `http://localhost:3000` (admin / admin)
- Explore → Loki → Query: `{service="auction-service"}`

## 8. Полезные команды

### dotnet CLI

| Команда | Описание |
|---------|----------|
| `dotnet restore` | Восстановить NuGet пакеты |
| `dotnet build` | Собрать проект |
| `dotnet run` | Запустить приложение |
| `dotnet watch run` | Запустить с Hot Reload |
| `dotnet test` | Запустить тесты |
| `dotnet clean` | Очистить артефакты сборки |
| `dotnet format` | Форматировать код |
| `dotnet add package <name>` | Добавить NuGet пакет |

### Docker Compose

```bash
docker-compose up -d postgres nats
docker-compose logs -f auction-service
docker-compose restart auction-service
docker-compose down
docker-compose down -v
```

### PostgreSQL

```bash
docker exec -it solguficky-postgres psql -U auction -d auction

\dt
\d events
SELECT COUNT(*) FROM events;
TRUNCATE events, snapshots CASCADE;
```

## 9. Troubleshooting

### Ошибка: "Connection refused" (PostgreSQL)

**Причина:** PostgreSQL не запущен или неверный порт.

**Решение:**
```bash
docker-compose ps
docker-compose up -d postgres
docker logs solguficky-postgres
```

### Ошибка: "Could not connect to NATS"

**Причина:** NATS не запущен.

**Решение:**
```bash
docker-compose up -d nats
curl http://localhost:8222/varz
```

### Ошибка: "Akka.Persistence table not found"

**Причина:** Таблицы Event Store не созданы.

**Решение:** Akka.Persistence.PostgreSql создаст таблицы автоматически при первом запуске. Если нет, проверьте права пользователя:
```sql
GRANT CREATE ON SCHEMA public TO auction;
```

### Ошибка: "Port 8080 already in use"

**Причина:** Другой процесс занимает порт.

**Решение:**
```bash
lsof -i :8080
kill <PID>
```

Или измените порт в `appsettings.json`:
```json
{
  "Grpc": {
    "Port": 9090
  }
}
```

### OmniSharp не запускается в Cursor

**Причина:** Не установлен .NET SDK или OmniSharp не может найти `.sln`.

**Решение:**
```bash
dotnet --version

code services/auction-service/AuctionService.sln
```

Перезапустите OmniSharp: `Ctrl+Shift+P` → "Restart OmniSharp".

### Hot Reload не работает

**Причина:** `dotnet watch` не поддерживает все типы изменений (например, изменение сигнатуры метода).

**Решение:** Перезапустите вручную:
```bash
Ctrl+C
dotnet run
```

## 10. Структура проекта (напоминание)

```
services/auction-service/
├── AuctionService.sln
├── src/
│   └── AuctionService/
│       ├── AuctionService.csproj
│       ├── Program.cs
│       ├── Domain/
│       │   ├── Session/
│       │   ├── Lot/
│       │   └── AuctionRegistry.cs
│       ├── Application/
│       │   ├── GrpcService.cs
│       │   └── NatsCommandHandler.cs
│       ├── Infrastructure/
│       │   ├── NatsClient.cs
│       │   └── Persistence/
│       ├── Protos/
│       └── appsettings.json
├── tests/
│   └── AuctionService.Tests/
├── Dockerfile
├── LOCAL_SETUP.md
└── README.md
```

## 11. Следующие шаги

1. Реализуйте `LotActor` (см. примеры в `docs/02_SERVICES/auction-service.md`)
2. Напишите unit-тесты с `Akka.TestKit`
3. Реализуйте `AuctionSessionActor` (координатор)
4. Подключите gRPC Service
5. Подключите NATS Subscriber/Publisher
6. Интеграционные тесты с TestContainers

## 12. Полезные ссылки

- [.NET Documentation](https://learn.microsoft.com/en-us/dotnet/)
- [Akka.NET Docs](https://getakka.net/)
- [Akka.Persistence Guide](https://getakka.net/articles/persistence/architecture.html)
- [gRPC in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/grpc/)
- [NATS .NET Client](https://github.com/nats-io/nats.net)

---

**Если возникли проблемы:** проверьте `.cursor/rules/auction-service-rules.mdc` для best practices и `docs/02_SERVICES/auction-service.md` для примеров кода.
