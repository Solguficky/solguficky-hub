-- Оповещение администраторов о новой заявке (PER-435,
-- ADR-062). Повод — событие Identity
-- application_submitted, адресаты — администраторы из реплики, категория
-- «запросы доступа» только глобальная и видна только администратору.
--
-- Ограничения пересоздаются, как в 009–013: CHECK нельзя расширить на месте,
-- а пересоздание держит скрипт идемпотентным.

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested'
));

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_cause_kind_known;
ALTER TABLE notification ADD CONSTRAINT notification_cause_kind_known CHECK (
    cause_kind IN ('meetup_event', 'reminder_task', 'command_request', 'auction_lot_event', 'identity_event')
);

-- Заявитель и запрошенный круг — копия того, о ком и о чём факт, как meetup_id
-- у фактов сходки: снятию по событию о заявителе нужно найти его факты, а
-- разбирать ради этого payload оно не должно. Заявителя в payload нет вовсе
-- (контракт AccessRequested), поэтому колонка — единственное место, где
-- Notifications его помнит. Только у фактов о заявке, и у них обязательно.
-- Версия события заявки держит порядок: закрывающее событие снимает только
-- факты о заявках старше себя, иначе запоздавшая выдача сняла бы оповещение о
-- новой заявке, поданной после потери роли.
ALTER TABLE notification ADD COLUMN IF NOT EXISTS applicant_id uuid NULL;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS access_circle text NULL;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS application_version bigint NULL;

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_applicant_by_type;
ALTER TABLE notification ADD CONSTRAINT notification_applicant_by_type CHECK (
    (type = 'access_requested') = (applicant_id IS NOT NULL)
    AND (type = 'access_requested') = (access_circle IS NOT NULL)
    AND (type = 'access_requested') = (application_version IS NOT NULL)
    AND (access_circle IS NULL OR access_circle IN ('member', 'public'))
);

-- Заявку закрыл допуск или блокировка раньше, чем факт ушёл в шину.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_withdrawal_reason_known;
ALTER TABLE notification ADD CONSTRAINT notification_withdrawal_reason_known CHECK (
    withdrawal_reason IN ('meetup_cancelled', 'expired', 'application_closed')
);

-- Снятие по событию о заявителе ищет его неотправленное.
CREATE INDEX IF NOT EXISTS notification_pending_applicant_idx
    ON notification (applicant_id)
    WHERE dispatched_at IS NULL AND withdrawn_at IS NULL AND applicant_id IS NOT NULL;

-- Новая категория в словаре настроек и в списке только глобальных: подписки,
-- к которой её привязать, нет, как у новой сходки и объявления сообществу.
ALTER TABLE notification_preference DROP CONSTRAINT IF EXISTS notification_preference_category_known;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_category_known CHECK (category IN (
    'meetup_published',
    'meetup_changed',
    'meetup_material',
    'meetup_reminder',
    'organizer_message',
    'community_announcement',
    'access_request'
));

ALTER TABLE notification_preference DROP CONSTRAINT IF EXISTS notification_preference_scope;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_scope CHECK (
    meetup_id IS NULL OR category NOT IN ('meetup_published', 'community_announcement', 'access_request')
);
