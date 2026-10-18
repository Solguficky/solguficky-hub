-- Сообщение заявителю о допуске (PER-442). Повод — событие Identity
-- application_admitted, адресат — сам заявитель, категории нет.
--
-- Ограничение пересоздаётся, как в 014 и 015: CHECK нельзя расширить на месте,
-- а пересоздание держит скрипт идемпотентным. Колонки заявителя у этого факта
-- пусты: снимать его некому, и notification_applicant_by_type это пропускает.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted'
));
