# Локальная разработка

> **Статус:** Current, частично подтверждено. AppHost-код существует, но `aspire run` ещё не был успешно проверен в живой среде.

Граница между local development, production-like integration и production hosting описана в [инфраструктурном обзоре](../architecture/infrastructure.md).

.NET Aspire — принятый инструмент локальной оркестрации (ADR-021). Рукописные `docker-compose.yml` пока сохраняются как рабочий fallback до проверки замены.

## AppHost

```powershell
cd infra/apphost
aspire run
```

AppHost всегда объявляет контейнеры PostgreSQL и NATS. Режим остальных компонентов задаётся профилем и может быть переопределён переменной окружения.

## Профили

| Профиль | Компоненты |
|---|---|
| `infra` | PostgreSQL + NATS; product services выключены |
| `core` | infra + Auction Service Local + Rust Telegram Gateway Local |
| `full` | infra + все существующие сервисы Local |

```powershell
$env:TOPOLOGY__PROFILE='infra'
aspire run
```

## Режим компонента

Допустимы `Local`, `Container`, `Off`:

```powershell
$env:TOPOLOGY__NOTIFICATIONSSERVICE='Local'
$env:TOPOLOGY__TELEGRAMGATEWAY='Off'
aspire run
```

Имена конфигурации определены в `infra/apphost/Topology.cs` и `Program.cs`:

- `AuctionService`;
- `NotificationsService`;
- `WebsocketGateway`;
- `TelegramGateway`.

## Неподтверждённые места

- restore/build самого AppHost после добавления Aspire NATS/PostgreSQL packages;
- `AddExecutable("cargo", "run", ...)` и управление Rust-процессом на Windows;
- Docker build context существующих сервисов при режиме `Container`;
- запуск всех компонентов профиля `full`;
- пригодность `aspire publish` для production-like k3s.

Пока эти проверки не выполнены, не удаляй compose-файлы и не описывай Aspire как подтверждённую production-топологию.

## Проверка замены compose

Минимальный acceptance check:

1. `dotnet restore` и `dotnet build` для `infra/apphost` успешны.
2. `aspire run` показывает здоровые PostgreSQL и NATS.
3. Профиль `infra` не запускает product services.
4. Профиль `core` запускает оба Current/Legacy core-компонента или выдаёт конкретный диагностируемый blocker.
5. `Off` позволяет запустить сервис отдельно из IDE/терминала.
6. После подтверждения `Container` и fallback только тогда планируется удаление рукописных compose-файлов.

Работа и её прогресс должны быть заведены в Linear; этот документ хранит только устойчивые правила и проверяемый gap.
