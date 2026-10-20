package auction.screen

import auction.lot.AuctionId
import auction.naming.DisplayNameRules
import auction.naming.DisplayNameStore
import auction.watch.AuctionChanges
import org.apache.pekko.NotUsed
import org.apache.pekko.stream.scaladsl.Flow
import org.apache.pekko.stream.scaladsl.Source

import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Предел одновременных потоков экрана (ADR-040, дополнение 2026-10-19): ссылка открытая, и торги важнее табло. Поток
 * считается открытым с материализации и до её конца, поэтому подключение, оборвавшееся до отправки ответа, места не
 * занимает. Проверка «есть ли место» и счёт не атомарны вместе: одновременные подключения могут превысить предел на
 * своё число, и это дешевле, чем место, потерянное навсегда.
 */
final class StreamLimit(val max: Int) {
  private val open = AtomicInteger(0)

  def full: Boolean = open.get() >= max
  def current: Int = open.get()

  private[screen] def opened(): Unit = open.incrementAndGet(): Unit
  private[screen] def closed(): Unit = open.decrementAndGet(): Unit
}

/**
 * Поток экрана зала: те же поводы, что у `WatchAuction` (ADR-061, дополнение 2026-10-11), и свежий снимок на каждый.
 * Подписка регистрируется при материализации, до первого чтения, поэтому коммит, пришедший во время чтения, даёт ещё
 * одно сообщение. Чтение идёт по одному и только по спросу клиента: медленный получает свежее состояние, а не очередь,
 * и ставки не ждут ни его, ни поток.
 */
final class ScreenFeed(
    views: ScreenViews,
    names: DisplayNameStore,
    standings: MeetupStandings,
    changes: AuctionChanges,
    val limit: StreamLimit
)(using ExecutionContext) {

  /** Ворота страницы и изображения: аукцион в read model и состояние его сходки у Meetups. */
  def admit(auctionId: UUID): Future[Admission] =
    views.read(auctionId).flatMap {
      case None => Future.successful(Admission.NotFound)
      case Some(reading) => standings.standing(reading.meetupId).map(Screen.admit(reading.auction, _))
    }

  /**
   * JSON состояний экрана. Аукцион, пропавший из read model (удалён до торгов), заканчивает поток. Завершённый и
   * отменённый — нет: страница остаётся на итоге, а переподключение по закрытию гоняло бы её по кругу.
   */
  def states(auctionId: UUID): Source[String, NotUsed] =
    changes
      .subscribe(auctionId)
      .mapAsync(1)(_ => snapshot(auctionId))
      .takeWhile(_.isDefined)
      .collect { case Some(json) => json }
      .via(ScreenFeed.changed)
      .mapMaterializedValue { notUsed =>
        limit.opened()
        notUsed
      }
      .watchTermination() { (notUsed, done) =>
        done.onComplete(_ => limit.closed())(using ExecutionContext.parasitic)
        notUsed
      }

  private def snapshot(auctionId: UUID): Future[Option[String]] =
    views.read(auctionId).flatMap {
      case None => Future.successful(None)
      case Some(reading) =>
        names.find(AuctionId(auctionId), reading.participants).map { found =>
          val name = (participant: auction.lot.ParticipantId) =>
            DisplayNameRules.render(participant, found.get(participant).map(_.name)).text
          Some(ScreenJson.render(auctionId, Screen.of(reading, name)))
        }
    }
}

object ScreenFeed {

  /** Сообщение проходит, только если отличается от предыдущего отправленного. */
  private val changed: Flow[String, String, NotUsed] =
    Flow[String]
      .statefulMap(() => Option.empty[String])(
        (last, next) => if (last.contains(next)) (last, None) else (Some(next), Some(next)),
        _ => None
      )
      .collect { case Some(next) => next }
}
