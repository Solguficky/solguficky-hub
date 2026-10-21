package auction.projection

import auction.aggregate.Auction
import auction.aggregate.AuctionConfig
import auction.catalog.LotId
import auction.entity.LotJournal
import auction.entity.LotTags
import auction.entity.StoredLotEvent
import auction.invoice.InvoiceId
import auction.invoice.InvoiceTerms
import auction.lot.AuctionId
import auction.lot.LotEvent
import auction.telemetry.ProjectionMetrics
import org.apache.pekko.Done
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.cluster.sharding.typed.ShardedDaemonProcessSettings
import org.apache.pekko.cluster.sharding.typed.scaladsl.ShardedDaemonProcess
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import org.apache.pekko.persistence.jdbc.query.scaladsl.JdbcReadJournal
import org.apache.pekko.persistence.query.Offset
import org.apache.pekko.persistence.typed.PersistenceId
import org.apache.pekko.projection.ProjectionBehavior
import org.apache.pekko.projection.ProjectionId
import org.apache.pekko.projection.eventsourced.EventEnvelope
import org.apache.pekko.projection.eventsourced.scaladsl.EventSourcedProvider
import org.apache.pekko.projection.jdbc.scaladsl.JdbcProjection
import org.apache.pekko.projection.scaladsl.AtLeastOnceProjection
import org.apache.pekko.projection.scaladsl.Handler

import java.time.Duration
import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Выставление счетов по продажам (PER-338): по экземпляру на тег журнала лотов [[LotTags]] под `ShardedDaemonProcess`,
 * своё имя [[Name]] и свой offset. В отличие от read model, эффект обработчика — команда entity счёта, которая в
 * транзакцию offset не входит, поэтому проекция — `JdbcProjection.atLeastOnceAsync` (ADR-045: побочный эффект вне
 * транзакции — at-least-once со стабильным id и идемпотентным получателем). Offset сохраняется после ответа entity на
 * каждое событие: упавшая или неответившая команда роняет обработчик, и проекция повторяет событие после рестарта с
 * backoff, а повтор приходит в тот же счёт и второго события не пишет. Стоящий тег виден метрикой `events_behind`.
 */
object InvoicingProjection {

  val Name: String = "lot-invoicing"

  type Envelope = EventEnvelope[StoredLotEvent]

  def init(system: ActorSystem[?], metrics: ProjectionMetrics, handler: () => Handler[Envelope]): Unit =
    ShardedDaemonProcess(system).init[ProjectionBehavior.Command](
      Name,
      LotTags.Count,
      index => ProjectionBehavior(projection(system, LotTags.all(index), metrics, handler)),
      ShardedDaemonProcessSettings(system),
      Some(ProjectionBehavior.Stop)
    )

  def projection(
      system: ActorSystem[?],
      tag: String,
      metrics: ProjectionMetrics,
      handler: () => Handler[Envelope]
  ): AtLeastOnceProjection[Offset, Envelope] = {
    val source = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    JdbcProjection
      .atLeastOnceAsync(
        ProjectionId(Name, tag),
        EventSourcedProvider.eventsByTag[StoredLotEvent](system, JdbcReadJournal.Identifier, tag),
        () => new PooledJdbcSession(source.source),
        handler
      )(using system)
      .withSaveOffset(1, scala.concurrent.duration.Duration.Zero)
      .withStatusObserver(metrics.observer[Envelope](_.timestamp))
  }

  def backlog(system: ActorSystem[?], timeout: FiniteDuration): () => Map[String, Long] =
    LotProjection.backlog(system, Name, timeout)
}

/**
 * Обработчик выставления: на `LotSold` — счёт с суммой, равной цене продажи, и сроком оплаты из конфигурации аукциона
 * лота, на остальные события — ничего. Оба входа — порты: срок оплаты отдаёт entity аукциона, а не read model (та
 * отстаёт), счёт выставляет шлюз entity счёта.
 *
 * @param paymentTerm
 *   срок оплаты аукциона сходки по его конфигурации; неудачное `Future` — ответа нет, и событие повторится
 * @param issue
 *   выставление счёта; идемпотентно по id счёта
 */
final class InvoicingHandler(
    paymentTerm: AuctionId => Future[Duration],
    issue: (InvoiceId, InvoiceTerms) => Future[Done]
)(using ExecutionContext)
    extends Handler[EventEnvelope[StoredLotEvent]] {

  override def process(envelope: EventEnvelope[StoredLotEvent]): Future[Done] =
    InvoicingHandler.sale(envelope) match {
      case None => Future.successful(Done)
      case Some((invoice, auction, sale)) =>
        termOf(auction).flatMap(term => issue(invoice, sale(term)))
    }

  /**
   * Тестовый аукцион из настройки бота — UUIDv7 без журнала аукциона (`AuctionGrpcService.isMeetupAuction`): срока у
   * него нет, и счёт получает срок платформы, а entity аукциона по чужому id не будится.
   */
  private def termOf(auction: AuctionId): Future[Duration] =
    if (auction.value.version == 5) paymentTerm(auction)
    else Future.successful(AuctionConfig.PlatformPaymentTerm)
}

object InvoicingHandler {

  /**
   * Продажа в конверте: id счёта, аукцион лота и условия счёта без срока оплаты. Строка лота без аукциона в продаже —
   * испорченный журнал: продаётся только открытый лот, а открывает его аукцион.
   */
  def sale(envelope: EventEnvelope[StoredLotEvent]): Option[(InvoiceId, AuctionId, Duration => InvoiceTerms)] = {
    val stored = envelope.event
    LotJournal.envelope(envelope.sequenceNr, stored).event match {
      case LotEvent.LotSold(winner, price, bidId, at) =>
        val lot = LotId(UUID.fromString(PersistenceId.extractEntityId(envelope.persistenceId)))
        val auction = stored.auctionId
          .map(AuctionId(_))
          .getOrElse(throw new IllegalStateException(s"${envelope.persistenceId} sold without an auction"))
        Some((InvoiceId.of(bidId), auction, InvoiceTerms.ofSale(auction, lot, winner, price, at, _)))
      case _ => None
    }
  }

  /** Срок оплаты по конфигурации аукциона, который открыл торги: продажа без старта торгов — дефект, а не умолчание. */
  def termOf(auction: Auction): Duration =
    auction.state.started
      .map(_._1.paymentTerm)
      .getOrElse(throw new IllegalStateException("lot sold in an auction that never started trading"))
}
