package auction.beacon

import auction.raffle.Beacon
import auction.raffle.Quicknet
import auction.raffle.Randomness
import com.fasterxml.jackson.databind.ObjectMapper
import com.typesafe.config.Config
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.HttpRequest
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.pattern.after

import java.net.URI
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration
import scala.jdk.DurationConverters.*
import scala.util.Try
import scala.util.control.NonFatal

/**
 * Зеркала drand и срок одного запроса (ADR-066, п. 7). Адреса — настройка: локальный контур и тесты подменяют маяк, не
 * меняя кода.
 */
final case class BeaconSettings(mirrors: List[URI], requestTimeout: FiniteDuration)

object BeaconSettings {

  /** Пустой список или адрес не `http(s)://host` — отказ старта: розыгрыш не смог бы пройти никогда. */
  def fromConfig(config: Config): Either[String, BeaconSettings] = {
    val section = "auction.raffle.beacon"
    // Повторённый адрес голосовал бы дважды и обходил согласие двух зеркал, поэтому считаются разные адреса.
    val raw =
      config.getString(s"$section.mirrors").split(',').map(_.trim.stripSuffix("/")).filter(_.nonEmpty).toList.distinct
    val parsed = raw.map(value =>
      Try(URI.create(value)).toOption.filter(uri => uri.getHost != null && Set("http", "https")(uri.getScheme))
    )
    if (raw.sizeIs < 2) Left("auction raffle beacon needs at least two distinct mirrors: AUCTION_RAFFLE_BEACON_URLS")
    else if (parsed.exists(_.isEmpty))
      Left("auction raffle beacon mirror is not an http(s) URL: AUCTION_RAFFLE_BEACON_URLS")
    else Right(BeaconSettings(parsed.flatten, config.getDuration(s"$section.request-timeout").toScala))
  }
}

/**
 * Маяк drand по HTTP: раунд спрашивается у всех зеркал сразу, и значение принимается, когда два из них вернули одно и
 * то же ([[Quicknet.agreed]]). Отказ, таймаут, раунд ещё не вышел (404, 425) или чужой ответ зеркала — его голос пуст.
 * Подпись раунда сервис не проверяет (ADR-066): согласие зеркал и проверка участником закрывают подмену на одном
 * зеркале.
 */
final class DrandBeacon(settings: BeaconSettings, fetch: URI => Future[Option[String]])(using ExecutionContext)
    extends Beacon {

  def randomness(round: Long): Future[Option[Randomness]] =
    Future
      .traverse(settings.mirrors) { mirror =>
        val uri = URI.create(s"${mirror.toString.stripSuffix("/")}/${Quicknet.ChainHash}/public/$round")
        fetch(uri).map(_.flatMap(DrandBeacon.reading(_, round))).recover { case NonFatal(_) => None }
      }
      .map(Quicknet.agreed)
}

object DrandBeacon {

  private val mapper = new ObjectMapper()

  /** Значение раунда из тела ответа: только если `round` совпал с запрошенным и `randomness` — 64 строчных hex. */
  def reading(body: String, round: Long): Option[Randomness] =
    Try(mapper.readTree(body)).toOption.flatMap { json =>
      val sameRound = Option(json.get("round")).exists(node => node.canConvertToLong && node.asLong == round)
      Option.when(sameRound)(json.get("randomness")).flatMap(Option(_)).filter(_.isTextual).flatMap { node =>
        Randomness.fromHex(node.asText)
      }
    }

  def apply(settings: BeaconSettings)(using system: ActorSystem[?]): DrandBeacon = {
    given ExecutionContext = system.executionContext
    val http = Http(system.classicSystem)
    val fetch: URI => Future[Option[String]] = uri =>
      http.singleRequest(HttpRequest(uri = uri.toString)).flatMap { response =>
        if (response.status == StatusCodes.OK)
          response.entity.toStrict(settings.requestTimeout).map(entity => Some(entity.data.utf8String))
        else {
          response.discardEntityBytes()
          Future.successful(None)
        }
      }
    // Зеркало, не ответившее в срок, — пустой голос: ожидание ответа одного зеркала не держит остальные.
    def bounded(uri: URI): Future[Option[String]] =
      Future.firstCompletedOf(
        List(fetch(uri), after(settings.requestTimeout, system.classicSystem.scheduler)(Future.successful(None)))
      )
    new DrandBeacon(settings, bounded)
  }
}
