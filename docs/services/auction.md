# Auction

> **Слой:** Future. **MVP:** не входит. **Направление:** новый сервис на Scala + Apache Pekko, проектируемый с нуля после MVP.

Реализация предыдущего поколения (C# + Akka.NET) удалена из репозитория. Аукцион существует как продуктовая гипотеза и как накопленный опыт, но не как код.

## Что уже известно

Доменная модель, actor/event-логика, контрактный след, тест-кейсы, каталог дефектов и непроверенные гипотезы прежней реализации извлечены в [архив](../archive/services/auction-domain-and-lessons.md). Это единственный источник, из которого стоит отталкиваться при проектировании; сам код восстанавливается из истории Git и спецификацией не является.

Продуктовые механики — форматы торгов, анти-снайп, Buy-Now — собраны в [продуктовой спецификации](../product/future/auction.md). Ни одна из них не проверена ни кодом, ни живым мероприятием.

## Что не переносить автоматически

- прежние proto как вечный публичный контракт;
- `double` для денег;
- незавершённую машину фаз;
- actor topology без нового design cycle;
- persistence schema;
- предположение, что unit-тесты подтверждают поведение живого аукциона;
- топологию прежнего realtime-шлюза как обязательную для Big Screen.

## Стек и открытые вопросы

Scala + Apache Pekko — принятое стратегическое направление. Pekko предпочтителен как Apache-проект и открытая actor ecosystem после изменения лицензирования новых версий Akka. Сервис должен пройти собственный problem/domain/design cycle, и до начала проектирования нужен отдельный ADR.

Открытым остаётся продукт хранения событий: PostgreSQL с собственной append-only таблицей, KurrentDB или Marten при выборе .NET. Это единственное место платформы, где выбор специализированного event store вообще стоит на повестке; критерии сравнения и acceptance test удаления субъекта описаны в решении 5 [RFC-004](../rfcs/RFC-004-meetups-domain-events-persistence.md). Закрывается отдельным spike до проектирования сервиса.

Возврат realtime-шлюза для Big Screen решается вместе с аукционом и отдельным решением о стеке.

## Свидетельства и ссылки

- [Извлечённое знание: доменная модель и уроки реализации](../archive/services/auction-domain-and-lessons.md)
- [Архивный Akka.NET design](../archive/services/auction-service-akka-design.md)
- [Архивный design realtime-шлюза](../archive/services/websocket-gateway-auction-design.md)
- [Продуктовая спецификация](../product/future/auction.md)
- [Apache Pekko](https://pekko.apache.org/)
- [Akka migration and licensing notes](https://doc.akka.io/libraries/akka-core/current/project/migration-guide-2.6.x-2.7.x.html)
