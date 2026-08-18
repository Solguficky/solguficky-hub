# Локальная разработка

> **Статус:** Current, частично подтверждено. TypeScript AppHost реализован, но `aspire run` ещё не был успешно проверен в живой среде.

Граница между local development, production-like integration и production hosting описана в [инфраструктурном обзоре](../architecture/infrastructure.md).

Aspire — принятый инструмент локальной оркестрации (ADR-021), TypeScript — канонический язык AppHost (ADR-024). Рукописные `docker-compose.yml` и прежний C# AppHost пока сохраняются как fallback до проверки замены.

## Требования

- Aspire CLI 13.4 или новее;
- Node.js 22.13 или новее (рекомендуемый major записан в `infra/apphost/.nvmrc`);
- Docker-совместимый container runtime;
- .NET SDK и Rust нужны только для соответствующих `Local`-ресурсов.

```bash
cd infra/apphost
nvm use                     # если используется nvm
aspire --version
node --version
aspire run apphost.mts
```

Явный аргумент `apphost.mts` обязателен до удаления C# fallback, чтобы Aspire не выбирал между двумя AppHost.

## Ресурсы и профили

AppHost всегда объявляет PostgreSQL 16 с именованным data volume, базу `solguficky` и NATS 2.10 с JetStream. Секретный параметр `telegram-bot-token` создаётся только при включённом Telegram gateway.

| Профиль | Компоненты |
|---|---|
| `infra` | PostgreSQL + NATS; product services выключены |
| `core` | infra + Auction Service Local + Rust Telegram Gateway Local |
| `full` | infra + все существующие сервисы Local |

```bash
TOPOLOGY__PROFILE=infra aspire run apphost.mts
```

## Сегментированный запуск

Профиль задаёт baseline, а режим каждого компонента переопределяется независимо значением `Local`, `Container` или `Off`:

```bash
TOPOLOGY__NOTIFICATIONSSERVICE=Local \
TOPOLOGY__TELEGRAMGATEWAY=Off \
aspire run apphost.mts
```

Поддерживаются `AuctionService`, `NotificationsService`, `WebsocketGateway` и `TelegramGateway`. Новый MVP-сервис добавляется одной секцией ресурса с явными references/waits и получает режим через ту же функцию `resolveMode`; менять инфраструктурные ресурсы или создавать новый профиль для каждого сервиса не требуется.

Текущая матрица профилей перенесена для совместимости, но не объявлена окончательной абстракцией. После живых запусков inner loop и e2e нужно сравнить её с более прямым императивным AppHost и оставить только оправданную сложность (ADR-024).

## Неподтверждённые места

- restore/type-check TypeScript AppHost через Aspire CLI 13.4+;
- соответствие конкретных ATS-сигнатур `addProject`, `addDockerfile` и endpoint API установленной версии CLI;
- управление `cargo run` как локальным процессом на Windows;
- Docker build context существующих сервисов при режиме `Container`;
- запуск всех компонентов профиля `full`;
- пригодность `aspire publish` для выбранного позднее production-окружения.

Пока эти проверки не выполнены, не удаляй C# AppHost, compose-файлы и не описывай Aspire как подтверждённую production-топологию.

## Gate миграции

1. `aspire run apphost.mts` успешно компилирует AppHost на Aspire CLI 13.4+ и Node.js 22.13+.
2. PostgreSQL сохраняет данные в `solguficky-postgres-data`, NATS работает с JetStream, оба ресурса healthy.
3. Профиль `infra` не запускает product services.
4. Профиль `core` запускает оба Current/Legacy core-компонента или выдаёт конкретный диагностируемый blocker.
5. Переопределения `Local`, `Container`, `Off` работают независимо и поднимают зависимости выбранного сервиса.
6. Секрет `telegram-bot-token` не записывается в репозиторий и передаётся gateway только через secret parameter.
7. Минимальный e2e-сценарий запускается из той же топологии.
8. Только после пунктов 1–7 удаляются `Program.cs`, `Topology.cs`, `AppHost.csproj`, C# launch settings и затем отдельно оценивается удаление compose fallback.

Production hosting не определяется этим gate: `aspire publish` можно исследовать как экспорт topology, но целевое окружение принимается отдельным решением.

Работа и её прогресс должны вестись в Linear; этот документ хранит устойчивые правила и проверяемый gap.
