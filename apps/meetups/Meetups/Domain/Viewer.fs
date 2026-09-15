namespace Meetups.Domain

/// Общая роль платформы. Словарь совпадает с identity.v1.GlobalRole, но тип свой:
/// домен не открывает namespace сгенерированных контрактов, иначе смена схемы
/// начала бы двигать доменные решения.
type GlobalRole = Administrator

/// Кто спрашивает. Личность и роли приходят одним значением, потому что решение о
/// праве принимается по ним обоим: Meetups за фактами о человеке не ходит и готового
/// разрешения не принимает — бот передаёт установленную личность и общие роли
/// (integration.md, ADR-026).
///
/// Роли — множество, а не список: порядок и повторы в правах ничего не значат, и
/// набор из двух одинаковых ролей не должен отличаться от набора из одной.
type Viewer =
    {
        IdentityId: PersonId
        Roles: Set<GlobalRole>
    }

module Viewer =

    let isAdministrator (viewer: Viewer) : bool = Set.contains Administrator viewer.Roles
