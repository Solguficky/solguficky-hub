package auction.naming

import auction.lot.AuctionId
import auction.lot.ParticipantId

import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Хранилище выбранных имён. Реализация живёт в `persistence`; здесь только то, что нужно командам.
 *
 * Выбор — строка состояния, а не журнал: последняя запись до заморозки побеждает, истории нет.
 */
trait DisplayNameStore {

  /** Записывает выбор участника, пока его имя в аукционе не заморожено. */
  def choose(auction: AuctionId, participant: ParticipantId, name: ChosenName): Future[ChooseResult]

  /** Замораживает выбор. `false` — выбора нет. Повтор заморозки — не ошибка. */
  def freeze(auction: AuctionId, participant: ParticipantId): Future[Boolean]

  /** Выборы названных участников; участника без выбора в ответе нет. */
  def find(auction: AuctionId, participants: Set[ParticipantId]): Future[Map[ParticipantId, ChosenName]]
}

enum ChooseResult {
  case Written

  /** Имя заморожено, выбор не записан; `current` — то, что осталось. */
  case Frozen(current: ChosenName)

  /** Псевдоним держит другой участник этого аукциона. */
  case AliasTaken
}

/**
 * Команды имени участника. К хранилищу выбор идёт только после того, как решение вернуло `Right`: отказ по нику и по
 * псевдониму наступает до обращения к базе по построению.
 *
 * gRPC-граница их пока не зовёт: `ChooseDisplayName`, `GetDisplayNames`, проверку имени перед ставкой и заморозку после
 * принятой ставки подключает PER-434.
 */
final class DisplayNameCommands(store: DisplayNameStore)(using ExecutionContext) {

  def choose(
      auction: AuctionId,
      participant: ParticipantId,
      choice: NameChoice
  ): Future[Either[NamingRefusal, DisplayName]] =
    DisplayNameRules.decide(choice) match {
      case Left(refusal) => Future.successful(Left(refusal))
      case Right(name) =>
        store.choose(auction, participant, name).map {
          case ChooseResult.Written => Right(DisplayNameRules.render(participant, Some(name)))
          // Повтор того же выбора после заморозки — повтор команды, а не попытка сменить имя.
          case ChooseResult.Frozen(current) if current == name =>
            Right(DisplayNameRules.render(participant, Some(name)))
          case ChooseResult.Frozen(_) => Left(NamingRefusal.NameFrozen)
          case ChooseResult.AliasTaken => Left(NamingRefusal.AliasTaken)
        }
    }

  /** Имя для каждого названного участника: без выбора — заглушка, пустым имя не бывает. */
  def names(auction: AuctionId, participants: Set[ParticipantId]): Future[Map[ParticipantId, DisplayName]] =
    if (participants.isEmpty) Future.successful(Map.empty)
    else
      store.find(auction, participants).map { chosen =>
        participants.iterator
          .map(participant => participant -> DisplayNameRules.render(participant, chosen.get(participant)))
          .toMap
      }

  /** Проверка перед ставкой и прокси-лимитом: без выбранного имени участник в аукционе не ставит. */
  def requireChosen(auction: AuctionId, participant: ParticipantId): Future[Either[NameNotChosen.type, ChosenName]] =
    store.find(auction, Set(participant)).map(chosen => DisplayNameRules.requireChosen(chosen.get(participant)))

  /**
   * Вызывается после того, как лот принял ставку или прокси-лимит участника. Между принятием и заморозкой общей
   * транзакции нет, пока нет агрегата аукциона: выбор, записанный в этом окне, останется (ADR-059).
   */
  def participated(auction: AuctionId, participant: ParticipantId): Future[Boolean] =
    store.freeze(auction, participant)
}
