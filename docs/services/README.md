# Services

Этот каталог описывает границы и жизненный статус компонентов. Сборка, запуск и структура исходников остаются в README конкретного сервиса.

| Компонент | Слой | Состояние |
|---|---|---|
| Telegram Gateway | Current / Legacy | Rust + Teloxide, преимущественно UI старого аукциона |
| Telegram Gateway replacement | MVP | TypeScript + grammY — направление принято, детали требуют ADR |
| Meetups | MVP | Не реализован; язык, модель и контракты открыты |
| Identity | MVP | Отдельный сервис, не реализован; язык и failure model открыты |
| Notifications | Current / MVP candidate | C#-каркас существует; reminders ещё не спроектированы |
| Auction Service | Legacy | C# + Akka.NET; вне MVP, не развивается без явного запроса |
| WebSocket Gateway | Legacy / Frozen | C# + SignalR; обслуживает только аукцион |
| Auction v2 | Future | Предварительное направление Scala + Pekko, без активного дизайна |
| Mini App | MVP / Future | Макеты и границы ещё не утверждены; это клиент, не backend-сервис |

Полные service briefs будут созданы при переносе [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md). Старые технические ТЗ сохранены в [archive/services/](../archive/services/).
