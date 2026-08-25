# Archive

Исторические материалы, не являющиеся источником актуальных решений.

- `snapshots/` — датированные общие и визуальные срезы;
- `product/` — прежние продуктовые формулировки;
- `services/` — технические ТЗ выведенных из эксплуатации сервисов и знание, извлечённое из их кода;
- `context/` — исходные исторические обсуждения.

Каждый материал используется только для восстановления истории или извлечения знаний. Текущий контекст находится в профильных документах [product/](../product/), [architecture/](../architecture/) и [services/](../services/). Полный переходный срез сохранён в `snapshots/project-context-2026-08-06.md`.

## Знание, извлечённое из удалённого кода

Сервисы предыдущего поколения — C#/Akka.NET Auction, Rust/Teloxide Telegram Gateway, C# Notifications и C#/SignalR WebSocket Gateway — удалены из репозитория. Перед удалением из их кода извлечено то, чего нет в ТЗ:

- [Аукцион: доменная модель и уроки реализации](services/auction-domain-and-lessons.md) — фактически реализованные правила торгов, actor/event-логика, контрактный след, тест-кейсы, каталог дефектов и непроверенные гипотезы.

Соседние ТЗ (`auction-service-akka-design.md`, `telegram-gateway-rust-design.md`, `notifications-auction-design.md`, `websocket-gateway-auction-design.md`) описывают замысел и местами расходятся с тем, что было написано. При конфликте верен разбор кода.

## Материалы аукционного модуля

- [исходник презентации в Marp Markdown](services/auction-module-slides.md);
- [автономная HTML-презентация для администраторов](services/auction-module-presentation.html);
- [опубликованная презентация](https://solguficky-auction-module-slides.netlify.app/).

Презентация отражает состояние обсуждения на 28.10.2025 и не определяет текущий scope MVP.
