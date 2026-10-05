-- Изображение лота байтами в строке каталога (ADR-057, дополнение 2026-09-30).
-- Тип и версию сервис выводит из байтов, поэтому три колонки заданы вместе или
-- пусты вместе: строка с одной из них без других — запись в обход сервиса.
-- Предела размера здесь нет: его держит сервис и отвечает на превышение
-- именованным отказом, а смена предела не должна требовать миграции.
ALTER TABLE lot_catalog
    ADD COLUMN image            bytea,
    ADD COLUMN image_media_type text,
    ADD COLUMN image_version    text,
    ADD CONSTRAINT lot_catalog_image_whole CHECK (
        (image IS NULL) = (image_media_type IS NULL)
        AND (image IS NULL) = (image_version IS NULL)
    );
