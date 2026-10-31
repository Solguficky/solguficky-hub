package auction.screen

import auction.lot.AuctionId
import auction.naming.DisplayNameRules
import auction.naming.DisplayNameStore
import auction.watch.AuctionChanges
import org.apache.pekko.NotUsed
import org.apache.pekko.actor.ActorRef
import org.apache.pekko.actor.Status
import org.apache.pekko.stream.KillSwitches
import org.apache.pekko.stream.Materializer
import org.apache.pekko.stream.OverflowStrategy
import org.apache.pekko.stream.scaladsl.Flow
import org.apache.pekko.stream.scaladsl.Keep
import org.apache.pekko.stream.scaladsl.Sink
import org.apache.pekko.stream.scaladsl.Source

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Предел одновременных потоков экрана (ADR-040, дополнение 2026-10-19): ссылка открытая, и торги важнее табло. Место
 * занимает и подключение в воротах — от `reserve` до `release`, пока идёт вопрос Meetups, — и поток с материализации до
 * её конца: волна переподключений после рестарта иначе прошла бы ворота вся, пока ни один поток не открыт. Ворота
 * отдают место до того, как поток займёт своё, поэтому подключение, оборвавшееся до отправки ответа, места не держит;
 * превысить предел можно только в этом коротком промежутке без вызовов.
 */
final class StreamLimit(val max: Int) {
  private val taken = AtomicInteger(0)

  def current: Int = taken.get()

  /** Занять место на время ворот; `false` — предел достигнут, и место не занято. */
  def reserve(): Boolean =
    taken.incrementAndGet() <= max || {
      taken.decrementAndGet()
      false
    }

  def release(): Unit = taken.decrementAndGet(): Unit

  private[screen] def opened(): Unit = taken.incrementAndGet(): Unit
  private[screen] def closed(): Unit = release()
}

/**
 * Поток экрана зала: те же поводы, что у `WatchAuction` (ADR-061, дополнение 2026-10-11), и свежий снимок на каждый.
 * Снимок читается один раз на повод и аукцион, а не на каждый поток (PER-695): потоков бывает сотня, чтения идут через
 * пул журнала, и умноженное на потоки чтение отбирало его у ставок. Подписка на поводы регистрируется при
 * материализации общего потока, до первого чтения, поэтому коммит, пришедший во время чтения, даёт ещё одно сообщение.
 * Чтение идёт по одному поводу: медленный получает свежее состояние, а не очередь, и ставки не ждут ни его, ни поток.
 */
