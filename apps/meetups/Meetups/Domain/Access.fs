namespace Meetups.Domain

/// Отклонённое право действовать. Отдельный тип, а не вариант DomainError: право не
/// является инвариантом перехода состояния. Один случай на все причины: чужая,
/// скрытая и отсутствующая сходка, организатор без права `organize_meetups`, автор,
/// вышедший из состава, — для вызывающего неразличимы (ADR-076, п. 9 и 12).
type AccessDenied = CannotActOnMeetup

/// Отношение человека к сходке, которое вызывающий сервис принимает как право
/// действовать от её имени (ADR-051). Словарь принадлежит Meetups и растёт вместе с
/// доменом. Администратор сообщества держится на `manage_meetups`, ведущий аукциона
/// — на `run_auctions` (ADR-070, п. 1): им запись сходки не нужна. Организатор —
/// человек в составе сходки, который ещё и держит `organize_meetups` (ADR-076, п. 4):
/// ему нужна загруженная сходка.
type MeetupRelation =
    | CommunityAdministrator
    | AuctionRunner
    | Organizer

/// Политика доступа среза. Живёт в ядре, а не в срезах, потому что решение
/// принимается из значений и без I/O, а правило одно на все команды: копии
/// предиката разошлись бы на первой же правке. Файл стоит до Domain/Meetup.fs
/// намеренно — политика не должна быть способна увидеть приватное представление
/// агрегата и читает состояние только снимком.
module Access =

    /// Человек в составе сходки и держит `organize_meetups`. Право берётся из прав
    /// смотрящего на этом же update, а в `CheckMeetupAuthority` его спрашивает
    /// Identity (ADR-051); состав без права власти не даёт, право без состава — тоже.
    let isOrganizer (holdsOrganizeRight: bool) (person: PersonId) (snapshot: MeetupSnapshot) : bool =
        holdsOrganizeRight
        && List.contains person snapshot.Organizers

    /// Завести сходку: держатель `organize_meetups` или администратор (ADR-076, п. 2).
    /// Состояние в решении не участвует, поэтому проверка стоит до загрузки.
    let mayCreate (viewer: Viewer) : bool =
        Viewer.canManageMeetups viewer
        || Set.contains OrganizeMeetups viewer.Rights

    /// Снять другого человека из состава: только администратор (ADR-076, дополнение
    /// 2026-11-13 к п. 6). Организатор назначает, но не снимает; себя он убирает
    /// выходом. Состояние в решении не участвует, поэтому проверка стоит до загрузки.
    let mayDismissOrganizer (viewer: Viewer) : bool = Viewer.canManageMeetups viewer

    /// Право действовать от имени сходки для пишущих команд. Права смотрящего
    /// разрешил бот на этом же update (ADR-051, п. 7); другие сервисы задают тот же
    /// вопрос запросом CheckMeetupAuthority, и право для него Meetups спрашивает у
    /// Identity сам.
    ///
    /// Администратор ведёт любую сходку по праву, в том числе несуществующую, — ему
    /// существование не тайна, и ответ «нет сходки» даёт домен. Остальным решение
    /// принимается ПОСЛЕ загрузки, потому что состав лежит в сходке; чужая и
    /// отсутствующая сходка дают один отказ и одну последовательность запросов
    /// (ADR-076, п. 12): срез всегда загружает, а потом решает.
    let actOnBehalf (viewer: Viewer) (snapshot: MeetupSnapshot option) : Result<unit, AccessDenied> =
        if Viewer.canManageMeetups viewer then
            Ok()
        else
            match snapshot with
            | Some snapshot when isOrganizer (Set.contains OrganizeMeetups viewer.Rights) viewer.IdentityId snapshot ->
                Ok()
            | _ -> Error CannotActOnMeetup

    /// Права, которые дают принимаемые отношения, держащиеся на праве. Отношение,
    /// которому нужна запись сходки, сюда не входит: его решает `isOrganizer` после
    /// загрузки (ADR-051, п. 4), а порядок проверки меняется вместе с ним.
    let rightsFor (relations: Set<MeetupRelation>) : Set<AccessRight> =
        relations
        |> Set.toList
        |> List.choose (fun relation ->
            match relation with
            | CommunityAdministrator -> Some ManageMeetups
            | AuctionRunner -> Some RunAuctions
            | Organizer -> None
        )
        |> Set.ofList

    /// Published meetups are community-visible. A hidden meetup is visible only
    /// to its author, to the people in its organizer roster and to a holder of
    /// manage_meetups (ADR-076, п. 9). The author keeps reading after leaving the
    /// roster, but cannot command the meetup. Lifecycle is deliberately not folded
    /// into this decision: held and cancelled meetups retain the visibility chosen
    /// on the independent visibility axis (ADR-022).
    let canView (viewer: Viewer) (snapshot: MeetupSnapshot) : bool =
        snapshot.Visibility = Visible
        || snapshot.Author = viewer.IdentityId
        || List.contains viewer.IdentityId snapshot.Organizers
        || Viewer.canManageMeetups viewer

    /// Выход из состава опирается на запись в составе, а не на право: потерявший
    /// `organize_meetups` выйти может. Смотрящий вне состава, который сходку читает,
    /// получает успех без события, прочие — тот же отказ, что у остальных команд.
    let mayLeave (viewer: Viewer) (snapshot: MeetupSnapshot option) : Result<unit, AccessDenied> =
        if Viewer.canManageMeetups viewer then
            Ok()
        else
            match snapshot with
            | Some snapshot when canView viewer snapshot -> Ok()
            | _ -> Error CannotActOnMeetup
