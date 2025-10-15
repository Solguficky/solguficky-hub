# Архитектура Платформы "Соль"

Система построена на принципах **полиглотной, микросервисной архитектуры** с **хореографией на основе событий**. Сервисы слабо связаны и общаются через асинхронную шину сообщений, а также через прямые синхронные вызовы для получения данных.

## Диаграмма верхнего уровня

```mermaid
graph TD
    subgraph Clients
        User[Участник в Telegram]
        Admin[Ведущий (Mini App)]
        Screen[Большой Экран (Web)]
    end

    subgraph Backend Platform
        Gateway[API Gateway<br/>(Rust)]
        Bus{Шина NATS JetStream}
        
        Auction[Auction Service<br/>(Scala/F#)]
        Notifications[Notifications Service<br/>(Elixir)]
        Realtime[Real-Time Hub<br/>(Elixir)]
        
        Events[Events Service<br/>(C#)]
        Users[Users Service<br/>(C#)]
        Achievements[Achievements Service<br/>(C#)]
        
        DB[(PostgreSQL)]
    end

    User -- HTTPS --> Gateway
    Admin -- WebSocket --> Realtime
    Screen -- WebSocket --> Realtime
    
    Gateway -- Async (NATS) & Sync (gRPC) --> Bus & Services
    
    subgraph Service Interactions
        direction LR
        Auction <--> Bus
        Notifications <--> Bus
        Realtime <--> Bus
        Achievements <--> Bus
        Events <--> Bus
    end

    Auction --> DB
    Events --> DB
    Users --> DB
    Achievements --> DB

## Ключевые технологические решения и сервисы

*   **Хостинг:** **Railway (PaaS)** для упрощения развертывания.
*   **Асинхронное взаимодействие:** **NATS JetStream** для надежной доставки команд и событий.
*   **Синхронное взаимодействие:** **gRPC** для быстрых и строго типизированных Service-to-Service вызовов.
*   **Хранение данных:** **PostgreSQL** как для обычных данных, так и в качестве Event Store.
*   **Языки и роли:**
    *   **Rust (API Gateway):** Высокопроизводительный и безопасный входной шлюз.
    *   **Scala/F# (Auction Service):** Строгая типизация и акторная модель для сложной stateful-логики.
    *   **Elixir (Notifications, Real-Time Hub):** Массовая конкурентность для уведомлений и WebSocket.
    *   **C# (Events, Users, Achievements):** Быстрая и надежная разработка CRUD-сервисов.
    *   **TypeScript (Frontend):** Стандарт индустрии для веб-приложений.