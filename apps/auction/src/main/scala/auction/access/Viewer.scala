package auction.access

/**
 * Права Identity — то, что человеку можно, а не круг, в котором он состоит, и не набор, которым право выдано (ADR-064,
 * RFC-016).
 *
 * Доменная копия `identity.v1.AccessRight`: сгенерированный тип в домен не проходит. Права, которых сервис не знает,
 * отображение на границе отбрасывает: по контракту неизвестное право ничего не даёт.
 */
enum AccessRight {
  case AccessHub
  case PlaceBids
  case ManageMembers
  case AdmitBidders
  case ManageMeetups
  case GrantAdmins
}

/**
 * Смотрящий: тот, от чьего имени пришла операция, с правами, которые поверхность разрешила у Identity на этом же
 * действии (ADR-064). Решение о праве по ним принимает Auction как владелец ресурса; круг и наборы Auction не читает.
 */
final case class Viewer(rights: Set[AccessRight]) {

  /** Ведущий каталога лотов: каталог общий на все аукционы и входит в право вести сходки (RFC-016, О-1). */
  def managesLotCatalog: Boolean = rights.contains(AccessRight.ManageMeetups)

  /**
   * Участник торгов: право ставить. Его держат гость по допуску и участник сообщества по кругу, поэтому отдельного
   * разворота кругов здесь нет.
   */
  def isParticipant: Boolean = rights.contains(AccessRight.PlaceBids)
}
