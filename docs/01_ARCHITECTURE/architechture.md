# Архитектура Платформы "Solguficky"

Система построена на принципах **полиглотной, микросервисной архитектуры** с **хореографией на основе событий**. Сервисы слабо связаны и общаются через асинхронную шину сообщений, а также через прямые синхронные вызовы для получения данных.

## Диаграмма верхнего уровня

```mermaid
graph TD
    subgraph Clients
        User[Участник в Telegram]
        Admin[Ведущий Mini App]
        Screen[Большой Экран Web]
    end

    subgraph Backend Platform
        Gateway[Telegram Gateway<br/>Rust]
        Bus{Шина NATS JetStream}
        Registry[Apicurio Registry<br/>Schema Registry]

        subgraph Stateful Services
            direction LR
            Auction[Auction Service<br/>Scala/F# + Akka]
            Notifications[Notifications Service<br/>Elixir]
            Realtime[Real-Time Hub<br/>Elixir + Phoenix]
        end

        subgraph Stateless Services
            direction LR
            Events[Events Service<br/>C#]
            Users[Users Service<br/>C#]
            Achievements[Achievements Service<br/>C#]
            ContentFeed[Content Feed Service<br/>C#]
        end

        DB[(PostgreSQL<br/>Event Store &<br/>Read Models)]
    end

    %% Client Connections
    User -- HTTPS/Webhook --> Gateway
    Admin -- WebSocket --> Realtime
    Screen -- WebSocket --> Realtime

    %% Gateway Interactions
    Gateway -- Async Command --> Bus
    Gateway -- Sync gRPC Query --> Events
    Gateway -- Sync gRPC Query --> Users
    Gateway -- Sync gRPC Query --> Achievements
    Gateway -- Sync gRPC Query --> ContentFeed

    %% Event Bus Choreography
    Bus -- Command --> Auction
    Bus -- Command --> Events
    Bus -- Command --> Users
    Bus -- Command --> ContentFeed

    Auction -- Event --> Bus
    Users -- Event --> Bus
    Events -- Event --> Bus
    ContentFeed -- Event --> Bus

    Bus -- Event --> Notifications
    Bus -- Event --> Achievements
    Bus -- Event --> Realtime

    %% Service-to-Service & DB Interactions
    Auction -- Sync gRPC Query --> Events

    Auction -- Writes to Event Store --> DB
    Notifications -- DB Read/Write --> DB
    Events -- DB Read/Write --> DB
    Users -- DB Read/Write --> DB
    Achievements -- DB Read/Write --> DB
    ContentFeed -- DB Read/Write --> DB
```

## Краткое описание сервисов

*   **Telegram Gateway (Rust):** Принимает все внешние запросы, отвечает за авторизацию и роутинг. Команды отправляет в шину, за данными ходит напрямую.
*   **Auction Service (Scala/F#):** Stateful-сервис, управляющий сложной логикой аукционов с помощью акторной модели и Event Sourcing.
*   **Notifications Service (Elixir):** Stateful-сервис для формирования и планирования отложенных уведомлений.
*   **Real-Time Hub (Elixir):** WebSocket-шлюз для "живой" доставки событий на фронтенд-клиенты.
*   **Events Service (C#):** CRUD-сервис, "владелец" данных о сходках.
*   **Users Service (C#):** CRUD-сервис, управляет пользователями, ролями и правами.
*   **Achievements Service (C#):** Stateless-сервис, слушает события и выдает ачивки.
*   **Content Feed Service (C#):** CRUD-сервис для управления информационной лентой сходки (посты, голосования, ссылки).

### Клиентские приложения

*   **Admin Panel (Mini App):** Telegram Mini App для ведущего аукциона. Предоставляет богатый UI для управления ходом торгов (например, прием ставок из зала) с бесшовной и безопасной аутентификацией через Telegram.
*   **Big Screen App (Web):** Отдельное веб-приложение для отображения хода аукциона на большом экране (проекторе) во время офлайн-мероприятий. Получает данные в реальном времени через WebSocket от `Real-Time Hub`.

## Ключевые технологические решения и сервисы

*   **Хостинг:** **Railway (PaaS)** для упрощения развертывания.
*   **Асинхронное взаимодействие:** **NATS JetStream** для надежной доставки команд и событий.
*   **Синхронное взаимодействие:** **gRPC** для быстрых и строго типизированных Service-to-Service вызовов.
*   **Управление схемами:** **Protobuf-in-Git**. Схемы сообщений (`.proto` файлы) хранятся в репозитории и являются частью контракта сервиса. Кодогенерация происходит на этапе сборки.
*   **Хранение данных:** **PostgreSQL** как для обычных данных, так и в качестве Event Store.
*   **Языки и роли:**
    *   **Rust (Telegram Gateway):** Высокопроизводительный и безопасный входной шлюз.
    *   **Scala/F# (Auction Service):** Строгая типизация и акторная модель для сложной stateful-логики.
    *   **Elixir (Notifications, Real-Time Hub):** Массовая конкурентность для уведомлений и WebSocket.
    *   **C# (Events, Users, Achievements):** Быстрая и надежная разработка CRUD-сервисов.
    *   **TypeScript (Frontend):** Стандарт индустрии для веб-приложений (`Big Screen App`, `Admin Panel`). Рекомендуется использование современных фреймворков, таких как Svelte, Vue или React.

## Наблюдаемость (Observability)

*   **Логирование:** Все сервисы пишут структурированные JSON-логи в `stdout`. Сбор, хранение и индексация логов осуществляется централизованно с помощью **Loki**.
*   **Визуализация и анализ:** Для анализа логов, построения дашбордов и алертинга используется **Grafana**, которая читает данные из Loki.