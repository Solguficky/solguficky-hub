# Справочник: Темы (Subjects) в NATS

Этот документ является единым источником правды для именования тем и форматов сообщений в NATS.

## Формат сериализации

Все сообщения в NATS сериализуются в формате **Protobuf** (Protocol Buffers). Схемы (`.proto` файлы) управляются централизованно через **Apicurio Registry**, который обеспечивает:

*   Централизованное хранилище всех версий схем
*   Автоматическую проверку совместимости при регистрации новых версий
*   Уменьшение размера сообщений (сообщения содержат только ID схемы, а не саму схему)
*   Кодогенерацию клиентов для всех языков платформы

Исходные `.proto` файлы хранятся в `contracts/proto/` и автоматически публикуются в Apicurio через CI/CD.

## Принципы именования

Используется иерархическая структура: `<тип>.<домен>.<действие>`

*   **Тип:** `commands` (намерения), `events` (факты).
*   **Домен:** `events`, `auction`, `users`, `notifications`, `telegram`.
*   **Действие:** `create`, `update`, `place_bid`, `started`, `created`.

## Список тем (v1)

### Команды (Commands)

*   **`commands.events.create`**
    *   *Отправитель:* Telegram Gateway
    *   *Получатель:* Meetups Service
    *   *Описание:* Создать новую сходку (изначально в статусе "предложена").
*   **`commands.auction.start`**
    *   *Отправитель:* Telegram Gateway
    *   *Получатель:* Auction Service
    *   *Описание:* Начать аукцион для сходки.

*   **`commands.auction.place_bid`**
    *   *Отправитель:* Telegram Gateway
    *   *Получатель:* Auction Service
    *   *Описание:* Сделать ставку на лот.

*   **`commands.telegram.send_message`**
    *   *Отправитель:* Notifications Service
    *   *Получатель:* Telegram Gateway
    *   *Описание:* Отправить сообщение пользователю в Telegram.

### События (Events)

*   **`events.event.created`**
    *   *Отправитель:* Meetups Service
    *   *Получатель:* Notifications Service, Achievements Service, etc.
    *   *Описание:* Новая сходка была создана и одобрена.

*   **`events.auction.bid_placed`**
    *   *Отправитель:* Auction Service
    *   *Получатель:* Notifications Service, Real-Time Hub, Achievements Service.
    *   *Описание:* Была сделана новая ставка. Содержит информацию о предыдущем и текущем лидере.
*   **`events.auction.finished`**
    *   *Отправитель:* Auction Service
    *   *Получатель:* Notifications Service, Achievements Service
    *   *Описание:* Аукцион для сходки завершен.
*   **`events.auction.lot_sold`**
    *   *Отправитель:* Auction Service
    *   *Получатель:* Notifications Service, Achievements Service.
    *   *Описание:* Торги по лоту завершены.