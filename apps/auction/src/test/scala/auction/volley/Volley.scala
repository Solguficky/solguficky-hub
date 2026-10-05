package auction.volley

import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction_service as wire
import identity.v1.roles.GlobalRole as GlobalRoleMessage
import io.grpc.Status
import io.grpc.StatusRuntimeException
import org.apache.pekko.stream.Materializer
import org.apache.pekko.stream.scaladsl.Sink
import org.apache.pekko.stream.scaladsl.Source

import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.util.Random
import scala.util.control.NonFatal

/** Команда залпа — ставка или прокси-лимит одного участника лоту. Суммы — минорные единицы, `Long`: плавающей нет. */
enum Shot {
  case Bid(participant: UUID, lot: UUID, amount: Long, opId: UUID)
  case Limit(participant: UUID, lot: UUID, max: Long, opId: UUID)

  def participant: UUID
  def lot: UUID
  def opId: UUID
}

/**
 * Исход одной команды залпа, как его увидел вызывающий. `Accepted` у ставки несёт `bid_id`, у лимита — ничего. `Failed`
 * — ответ статусом, а не значением: посреди убийства процесса это «ответа нет», и команда могла быть записана, а могла
 * не быть. `NotSent` — команда не ушла: залп остановили раньше.
 */
enum Outcome {
  case Accepted(bidId: Option[String])
  case Refused(reason: String)
  case Failed(code: Status.Code)
  case NotSent
}

final case class Fired(shot: Shot, outcome: Outcome)

/**
 * Генератор конкурентных ставок и прокси-лимитов (PER-332): детерминированный план и исполнитель поверх gRPC-клиента
 * `AuctionService`. От тестового стенда он не зависит: клиент, токен вызывающего и лот приходят снаружи, поэтому тот же
 * генератор годится и против развёрнутого сервиса (драй-ран PER-312 допишет точку входа с адресом и токеном).
 *
 * Участники и `op_id` выводятся из `seed`: тот же `seed` даёт тот же залп байт в байт, и повтор залпа — это его второй
 * запуск, а не отдельный режим.
 */
object Volley {

  /**
   * UUIDv7 из генератора: время — миллисекунды `epochMillis`, остальное — случайные биты `random`. Форма каноническая,
   * какую граница принимает в `identity_id` и `op_id`; уникальность держат 74 случайных бита.
   */
  def uuidV7(random: Random, epochMillis: Long): UUID = {
    val msb = (epochMillis << 16) | 0x7000L | (random.nextLong() & 0x0fffL)
    val lsb = (random.nextLong() & 0x3fffffffffffffffL) | Long.MinValue
    new UUID(msb, lsb)
  }

  /**
   * Залп по одному лоту: `bidders` ручных ставок и `proxies` прокси-лимитов. У каждого участника одна команда. Поэтому
   * именованный отказ залпа необратим: цена только растёт, и ставка или лимит ниже порога не станут выше него на
   * повторе; отказа «вы уже лидер» нет — второй ставки у участника нет. Повтор залпа, где каждая команда уже получила
   * ответ, поэтому ничего не пишет.
   *
   * Ставки идут по возрастанию через три шага: так следующая ставка перебивает и предыдущую, и производную ставку
   * прокси на шаг выше неё, и большая часть залпа принимается, а гонку дают одновременные команды, а не план. Лимит
   * вставлен в случайное место плана, и его максимум — от одного до двенадцати шагов над ставкой на этом месте: прокси
   * перебивает несколько следующих ставок и исчерпывается. Максимум далеко выше плана сразу поднял бы цену войной двух
   * прокси над всеми оставшимися ставками, и залп выродился бы в отказы.
   */
  def mixed(seed: Long, lot: UUID, start: Long, step: Long, bidders: Int, proxies: Int): Vector[Shot] = {
    val random = Random(seed)
    val at = 1_700_000_000_000L + (seed & 0xffffffL)
    val bids = Vector.tabulate[Shot](bidders) { i =>
      Shot.Bid(uuidV7(random, at), lot, start + 3 * step * (i + 1), uuidV7(random, at))
    }
    (1 to proxies).foldLeft(bids) { (plan, _) =>
      val (before, after) = plan.splitAt(random.nextInt(plan.size + 1))
      val near = before.reverseIterator.collectFirst { case Shot.Bid(_, _, amount, _) => amount }.getOrElse(start)
      val limit = Shot.Limit(uuidV7(random, at), lot, near + step * (1 + random.nextInt(12)), uuidV7(random, at))
      (before :+ limit) ++ after
    }
  }

