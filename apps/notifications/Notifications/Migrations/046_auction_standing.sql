-- Положение аукциона для объявления аукциона (PER-780): команда объявления
-- отказывает скрытому, удалённому и отменённому аукциону, потому что кнопка
-- объявления вела бы получателя к «не найдено».
--
-- Строка — последнее слово фактов аукциона о видимости и конце: публикация и
-- открытие торгов — visible, снятие с публикации — hidden, конец — finished,
-- cancelled или discarded. Версия журнала аукциона держит порядок: удалённый
-- до торгов аукцион рождается заново под тем же auction_id, но журнал у него
-- тот же, и публикация нового рождения приходит со старшей версией.
--
-- Нет строки — аукцион Notifications не знает: опубликованный до этой
-- миграции или ещё не опубликованный. Команда тогда не отказывает: черновик
-- закрывает пульт бота, а отказ всем аукционам до первого факта закрыл бы
-- объявление уже идущему аукциону.
CREATE TABLE IF NOT EXISTS auction_standing
(
    auction_id uuid        NOT NULL,
    meetup_id  uuid        NOT NULL,
    standing   text        NOT NULL,
    version    bigint      NOT NULL,
    updated_at timestamptz NOT NULL,

    CONSTRAINT auction_standing_pkey PRIMARY KEY (auction_id),

    CONSTRAINT auction_standing_known
        CHECK (standing IN ('visible', 'hidden', 'finished', 'cancelled', 'discarded')),

    CONSTRAINT auction_standing_version_positive CHECK (version > 0)
);

-- Снятие неотправленного объявления аукциона: аукцион отменили или удалили,
-- пока объявление ждало релея. Скрытие берёт прежнюю причину auction_hidden.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_withdrawal_reason_known;
ALTER TABLE notification ADD CONSTRAINT notification_withdrawal_reason_known CHECK (
    withdrawal_reason IN ('meetup_cancelled', 'expired', 'application_closed', 'auction_hidden', 'invoice_paid',
                          'auction_cancelled', 'auction_discarded')
);
