namespace Meetups.Domain

/// Право, которое выводит Identity. Словарь совпадает с identity.v1.AccessRight, но
/// тип свой: домен не открывает namespace сгенерированных контрактов, иначе смена
/// схемы начала бы двигать доменные решения.
///
/// Правила среза читают только ManageMeetups. Остальные права несут словарь, а не
/// разрешение: предикатов у них нет, пока домен не решит, что они значат. Круг и
/// наборы Meetups не видит: допуск решает право, а не они (RFC-016).
type AccessRight =
    | AccessHub
    | PlaceBids
    | ManageMembers
    | AdmitBidders
    | ManageMeetups
    | GrantAdmins
    | RunAuctions

/// Кто спрашивает. Личность и права приходят одним значением, потому что решение о
/// допуске принимается по ним обоим: Meetups за фактами о человеке не ходит и готового
/// разрешения не принимает — бот передаёт установленную личность и права, которые
/// вывел Identity (integration.md, ADR-026).
///
/// Права — множество, а не список: порядок и повторы ничего не значат, и набор из
/// двух одинаковых прав не должен отличаться от набора из одного.
type Viewer =
    {
        IdentityId: PersonId
        Rights: Set<AccessRight>
    }

module Viewer =

    let canManageMeetups (viewer: Viewer) : bool = Set.contains ManageMeetups viewer.Rights
