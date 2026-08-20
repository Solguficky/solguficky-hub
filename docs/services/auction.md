# Auction Service

> **Current:** C# + Akka.NET, Legacy. **MVP:** не входит. **Future:** новый Scala + Apache Pekko service после MVP; не миграция текущего кода.

## Current

Существующий сервис содержит:

- `AuctionActor` и `LotActor`;
- Event Sourcing/CQRS на Akka.Persistence;
- persistence в PostgreSQL;
- gRPC queries и CRUD лотов;
- NATS command handler;
- публикацию событий через persistence query.

EF migration существует и применяется при старте. Scoped `LotRepository` разрешается через создаваемый scope, а не напрямую удерживается singleton-handler.

Актуальные ограничения:

- runtime/e2e-поведение в production не подтверждалось;
- рефакторинг фаз нельзя считать законченным;
- деньги представлены `double` и не должны переноситься в новые контракты;
- текущая модель является источником опыта и гипотез, а не спецификацией auction v2.

## Что сохранить

- карту агрегатов и actor hierarchy;
- команды, события и состояния;
- найденные инварианты;
- concurrency и ordering assumptions;
- recovery assumptions;
- удачные тестовые сценарии;
- ошибки реализации и выводы;
- непроверенные production-гипотезы;
- границы gRPC, NATS и read model;
- ретро Akka.NET-реализации.

## Что не переносить автоматически

- текущие proto как вечный публичный контракт;
- `double` для денег;
- незавершённую FSM фаз;
- actor topology без нового design cycle;
- persistence schema;
- предположение, что unit tests подтверждают live auction behavior;
- связь текущего WebSocket Gateway с будущей topology.

## Gate вывода Legacy

1. Зафиксировать фактическое состояние.
2. Извлечь domain/actor/event артефакты.
3. Разделить проверенное и непроверенное.
4. Сохранить полезные test cases или их описание.
5. Решить судьбу auction proto и consumers.
6. Удалить код, topology, CI paths и активные инструкции одним согласованным изменением.

Пока gate не пройден, сервис остаётся в репозитории, собирается в CI и не развивается без явного запроса.

## Auction v2

Scala + Apache Pekko — принятое стратегическое Future-направление. Новый сервис проектируется с нуля после MVP. Он должен пройти собственный problem/domain/design cycle; текущий actor topology не является обязательной основой.

Pekko предпочтителен как Apache-проект и открытая actor ecosystem после изменения лицензирования новых версий Akka. До проектирования нужен отдельный ADR.

Открытым остаётся продукт хранения событий: PostgreSQL с собственной append-only таблицей, KurrentDB или Marten при выборе .NET. Это единственное место платформы, где выбор специализированного event store вообще стоит на повестке; критерии сравнения и acceptance test удаления субъекта описаны в решении 5 [RFC-004](../rfcs/RFC-004-meetups-domain-events-persistence.md). Закрывается отдельным spike до проектирования сервиса.

## Свидетельства и ссылки

- Current code: `legacy/auction-service/`
- EF migrations: `legacy/auction-service/src/AuctionService/Migrations/`
- NATS handler scope: `legacy/auction-service/src/AuctionService/Handlers/NatsCommandHandler.cs`
- [Архивный Akka.NET design](../archive/services/auction-service-akka-design.md)
- [Future product specification](../product/future/auction-v2.md)
- [Apache Pekko](https://pekko.apache.org/)
- [Akka migration and licensing notes](https://doc.akka.io/libraries/akka-core/current/project/migration-guide-2.6.x-2.7.x.html)
