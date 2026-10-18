-- Доменная схема подписок и настроек категорий (PER-213).
--
-- Две плоскости, которые продукт просит не путать: подписка на сходку — факт
-- «слежу за этой», категория — что именно присылать. Контракт их не выводит
-- одну из другой, и схема тоже: подписка без единой включённой категории —
-- законное состояние, а не отписка.
--
-- Настройки лежат одной таблицей с необязательной ссылкой на сходку: пустая
-- ссылка означает глобальную настройку (RFC-005 §2). Из этого следует главное
-- продуктовое требование: глобальное значение нигде не копируется в момент
-- подписки, поэтому его правка действует на все сходки, включая будущие.
-- Действующее значение выводится при чтении, а не материализуется при записи.
--
-- Ссылочной целостности с чужими базами нет и не будет: identity_id и meetup_id
-- живут в Identity и Meetups, здесь это голые uuid. Реплика чужих фактов
-- (PER-215) добавит свои таблицы и внешним ключом к этим не привяжется —
-- висящая подписка на ещё не доехавшую сходку является ожидаемым состоянием.

CREATE TABLE IF NOT EXISTS meetup_subscription
(
    identity_id   uuid        NOT NULL,
    meetup_id     uuid        NOT NULL,
    subscribed_at timestamptz NOT NULL,

    CONSTRAINT meetup_subscription_pkey PRIMARY KEY (identity_id, meetup_id)
);

COMMENT ON TABLE meetup_subscription IS
    'Подписки на сходки: строка есть — человек следит за сходкой. Отписка удаляет строку, потому что контракт не различает «не подписывался» и «отписался».';

CREATE TABLE IF NOT EXISTS notification_preference
(
    identity_id uuid        NOT NULL,
    meetup_id   uuid        NULL,
    category    text        NOT NULL,
    enabled     boolean     NOT NULL,
    updated_at  timestamptz NOT NULL,

    -- Словарь категорий продукта. Ключ хранится текстом, а не номером
    -- proto-enum: ограничение ниже обязано читаться без второго файла.
    -- Согласие этого списка с contracts/proto/notifications/v1 держит
    -- юнит-тест на тотальность словаря, а не комментарий.
    CONSTRAINT notification_preference_category_known CHECK (category IN (
        'meetup_published',
        'meetup_changed',
        'meetup_material',
        'meetup_reminder',
        'organizer_message',
        'community_announcement'
    )),

    -- RFC-005 §2 просит именно ограничения схемы, а не проверки в обработчике:
    -- «новая опубликованная сходка» и «объявление сообществу» существуют только
    -- глобально, потому что подписки, к которой их привязать, не существует.
    -- Обработчик gRPC отвечает на такую пару INVALID_ARGUMENT и до записи не
    -- доходит; это ограничение держит тот же инвариант против всех остальных
    -- писателей — event plane PER-215, напоминаний PER-222 и ручного SQL.
    CONSTRAINT notification_preference_scope CHECK (
        meetup_id IS NULL OR category NOT IN ('meetup_published', 'community_announcement')
    )
);

COMMENT ON TABLE notification_preference IS
    'Настройки категорий: строка с пустым meetup_id — глобальная, с непустым — переопределение у сходки. Отсутствие строки означает значение продукта по умолчанию, а отсутствие переопределения — наследование глобальной.';

-- Два частичных индекса вместо одного обычного. Обычный UNIQUE по тройке
-- (identity_id, meetup_id, category) пропустил бы две глобальные записи одной
-- категории: NULL не равен NULL, поэтому такие строки для него не конфликтуют.
CREATE UNIQUE INDEX IF NOT EXISTS notification_preference_global_uq
    ON notification_preference (identity_id, category)
    WHERE meetup_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS notification_preference_meetup_uq
    ON notification_preference (identity_id, meetup_id, category)
    WHERE meetup_id IS NOT NULL;
