-- Ручные рассылки (PER-225): сообщение организатора подписчикам сходки и
-- объявление сообществу. Команда разворачивается на получателей адресными
-- фактами organizer_message и community_announcement тем же outbox, что и
-- автоматические поводы.
--
-- Строка рассылки — ключ идемпотентности. Поле id запроса генерирует
-- вызывающая сторона, и оно одновременно идентификатор рассылки
-- (docs/architecture/integration.md). Приём ключа и разворот на получателей
-- идут одной транзакцией: иначе два одновременных вызова с одним id оба не
-- нашли бы ключ и оба отправили бы сообщение. Вторую вставку держит первичный
-- ключ — она ждёт коммита первой и уходит в ON CONFLICT, а не в дубль.
--
-- Содержимое хранится целиком, а не хешем: повтор с тем же id отличается от
-- конфликта (ALREADY_EXISTS) сравнением автора, сходки и тела, и строка
-- заодно остаётся журналом того, кто и что разослал.
CREATE TABLE IF NOT EXISTS broadcast
(
    broadcast_id uuid        NOT NULL,

    -- Тип адресных фактов, которые рассылка порождает; вид рассылки.
    kind         text        NOT NULL,

    author_id    uuid        NOT NULL,

    -- Сходка рассылки по сходке. У объявления сообществу сходки нет.
    meetup_id    uuid        NULL,

    body         text        NOT NULL,

    -- Момент первого приёма. Повтор с тем же id отвечает им, а не своим.
    accepted_at  timestamptz NOT NULL,

    CONSTRAINT broadcast_pkey PRIMARY KEY (broadcast_id),
    CONSTRAINT broadcast_kind_known CHECK (kind IN ('organizer_message', 'community_announcement')),
    CONSTRAINT broadcast_meetup_by_kind CHECK ((kind = 'organizer_message') = (meetup_id IS NOT NULL)),
    -- Пустое тело отвергает граница с INVALID_ARGUMENT; здесь тот же инвариант
    -- против всех остальных писателей.
    CONSTRAINT broadcast_body_not_empty CHECK (body <> '')
);

COMMENT ON TABLE broadcast IS
    'Принятые ручные рассылки: ключ идемпотентности команды и журнал разосланного. Адресные факты — в notification с cause_kind = command_request.';

-- Типы фактов рассылок. Ограничение пересоздаётся, как в 009 и 011: CHECK
-- нельзя расширить на месте. Вид повода command_request схема допускала с 008.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;

ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published',
    'meetup_changed',
    'meetup_material',
    'meetup_unpublished',
    'meetup_reminder',
    'organizer_message',
    'community_announcement'
));
