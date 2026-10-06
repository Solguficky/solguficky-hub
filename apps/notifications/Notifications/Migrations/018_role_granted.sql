-- Сообщение человеку о выдаче роли администратора (PER-468). Повод — событие
-- Identity role_granted с ролью admin, адресат — сам человек, категории нет.
--
-- Ограничение пересоздаётся, как в 014, 015 и 017: CHECK нельзя расширить на
-- месте, а пересоздание держит скрипт идемпотентным. Колонки заявителя у этого
-- факта пусты, как у access_granted: снимать его некому, и
-- notification_applicant_by_type это пропускает.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'role_granted'
));
