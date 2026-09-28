-- Схема Pekko Persistence JDBC 1.3.0: schema/postgres/postgres-create-schema.sql
-- из jar плагина, перенесённый дословно, кроме трёх отличий.
--
-- 1. Нет таблицы durable_state. Auction хранит агрегаты событиями (ADR-045),
--    а её индексы создаются CREATE INDEX CONCURRENTLY, который не выполняется
--    внутри транзакции миграции.
-- 2. Нет схемы public. в именах: таблицы ложатся в схему по умолчанию базы
--    auction, а плагин ищет их без схемы (schemaName = "").
-- 3. Нет IF NOT EXISTS. Повторный запуск отсекает журнал версий Flyway, а
--    таблица, которая уже лежит в базе без записи в нём, — чужая схема
--    неизвестной версии: миграция падает на ней, а не принимает её молча.
--
-- PRIMARY KEY (persistence_id, sequence_number) — ожидаемая версия агрегата
-- (ADR-045, «Append с ожидаемой версией»): вторая запись того же номера
-- отвергается базой. Обновление плагина приносит новую миграцию, а не правку
-- этого файла: применённую миграцию Flyway сверяет по контрольной сумме.

CREATE TABLE event_journal (
  ordering BIGSERIAL,
  persistence_id VARCHAR(255) NOT NULL,
  sequence_number BIGINT NOT NULL,
  deleted BOOLEAN DEFAULT FALSE NOT NULL,

  writer VARCHAR(255) NOT NULL,
  write_timestamp BIGINT,
  adapter_manifest VARCHAR(255),

  event_ser_id INTEGER NOT NULL,
  event_ser_manifest VARCHAR(255) NOT NULL,
  event_payload BYTEA NOT NULL,

  meta_ser_id INTEGER,
  meta_ser_manifest VARCHAR(255),
  meta_payload BYTEA,

  PRIMARY KEY (persistence_id, sequence_number)
);

CREATE UNIQUE INDEX event_journal_ordering_idx ON event_journal (ordering);

CREATE TABLE event_tag (
  event_id BIGINT,
  tag VARCHAR(256),
  PRIMARY KEY (event_id, tag),
  CONSTRAINT fk_event_journal
    FOREIGN KEY (event_id)
    REFERENCES event_journal (ordering)
    ON DELETE CASCADE
);

CREATE TABLE snapshot (
  persistence_id VARCHAR(255) NOT NULL,
  sequence_number BIGINT NOT NULL,
  created BIGINT NOT NULL,

  snapshot_ser_id INTEGER NOT NULL,
  snapshot_ser_manifest VARCHAR(255) NOT NULL,
  snapshot_payload BYTEA NOT NULL,

  meta_ser_id INTEGER,
  meta_ser_manifest VARCHAR(255),
  meta_payload BYTEA,

  PRIMARY KEY (persistence_id, sequence_number)
);
