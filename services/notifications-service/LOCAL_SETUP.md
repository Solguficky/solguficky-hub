# Local Setup: Notifications Service

Инструкция по локальному запуску notification-service для разработки.

## Требования

- **.NET 8 SDK** - [скачать](https://dotnet.microsoft.com/download/dotnet/8.0)
- **Docker** (для NATS)
- **IDE**: Visual Studio 2022, Rider или VS Code с C# extension

## 1. Проверка .NET SDK

```bash
dotnet --version
```

Должно быть >= 8.0

## 2. Запуск NATS

### Через Docker

```bash
docker run -d --name nats -p 4222:4222 -p 8222:8222 nats:latest
```

Проверка:
```bash
curl http://localhost:8222/varz
```

### Через Docker Compose (весь стек)

```bash
cd ../../
docker-compose up -d nats
```

## 3. Конфигурация

Создайте `appsettings.Development.json` (уже существует) или используйте переменные окружения:

```bash
# PowerShell
$env:NATS__URL="nats://localhost:4222"

# Bash
export NATS__URL=nats://localhost:4222
```

## 4. Восстановление пакетов

```bash
cd services/notifications-service
dotnet restore
```

## 5. Компиляция

```bash
dotnet build
```

Protobuf файлы автоматически сгенерируются в `obj/Debug/net8.0/nats/`

## 6. Запуск

```bash
cd src/NotificationsService
dotnet run
```

Сервис запустится на `http://localhost:5000`

Проверка:
```bash
curl http://localhost:5000/health
curl http://localhost:5000/
```

## 7. Тестирование

Запуск unit тестов:

```bash
dotnet test
```

## 8. Отправка тестового события

Для тестирования можно использовать `nats-cli`:

```bash
# Установка nats CLI
choco install nats  # Windows
brew install nats-io/nats-tools/nats  # macOS

# Публикация тестового события (требует Protobuf бинарь)
# Лучше использовать auction-service или telegram-gateway для генерации реальных событий
```

Или используйте **auction-service** для генерации реальных `bid-placed` событий.

## 9. Просмотр логов

Логи выводятся в консоль в JSON формате. Для удобного просмотра используйте `jq`:

```bash
dotnet run | jq
```

## 10. Hot Reload (разработка)

```bash
dotnet watch run
```

Изменения в коде автоматически пересобирают и перезапускают сервис.

## Отладка

### Visual Studio 2022

1. Открыть `NotificationsService.sln`
2. Установить breakpoint в `BidPlacedHandler.cs`
3. F5 (Start Debugging)

### VS Code

1. Установить C# extension
2. `.vscode/launch.json`:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": ".NET Core Launch (web)",
      "type": "coreclr",
      "request": "launch",
      "preLaunchTask": "build",
      "program": "${workspaceFolder}/src/NotificationsService/bin/Debug/net8.0/NotificationsService.dll",
      "args": [],
      "cwd": "${workspaceFolder}/src/NotificationsService",
      "stopAtEntry": false,
      "env": {
        "ASPNETCORE_ENVIRONMENT": "Development",
        "NATS__URL": "nats://localhost:4222"
      }
    }
  ]
}
```

## Troubleshooting

### NATS Connection Failed

```
[Error] NATS connection failed
```

**Решение:** Проверьте, что NATS запущен:
```bash
docker ps | grep nats
curl http://localhost:8222/varz
```

### Protobuf Generation Failed

```
error CS0234: The type or namespace name 'Nats' does not exist
```

**Решение:**
```bash
dotnet clean
dotnet build
```

### Port Already in Use

```
[Error] Failed to bind to address http://127.0.0.1:5000
```

**Решение:** Измените порт в `appsettings.Development.json` или через ENV:
```bash
$env:ASPNETCORE_URLS="http://localhost:5001"
dotnet run
```

## Интеграция с другими сервисами

Для полного flow нужны:

1. **NATS** (обязательно) - шина сообщений
2. **Auction Service** (опционально) - генерирует `bid-placed` события
3. **Telegram Gateway** (опционально) - обрабатывает `send-message` команды

Запуск всего стека:
```bash
cd ../../
docker-compose up -d
```