final class ScreenFeed(
    views: ScreenViews,
    names: DisplayNameStore,
    standings: MeetupStandings,
    changes: AuctionChanges,
    val limit: StreamLimit,
    predictions: ScreenPredictions = ScreenPredictions.none
)(using ExecutionContext, Materializer) {

  /** Снимки аукционов, общие для их потоков; ключ живёт, пока у аукциона есть хоть один подписчик. */
  private val feeds = ConcurrentHashMap[UUID, Feed]()

  /**
   * Регистрация подписчика идёт по одному: два первых потока одного аукциона не заводят два снимка. Своя блокировка, а
   * не `compute` карты: первый снимок материализует поток, а тот вправе закончиться и снять ключ прямо в этой операции.
   */
  private val registration = new Object

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
    subscribed(auctionId)
      .via(ScreenFeed.changed)
      .mapMaterializedValue { notUsed =>
        limit.opened()
        notUsed
      }
      .watchTermination() { (notUsed, done) =>
        done.onComplete(_ => limit.closed())(using ExecutionContext.parasitic)
        notUsed
      }

  /**
   * Поток одного подписчика: буфер на одно состояние с вытеснением прежнего, поэтому медленный видит свежее состояние,
   * а не очередь. Место в снимке аукциона занимается при материализации, до первого состояния, поэтому подписка
   * успевает раньше коммита.
   */
  private def subscribed(auctionId: UUID): Source[String, NotUsed] =
    Source
      .actorRef[String](1, OverflowStrategy.dropHead)
      .mapMaterializedValue { subscriber =>
        join(auctionId, subscriber)
        subscriber
      }
      .watchTermination() { (subscriber, done) =>
        done.onComplete(_ => leave(auctionId, subscriber))(using ExecutionContext.parasitic)
        NotUsed
      }

  /** Подписчик встаёт в общий снимок аукциона; первый поток аукциона заводит и сам снимок. */
  private def join(auctionId: UUID, subscriber: ActorRef): Unit = registration.synchronized {
    val feed = Option(feeds.get(auctionId)).getOrElse {
      val started = new Feed(auctionId)
      feeds.put(auctionId, started)
      started
    }
    feed.join(subscriber)
    // Снимок, закончившийся до этой записи, снял бы ключ, но ключа ещё не было: иначе он остался бы в карте навсегда.
    if (feed.finished) feeds.remove(auctionId, feed)
  }

  /** Отписка последнего потока снимает аукцион с поводов: иначе его снимок читался бы вечно. */
  private def leave(auctionId: UUID, subscriber: ActorRef): Unit = registration.synchronized {
    val feed = feeds.get(auctionId)
    if (feed != null) {
      feed.leave(subscriber)
      if (feed.isEmpty) {
        feed.close()
        feeds.remove(auctionId, feed)
      }
    }
  }

  private def snapshot(auctionId: UUID): Future[Option[String]] =
    views.read(auctionId).flatMap {
      case None => Future.successful(None)
      case Some(reading) =>
        names.find(AuctionId(auctionId), reading.participants).flatMap { found =>
          val name = (participant: auction.lot.ParticipantId) =>
            DisplayNameRules.render(participant, found.get(participant).map(_.name)).text
          Screen.of(reading, name) match {
            // Итоги прогнозов есть только у завершённого аукциона (ADR-067, п. 4): отменённый их не получает.
            case finished: ScreenState.Finished =>
              predictions.read(auctionId).map(found => Some(ScreenJson.render(auctionId, finished, found)))
            case state => Future.successful(Some(ScreenJson.render(auctionId, state)))
          }
        }
    }

  /**
   * Снимки одного аукциона, общие для его потоков: один повод — одно чтение, сколько бы потоков ни смотрело. Последний
   * ушедший поток закрывает чтение; аукцион, пропавший из read model, закрывает все потоки аукциона — как раньше
   * закрывался каждый по отдельности.
   */
  private final class Feed(auctionId: UUID) {
    private val last = AtomicReference(Option.empty[String])
    private val subscribers = ConcurrentHashMap.newKeySet[ActorRef]()
    private val ended = AtomicBoolean(false)

    private val (stopper, done) = changes
      .subscribe(auctionId)
      .mapAsync(1)(_ => snapshot(auctionId))
      .takeWhile(_.isDefined)
      .collect { case Some(json) => json }
      .viaMat(KillSwitches.single)(Keep.right)
      .toMat(Sink.foreach(publish))(Keep.both)
      .run()

    done.onComplete(_ => finish())(using ExecutionContext.parasitic)

    /** Подписка и первое состояние — под одной блокировкой с раздачей: подписчик не увидит повод раньше прежнего. */
    def join(subscriber: ActorRef): Unit = synchronized {
      if (ended.get()) subscriber ! Status.Success(())
      else {
        subscribers.add(subscriber)
        last.get().foreach(value => subscriber ! value)
      }
    }

    def leave(subscriber: ActorRef): Unit = synchronized(subscribers.remove(subscriber): Unit)

    def isEmpty: Boolean = synchronized(subscribers.isEmpty)

    /** Снимок уже закончился: такой ключ карта держать не должна. */
    def finished: Boolean = ended.get()

    def close(): Unit =
      if (ended.compareAndSet(false, true)) {
        stopper.shutdown()
        completeAll()
      }

    private def publish(value: String): Unit = synchronized {
      last.set(Some(value))
      subscribers.forEach(subscriber => subscriber ! value)
    }

    /**
     * Конец чтения — свой или по пропаже аукциона: потоки аукциона заканчиваются, и снимок перестаёт быть нужен. Ключ
     * снимается до завершения потоков: иначе подписка, пришедшая следом, заняла бы уже законченный общий поток.
     */
    private def finish(): Unit =
      if (ended.compareAndSet(false, true)) {
        feeds.remove(auctionId, this)
        completeAll()
      }

    private def completeAll(): Unit = synchronized {
      subscribers.forEach(_ ! Status.Success(()))
      subscribers.clear()
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
