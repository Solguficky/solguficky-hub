# Локальная разработка

> **Статус:** Current, частично подтверждено. AppHost-код существует, но `aspire run` ещё не был успешно проверен в живой среде.

Граница между local development, production-like integration и production hosting описана в [инфраструктурном обзоре](../architecture/infrastructure.md).

.NET Aspire — принятый и единственный инструмент локальной оркестрации ([ADR-021](../decisions/ADR-021-aspire-local-orchestration.md)). Рукописные `docker-compose.yml` жили внутри сервисов предыдущего поколения и удалены вместе с ними, поэтому fallback-пути больше нет: если `aspire run` не работает, инфраструктура поднимается вручную.

## AppHost

```powershell
cd infra/apphost
aspire run
```

AppHost объявляет контейнеры PostgreSQL и NATS. Исполняемых компонентов платформы пока нет, поэтому больше он ничего не поднимает.

## Профили

| Профиль | Компоненты |
|---|---|
| `infra` | PostgreSQL + NATS; компоненты платформы выключены |
| `core` | infra + компоненты первого вертикального среза в режиме Local |
| `full` | infra + все зарегистрированные компоненты в режиме Local |

Пока ни один компонент не зарегистрирован, все три профиля дают одинаковый результат — только инфраструктуру. Неизвестное имя профиля отвергается на старте.

```powershell
$env:TOPOLOGY__PROFILE='infra'
aspire run
```

## Режим компонента

Допустимы `Local` (из исходников), `Container` (через Dockerfile) и `Off` (владелец запускает сам):

```powershell
$env:TOPOLOGY__MEETUPS='Off'
aspire run
```

Имена компонентов появляются в `infra/apphost/Program.cs` вместе с их регистрацией; состав первого среза — в `Topology.CoreComponents`. Сейчас список пуст.

## Неподтверждённые места

- `dotnet restore` и `dotnet build` самого AppHost после удаления ссылок на выведенные сервисы;
- `aspire run` и здоровье контейнеров PostgreSQL и NATS в живой среде;
- пригодность `aspire publish` для production-like k3s.

Пока эти проверки не выполнены, не описывай Aspire как подтверждённую production-топологию.

## Acceptance check

Минимальная проверка, закрывающая gate:

1. `dotnet restore` и `dotnet build` для `infra/apphost` успешны.
2. `aspire run` показывает здоровые PostgreSQL и NATS.
3. Неизвестное значение `TOPOLOGY__PROFILE` завершает запуск с понятной ошибкой.
4. Данные PostgreSQL переживают перезапуск AppHost (том `solguficky-postgres-data`).

Работа и её прогресс должны быть заведены в Linear; этот документ хранит только устойчивые правила и проверяемый gap.
