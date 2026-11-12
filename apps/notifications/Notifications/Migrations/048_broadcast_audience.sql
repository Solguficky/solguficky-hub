-- Фильтр аудитории объявления аукциона (PER-778): все держатели права ставок
-- или те, кого Auction не видит в розыгрыше или в прогнозах. Входит в
-- содержимое рассылки, как кнопка (045): повтор с тем же id и другим фильтром —
-- конфликт. Хранится только слово фильтра — тех, кого он исключил, сервис не
-- хранит.
ALTER TABLE broadcast ADD COLUMN IF NOT EXISTS audience text NULL;

-- Объявления, принятые до фильтра, ушли всем.
UPDATE broadcast SET audience = 'all' WHERE kind = 'auction_notice' AND audience IS NULL;

ALTER TABLE broadcast DROP CONSTRAINT IF EXISTS broadcast_audience_by_kind;
ALTER TABLE broadcast ADD CONSTRAINT broadcast_audience_by_kind
    CHECK ((kind = 'auction_notice') = (audience IS NOT NULL));

ALTER TABLE broadcast DROP CONSTRAINT IF EXISTS broadcast_audience_known;
ALTER TABLE broadcast ADD CONSTRAINT broadcast_audience_known
    CHECK (audience IN ('all', 'not_in_raffle', 'without_predictions', 'not_in_raffle_or_without_predictions'));
