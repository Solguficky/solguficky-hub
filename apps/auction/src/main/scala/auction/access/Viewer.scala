package auction.access

/**
 * Права Identity — то, что человеку можно, а не круг, в котором он состоит (ADR-064, пункт 7).
 *
 * Доменная копия `identity.v1.AccessRight`: сгенерированный тип в домен не проходит. Права, которых сервис не знает,
 * отображение на границе отбрасывает: по контракту неизвестное право ничего не даёт.
 */
enum AccessRight {
  case Hub
  case Auction
  case ManageMembership
  case ModerateAuction
  case ManageAuction
}

/**
 * Смотрящий: тот, от чьего имени пришла операция, с правами, которые поверхность разрешила у Identity на этом же
 * действии (ADR-064). Решение о праве по ним принимает Auction как владелец ресурса; роль-круг Auction не читает.
 */
final case class Viewer(rights: Set[AccessRight]) {

  /** Администратор аукциона: каталог лотов. Право приходит с кругом `admin` (PER-528). */
  def isAuctionAdministrator: Boolean = rights.contains(AccessRight.ManageAuction)

  /**
   * Участник торгов: право аукциона. Его держат гость по допуску, участник сообщества и администратор по кругу, поэтому
   * отдельного разворота кругов здесь нет.
   */
  def isParticipant: Boolean = rights.contains(AccessRight.Auction)
}
