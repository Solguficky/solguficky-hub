-- Фото лота упорядоченным списком (ADR-057, дополнение 2026-10-24; PER-721):
-- до десяти фото, порядок — порядок добавления, первое — обложка. Строка фото —
-- состояние каталога, а не журнал, как строка lot_catalog.
--
-- Миграция только добавляет: колонки изображения lot_catalog остаются и всегда
-- равны обложке — их переписывает в той же транзакции каждая запись фото. Образ
-- Auction без этой таблицы после отката читает обложку из lot_catalog и работает.
--
-- Предела числа и размера здесь нет, как у V8: его держит сервис и отвечает на
-- превышение именованным отказом. position не обязана идти подряд: снятие фото
-- оставляет пропуск, порядок задаёт сравнение.
CREATE TABLE lot_photo (
    lot_id     uuid    NOT NULL REFERENCES lot_catalog (lot_id),
    photo_id   uuid    NOT NULL,
    position   integer NOT NULL CHECK (position > 0),
    content    bytea   NOT NULL,
    media_type text    NOT NULL,
    version    text    NOT NULL,
    PRIMARY KEY (lot_id, photo_id),
    UNIQUE (lot_id, position)
);

-- Изображение, записанное до таблицы, становится первым фото лота. Id ему даёт
-- база: вызывающего у него нет. Id — UUIDv7 (ADR-020): функции uuidv7() в
-- PostgreSQL 16 нет, поэтому миллисекунды времени ложатся в первые шесть байт
-- случайного UUID, а биты 52 и 53 переводят версию 4 в 7.
INSERT INTO lot_photo (lot_id, photo_id, position, content, media_type, version)
SELECT lot_id,
       encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
                                      PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                                      FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
       1, image, image_media_type, image_version
FROM lot_catalog
WHERE image IS NOT NULL;
