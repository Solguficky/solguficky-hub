-- Круг без ранга, наборы и права с глаголом (RFC-016). Реплика людей хранит
-- круг (member или guest), наборы и права, которые вывел Identity. Кругов
-- admin и maintainer больше нет: администратор — участник с набором admin,
-- мейнтейнер — участник с наборами maintainer и admin, как переносит их
-- Identity. Права переименовываются тем же словарём, а права наборов
-- дописываются, чтобы реплика до следующего события человека адресовала так
-- же, как адресует Identity после переноса.
--
-- Скрипт идемпотентен: перенос идёт, только пока колонка называется role, а
-- circle ещё нет. Прогон без журнала DbUp повторяет и 022, а та заново
-- добавляет пустую колонку role рядом с уже перенесённой circle: тогда
-- переносить нечего, и колонка просто убирается вместе со своим CHECK.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
            AND table_name = 'identity_replica'
            AND column_name = 'circle')
    THEN
        ALTER TABLE identity_replica DROP COLUMN IF EXISTS role;
    ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
            AND table_name = 'identity_replica'
            AND column_name = 'role')
    THEN
        ALTER TABLE identity_replica DROP CONSTRAINT IF EXISTS identity_replica_role_known;
        ALTER TABLE identity_replica DROP CONSTRAINT IF EXISTS identity_replica_rights_known;
        ALTER TABLE identity_replica RENAME COLUMN role TO circle;
        ALTER TABLE identity_replica ADD COLUMN presets text[] NOT NULL DEFAULT '{}';
        ALTER TABLE identity_replica ALTER COLUMN presets DROP DEFAULT;

        UPDATE identity_replica SET presets = ARRAY['admin'] WHERE circle = 'admin';
        UPDATE identity_replica SET presets = ARRAY['admin', 'maintainer'] WHERE circle = 'maintainer';
        UPDATE identity_replica SET circle = 'member' WHERE circle IN ('admin', 'maintainer');

        -- Право хаба приходит с кругом; manage_auction и manage_membership
        -- записями больше не живут — их несёт набор admin, а у кого набора
        -- нет, у того их нет и в Identity после переноса.
        UPDATE identity_replica AS person
        SET rights = ARRAY(
            SELECT DISTINCT name FROM (
                SELECT CASE old
                    WHEN 'hub' THEN 'access_hub'
                    WHEN 'auction' THEN 'place_bids'
                    WHEN 'moderate_auction' THEN 'admit_bidders'
                END AS name
                FROM unnest(person.rights) AS old
                UNION ALL
                SELECT unnest(ARRAY['admit_bidders', 'manage_members', 'manage_meetups'])
                WHERE 'admin' = ANY (person.presets) AND NOT person.blocked
                UNION ALL
                SELECT 'grant_admins'
                WHERE 'maintainer' = ANY (person.presets) AND NOT person.blocked
            ) AS renamed
            WHERE name IS NOT NULL
            ORDER BY name);
    END IF;
END
$$;

-- Круг. NULL — круга нет: человек ещё не допущен или заблокирован
-- (CIRCLE_UNSPECIFIED в снимке).
ALTER TABLE identity_replica DROP CONSTRAINT IF EXISTS identity_replica_circle_known;
ALTER TABLE identity_replica ADD CONSTRAINT identity_replica_circle_known CHECK (
    circle IS NULL OR circle IN ('member', 'guest')
);

-- Наборы именами. Адресация их не читает, кроме сообщения о назначении
-- администратором: оно проверяет, что набор ещё в силе.
ALTER TABLE identity_replica DROP CONSTRAINT IF EXISTS identity_replica_presets_known;
ALTER TABLE identity_replica ADD CONSTRAINT identity_replica_presets_known CHECK (
    presets <@ ARRAY['admin', 'maintainer']::text[]
);

ALTER TABLE identity_replica DROP CONSTRAINT IF EXISTS identity_replica_rights_known;
ALTER TABLE identity_replica ADD CONSTRAINT identity_replica_rights_known CHECK (
    rights <@ ARRAY['access_hub', 'place_bids', 'manage_members', 'admit_bidders',
                    'manage_meetups', 'grant_admins']::text[]
);

-- Сообщение о выдаче роли admin стало сообщением о выдаче набора admin
-- (PER-468). Строки прежнего типа несут полезную нагрузку с удалённой веткой
-- контракта: неотправленную канал не разобрал бы, а отправленные и снятые
-- больше не читаются. Ключ повода у них — событие role_granted, которое
-- Identity больше не выпускает, поэтому удаление не открывает второго факта.
DELETE FROM notification WHERE type = 'role_granted';

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed'
));