  /** Залп равными суммами: `bidders` участников ставят одну и ту же `amount` (P-18). */
  def equal(seed: Long, lot: UUID, amount: Long, bidders: Int): Vector[Shot] = {
    val random = Random(seed)
    val at = 1_700_000_000_000L + (seed & 0xffffffL)
    Vector.fill(bidders)(Shot.Bid(uuidV7(random, at), lot, amount, uuidV7(random, at)))
  }

  /** Смотрящий-участник: ставить может только роль `public` (ADR-044). */
  def viewer(participant: UUID): wire.Viewer =
    wire.Viewer(participant.toString, Seq(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC))
}

/**
 * Исполнитель залпа: до `parallelism` команд одновременно; срок вызова задают настройки клиента. `observe` видит исход
 * каждой команды по мере ответа вместе с числом принятых к этому моменту и может остановить залп через `stop` — так
 * тест убивает процесс посреди залпа, пока остальные команды ещё в полёте. Порядок ответов не детерминирован, состав —
 * да.
 */
final class VolleyRunner(client: wire.AuctionServiceClient, token: String, currency: String)(using
    materializer: Materializer,
    ec: ExecutionContext
) {

  private val stopped = AtomicBoolean(false)

  /** После `stop` новые команды не уходят и получают `NotSent`; ушедшие доживают до ответа или сбоя. */
  def stop(): Unit = stopped.set(true)

  def fire(shots: Seq[Shot], parallelism: Int)(observe: (Fired, Int) => Unit = (_, _) => ()): Future[Vector[Fired]] = {
    var accepted = 0
    Source(shots.toVector)
      .mapAsyncUnordered(parallelism)(shot =>
        if (stopped.get) Future.successful(Fired(shot, Outcome.NotSent)) else send(shot)
      )
      .map { fired =>
        if (fired.outcome.isInstanceOf[Outcome.Accepted]) accepted += 1
        observe(fired, accepted)
        fired
      }
      .runWith(Sink.collection[Fired, Vector[Fired]])
  }

  private def send(shot: Shot): Future[Fired] = {
    val sent = shot match {
      case Shot.Bid(participant, lot, amount, opId) =>
        authorized(client.placeBid())
          .invoke(
            wire.PlaceBidRequest(
              Some(Volley.viewer(participant)),
              lot.toString,
              Some(MoneyMessage(amount, currency)),
              opId.toString
            )
          )
          .map(response =>
            response.outcome match {
              case wire.PlaceBidResponse.Outcome.Accepted(bid) => Outcome.Accepted(Some(bid.bidId))
              case wire.PlaceBidResponse.Outcome.Refused(refusal) => Outcome.Refused(name(refusal.reason))
              case wire.PlaceBidResponse.Outcome.Empty => Outcome.Refused("Empty")
            }
          )
      case Shot.Limit(participant, lot, max, opId) =>
        authorized(client.setProxyLimit())
          .invoke(
            wire.SetProxyLimitRequest(
              Some(Volley.viewer(participant)),
              lot.toString,
              Some(MoneyMessage(max, currency)),
              opId.toString
            )
          )
          .map(response =>
            response.outcome match {
              case wire.SetProxyLimitResponse.Outcome.Accepted(_) => Outcome.Accepted(None)
              case wire.SetProxyLimitResponse.Outcome.Refused(refusal) => Outcome.Refused(name(refusal.reason))
              case wire.SetProxyLimitResponse.Outcome.Empty => Outcome.Refused("Empty")
            }
          )
    }
    sent
      .recover {
        case failure: StatusRuntimeException => Outcome.Failed(failure.getStatus.getCode)
        case NonFatal(_) => Outcome.Failed(Status.Code.UNKNOWN)
      }
      .map(Fired(shot, _))
  }

  private def authorized[Req, Res](
      builder: org.apache.pekko.grpc.scaladsl.SingleResponseRequestBuilder[Req, Res]
  ): org.apache.pekko.grpc.scaladsl.SingleResponseRequestBuilder[Req, Res] =
    builder.addHeader("authorization", s"Bearer $token")

  /** Имя варианта отказа, как в контракте: `BidBelowMinimum`, `ProxyBelowCurrentPrice`. */
  private def name(reason: scalapb.GeneratedOneof): String = reason.value match {
    case message: scalapb.GeneratedMessage => message.companion.scalaDescriptor.name
    case other => other.getClass.getSimpleName
  }
}
