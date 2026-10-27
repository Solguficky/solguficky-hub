package auction.raffle

import auction.lot.AuctionId
import auction.lot.ParticipantId

import java.time.Clock
import java.time.Instant
import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration
import scala.util.control.NonFatal

/**
 * Значение раунда маяка drand (ADR-066, п. 7). `None` — значения пока нет или зеркала не договорились: жеребьёвка ждёт
 * и спрашивает снова, запасного пути нет (п. 10).
 */
trait Beacon {
  def randomness(round: Long): Future[Option[Randomness]]
}

/**
 * Держит ли человек право `place_bids` сейчас (ADR-066, п. 4): заблокированный права не держит. Неудачное `Future` —
 * ответа нет: Identity недоступна или не ответила в срок.
 */
trait RaffleAccess {
  def holdsRight(participant: ParticipantId): Future[Boolean]
}

object RaffleAccess {

  /** Без адреса Identity права при закрытии подтвердить нечем: каждый ответ — «нет ответа», и пул не сужается. */
  val absent: RaffleAccess = _ => Future.failed(new IllegalStateException("identity address is not configured"))
}

/**
 * Снимок «номер — имя» (ADR-066, п. 12): строка состояния, а не журнал, потому что имена стираются через срок хранения.
 */
trait RaffleTickets {

  /**
   * Записывает имена билетов 1…N так, как их показывает хронология ставок. Повтор не перезаписывает записанное: снимок
   * сделан один раз, при фиксации пула.
   */
  def record(auction: AuctionId, tickets: Vector[ParticipantId]): Future[Unit]

  /** Имена по номерам; номера, чьё имя стёрто, в ответе нет. */
  def names(auction: AuctionId): Future[Map[Int, String]]

  /** Назначает стирание имён снимка на момент `at`; назначенное раньше не сдвигается. */
  def expireAt(auction: AuctionId, at: Instant): Future[Unit]
}

/** Байты фото приза, проверенные границей тем же правилом, что фото лота: тип — IANA, версия — SHA-256 байтов. */
final case class PrizePhotoBytes(content: IArray[Byte], mediaType: String, version: String)

/**
 * Байты фото приза (PER-772): строка состояния рядом с журналом, как фото лота, а не журнал — байты в журнал не
 * пишутся. Какое фото у приза сейчас, решает журнал розыгрыша; строка только держит байты под id фото.
 */
trait RafflePrizePhotos {

  /**
   * Записывает байты под id фото с моментом записи `at`. `false` — под этим id уже лежат другие байты; те же байты —
   * `true` без второй строки.
   */
  def store(auction: AuctionId, photoId: UUID, photo: PrizePhotoBytes, at: Instant): Future[Boolean]

  def read(auction: AuctionId, photoId: UUID): Future[Option[PrizePhotoBytes]]

  /**
   * Удаляет байты фото аукциона, записанные раньше `before`, кроме `keep`: так принятая замена или снятие убирает
   * прежние байты, а байты параллельной команды, записанные позже, остаются.
   */
  def discard(auction: AuctionId, keep: Option[UUID], before: Instant): Future[Unit]
}

object RafflePrizePhotos {

  /** Без хранилища фото приза нет: запись отвечает сбоем, чтение — пусто. */
  val absent: RafflePrizePhotos = new RafflePrizePhotos {
    def store(auction: AuctionId, photoId: UUID, photo: PrizePhotoBytes, at: Instant): Future[Boolean] =
      Future.failed(new IllegalStateException("raffle prize photos are not configured"))

    def read(auction: AuctionId, photoId: UUID): Future[Option[PrizePhotoBytes]] = Future.successful(None)

    def discard(auction: AuctionId, keep: Option[UUID], before: Instant): Future[Unit] = Future.unit
  }
}

/**
 * Проверка права кандидатов при закрытии. Каждый кандидат спрашивается, пока не придёт ответ или пока не наступит
 * `until`; неотвеченный — `None`, и [[Raffle.excluded]] оставляет его в пуле. `until` лежит до времени раунда
 * жеребьёвки: решение о пуле после выхода маяка давало бы выбрать исход.
 */
object PoolScreening {

  def screen(
      candidates: Vector[ParticipantId],
      access: RaffleAccess,
      until: Instant,
      clock: Clock,
      retryEvery: FiniteDuration,
      delay: FiniteDuration => Future[Unit]
  )(using ExecutionContext): Future[Map[ParticipantId, Option[Boolean]]] = {
    def attempt(participant: ParticipantId): Future[Option[Boolean]] =
      if (!clock.instant().isBefore(until)) Future.successful(None)
      else
        Future
          .delegate(access.holdsRight(participant))
          .map(Option(_))
          .recoverWith { case NonFatal(_) =>
            if (clock.instant().plusNanos(retryEvery.toNanos).isBefore(until))
              delay(retryEvery).flatMap(_ => attempt(participant))
            else Future.successful(None)
          }
    Future.traverse(candidates)(participant => attempt(participant).map(participant -> _)).map(_.toMap)
  }
}
