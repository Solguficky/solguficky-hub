-- Реплика людей хранит роль-круг и права, а не прежний набор ролей (PER-529,
-- ADR-064). Права выводит Identity и отдаёт в state.rights каждого события;
-- реплика пишет их как есть и из роли не выводит. Роль нужна одному правилу —
-- «человек всё ещё администратор» у сообщения о выдаче admin (PER-468).
--
-- Строки прежней формы права не несут, и вывести их из ролей значило бы
-- завести второй счётчик рядом с Identity. Поэтому таблица сбрасывается, а не
-- переносится: решение владельца по PER-529 — данные среды заводятся заново
-- после перевода на права. Сброс идёт только при прежней форме, поэтому
-- повторный прогон скрипта реплику новой формы не трогает.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
            AND table_name = 'identity_replica'
            AND column_name = 'global_roles')
    THEN
        TRUNCATE identity_replica;
    END IF;
END
$$;

ALTER TABLE identity_replica DROP CONSTRAINT IF EXISTS identity_replica_roles_known;
ALTER TABLE identity_replica DROP COLUMN IF EXISTS global_roles;

-- Активная роль-круг. NULL — круга нет: человек ещё не допущен или
-- заблокирован (GLOBAL_ROLE_UNSPECIFIED в снимке).
ALTER TABLE identity_replica ADD COLUMN IF NOT EXISTS role text NULL;

-- Права именами, без обещанного порядка. Пустой набор — состояние, а не
-- отсутствие: так выглядят и недопущенный, и гость без прав, и заблокированный.
-- NOT NULL без умолчания держится на сбросе выше: строк прежней формы к этому
-- месту нет, а значение по умолчанию выдало бы пустые права за прочитанные.
ALTER TABLE identity_replica ADD COLUMN IF NOT EXISTS rights text[] NOT NULL;

ALTER TABLE identity_replica DROP CONSTRAINT IF EXISTS identity_replica_role_known;
ALTER TABLE identity_replica ADD CONSTRAINT identity_replica_role_known CHECK (
    role IS NULL OR role IN ('admin', 'maintainer', 'member', 'guest')
);

ALTER TABLE identity_replica DROP CONSTRAINT IF EXISTS identity_replica_rights_known;
ALTER TABLE identity_replica ADD CONSTRAINT identity_replica_rights_known CHECK (
    rights <@ ARRAY['hub', 'auction', 'manage_membership', 'moderate_auction']::text[]
);
