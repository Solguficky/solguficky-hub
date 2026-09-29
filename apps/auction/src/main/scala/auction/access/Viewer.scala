package auction.access

/**
 * Глобальные роли Identity — круги сообщества (ADR-043), а не права на операции.
 *
 * Доменная копия `identity.v1.GlobalRole`: сгенерированный тип в домен не проходит, а значение, которого сервис не
 * знает, отображение на границе обязано отвергнуть, а не превратить в одну из этих ролей.
 */
enum GlobalRole {
  case Admin
  case Maintainer
  case Member
  case Public
}

/**
 * Смотрящий: тот, от чьего имени пришла операция, с ролями, которые поверхность разрешила у Identity на этом же
 * действии (ADR-044). Решение о праве по ним принимает Auction как владелец ресурса.
 */
final case class Viewer(globalRoles: Set[GlobalRole]) {

  /**
   * Администратор сходки. Отдельной роли организатора в MVP нет, и администратор сходки — это глобальный `admin`
   * (ADR-043). Круги вложены вниз, а не вверх: `maintainer` в круг `admin` не входит.
   */
  def isMeetupAdministrator: Boolean = globalRoles.contains(GlobalRole.Admin)
}
