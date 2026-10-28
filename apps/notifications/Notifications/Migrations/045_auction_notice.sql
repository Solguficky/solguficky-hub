-- Объявление аукциона (PER-764): ручная рассылка того, кто ведёт аукцион
-- сходки, всем держателям права ставок. Третья рассылка того же механизма, что
-- сообщение организатора и объявление сообществу (012): строка broadcast —
-- ключ идемпотентности, разворот в адресные факты auction_notice — той же
-- транзакцией.
--
-- У объявления, кроме тела, есть кнопка и необязательная картинка — фото лота
-- или пост чата медиа ботов, ссылкой, без байтов. Они входят
-- в содержимое рассылки: повтор с тем же id и другой кнопкой — конфликт, а не
-- повтор, поэтому хранятся колонками и сравниваются, как тело.
ALTER TABLE broadcast ADD COLUMN IF NOT EXISTS button_view text NULL;
ALTER TABLE broadcast ADD COLUMN IF NOT EXISTS button_lot_id uuid NULL;
ALTER TABLE broadcast ADD COLUMN IF NOT EXISTS photo_lot_id uuid NULL;
ALTER TABLE broadcast ADD COLUMN IF NOT EXISTS photo_id uuid NULL;
ALTER TABLE broadcast ADD COLUMN IF NOT EXISTS photo_message_id bigint NULL;

ALTER TABLE broadcast DROP CONSTRAINT IF EXISTS broadcast_kind_known;
ALTER TABLE broadcast ADD CONSTRAINT broadcast_kind_known
    CHECK (kind IN ('organizer_message', 'community_announcement', 'auction_notice'));

-- Сходка есть у рассылки по сходке и у объявления аукциона: аукцион сходки
-- выводится из неё.
ALTER TABLE broadcast DROP CONSTRAINT IF EXISTS broadcast_meetup_by_kind;
ALTER TABLE broadcast ADD CONSTRAINT broadcast_meetup_by_kind
    CHECK ((kind IN ('organizer_message', 'auction_notice')) = (meetup_id IS NOT NULL));

-- Кнопка бывает только у объявления аукциона, и у него она необязательна;
-- лот кнопки — ровно у вида «лот».
ALTER TABLE broadcast DROP CONSTRAINT IF EXISTS broadcast_button_by_kind;
ALTER TABLE broadcast ADD CONSTRAINT broadcast_button_by_kind
    CHECK (button_view IS NULL OR kind = 'auction_notice');

ALTER TABLE broadcast DROP CONSTRAINT IF EXISTS broadcast_button_view_known;
ALTER TABLE broadcast ADD CONSTRAINT broadcast_button_view_known
    CHECK (button_view IN ('auction', 'lots', 'lot', 'raffle', 'predictions', 'chronicle'));

ALTER TABLE broadcast DROP CONSTRAINT IF EXISTS broadcast_button_lot_by_view;
ALTER TABLE broadcast ADD CONSTRAINT broadcast_button_lot_by_view
    CHECK ((button_view IS NOT DISTINCT FROM 'lot') = (button_lot_id IS NOT NULL));

-- Картинка — пара «лот, фото» целиком, пост чата или ничего, не обе сразу, и
-- только у объявления аукциона.
ALTER TABLE broadcast DROP CONSTRAINT IF EXISTS broadcast_photo_whole;
ALTER TABLE broadcast ADD CONSTRAINT broadcast_photo_whole
    CHECK ((photo_lot_id IS NULL) = (photo_id IS NULL)
        AND (photo_id IS NULL OR photo_message_id IS NULL)
        AND (photo_message_id IS NULL OR photo_message_id > 0)
        AND ((photo_id IS NULL AND photo_message_id IS NULL) OR kind = 'auction_notice'));

-- Тип вести добавлен к известным, иначе первое же объявление нарушило бы
-- ограничение на типе.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed', 'lot_activity_digest',
    'auction_final_lineup', 'auction_final_started', 'lot_reminder', 'raffle_result',
    'prediction_results', 'release_summary', 'auction_cancelled',
    'lot_deadline_close', 'auction_final_lot_next', 'step_window_started',
    'lot_lead_restored', 'auction_published', 'auction_trading_opened',
    'invoice_reminder', 'invoice_due_reminder', 'lot_set_collected',
    'auction_notice'
));
