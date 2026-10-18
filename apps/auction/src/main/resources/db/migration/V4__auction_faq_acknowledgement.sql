-- Общий FAQ всех аукционов: отметка явного перехода в меню, не история чтения.
-- Не связана с допуском Identity и не зависит от выбранного имени участника.
CREATE TABLE auction_faq_acknowledgement (
    participant_id uuid PRIMARY KEY
);
