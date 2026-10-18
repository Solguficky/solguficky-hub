-- Схема скелета: одна таблица, и она про исполнение, а не про домен.
--
-- ADR-029 проводит границу так: состояние гринов — это исполнение и таймеры,
-- а источник истины остаётся в PostgreSQL. Эта таблица и есть проверяемая
-- форма той границы: грин ничего не хранит в storage provider, а всё, что он
-- должен пережить, лежит здесь обычной строкой.
--
-- Доменной схемы тут нет намеренно. Подписки, категории и переопределения —
-- PER-213, задание напоминания и sweeper — PER-222. Они добавят свои таблицы
-- своими миграциями и с этой не столкнутся.

CREATE TABLE IF NOT EXISTS grain_activation
(
    grain_key   text        NOT NULL,
    silo        text        NOT NULL,
    activations bigint      NOT NULL,
    observed_at timestamptz NOT NULL,

    CONSTRAINT grain_activation_pkey PRIMARY KEY (grain_key)
);

COMMENT ON TABLE grain_activation IS
    'Журнал активаций гринов: сколько раз грин с этим ключом поднимался и на каком силосе. Плоскость исполнения, не домен.';
