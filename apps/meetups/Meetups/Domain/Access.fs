namespace Meetups.Domain

/// Отклонённое право действовать. Отдельный тип, а не вариант DomainError: право не
/// является инвариантом перехода состояния, и в решении о нём состояние не участвует.
/// Транспортного словаря здесь тоже нет — PERMISSION_DENIED называет срез.
type AccessDenied = CannotManageMeetups

/// Отношение человека к сходке, которое вызывающий сервис принимает как право
/// действовать от её имени (ADR-051). Словарь принадлежит Meetups и растёт вместе с
/// доменом: автор и организатор войдут значениями вместе с продуктовым решением,
/// которое даст им право. Сегодня значение одно — администратор сообщества, и
/// держится оно на праве `manage_meetups`, а не на записи сходки.
type MeetupRelation = CommunityAdministrator

/// Политика доступа среза. Живёт в ядре, а не в срезах, потому что решение
/// принимается из значений и без I/O, а правило одно на все команды: четыре копии
/// предиката разошлись бы на первой же правке. Файл стоит до Domain/Meetup.fs
/// намеренно — политика не должна быть способна увидеть приватное представление
/// агрегата и читает состояние только снимком.
module Access =

    /// Право действовать от имени сходки для пишущих команд. Права смотрящего
    /// разрешил бот на этом же update (ADR-051, п. 7); другие сервисы задают тот же
    /// вопрос запросом CheckMeetupAuthority, и право для него Meetups спрашивает у
    /// Identity сам — через `rightsFor`, а не вторым предикатом.
    ///
    /// ADR-031: право принадлежит тому, кто ведёт сходки; автор отдельным правом не
    /// является, а организаторов конкретной сходки нет.
    ///
    /// Состояние сходки в решении не участвует, поэтому проверка стоит до загрузки:
    /// иначе ответ обычному смотрящему зависел бы от того, существует ли сходка, и
    /// отказ по праву стал бы способом узнать про чужой черновик.
    let actOnBehalf (viewer: Viewer) : Result<unit, AccessDenied> =
        if Viewer.canManageMeetups viewer then Ok() else Error CannotManageMeetups

    /// Права, которые дают принимаемые отношения. Правило то же, что у
    /// `actOnBehalf`: администратор сообщества — это держатель `manage_meetups`, и
    /// ничего больше. Отношение, которому понадобится запись сходки, сюда не впишется
    /// и изменит порядок проверки вместе с собой (ADR-051, п. 4).
    let rightsFor (relations: Set<MeetupRelation>) : Set<AccessRight> =
        relations
        |> Set.map (fun relation ->
            match relation with
            | CommunityAdministrator -> ManageMeetups
        )

    /// Published meetups are community-visible. A hidden meetup is visible only
    /// to its author (the organizer represented by the current slice) and to a
    /// holder of manage_meetups. Lifecycle is deliberately not folded into this
    /// decision: held and cancelled meetups retain the visibility chosen on the
    /// independent visibility axis (ADR-022).
    let canView (viewer: Viewer) (snapshot: MeetupSnapshot) : bool =
        snapshot.Visibility = Visible
        || snapshot.Author = viewer.IdentityId
        || Viewer.canManageMeetups viewer
