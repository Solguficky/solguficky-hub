package auction.entity

import auction.lot.*
import auction.lot.LotFixtures.*
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.typesafe.config.Config
import com.typesafe.config.ConfigFactory
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.serialization.SerializationExtension
import org.apache.pekko.serialization.SerializerWithStringManifest

import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import scala.jdk.CollectionConverters.*

/** Образцы модели хранения и сериализация строк журнала той конфигурацией, с которой стартует сервис. */
object JournalFixtures {

  /** Конфигурация сервиса без кластера: L0 проверяет сериализацию и поведение, а не узел. */
  val localConfig: Config =
    ConfigFactory.parseString("pekko.actor.provider = local").withFallback(ConfigFactory.load())

  val decidedAt: Instant = Instant.parse("2026-10-01T09:00:00Z")

  val clock: Clock = Clock.fixed(decidedAt, ZoneOffset.UTC)

  def uuid(n: Int): UUID = new UUID(0x0190f2a000007000L, 0x8000000000000000L | n.toLong)

  /** Идентификаторы по порядку: какой из них получит событие, транзакция или ставка, видно по номеру. */
  def sequentialIds(): () => UUID = {
    val next = new AtomicLong(0)
    () => uuid(next.incrementAndGet().toInt)
  }

  val tieredConfig: LotConfig = config(policy = tiered((0, 500), (100000, 1000)))

  val lotDrafted: LotEvent.LotDrafted = LotEvent.LotDrafted(auctionId(1))

  val lotScheduled: LotEvent.LotScheduled =
    LotEvent.LotScheduled(Schedule.of(money(10000), tieredConfig).toOption.get)

  val opened: LotEvent.LotOpened = LotEvent.LotOpened(money(10000), tieredConfig, Some(deadline))

  val placed: LotEvent.BidPlaced =
    LotEvent.BidPlaced(bid(1), participant(2), money(10500), Some(participant(1)), BidOrigin.Manual, BidSource.Bot)

  def transaction(opN: Int, initiator: Initiator = Initiator.Scheduler): Transaction =
    Transaction(uuid(2), op(opN), auctionId(1), decidedAt, initiator)

  /** Строка журнала: байты, manifest и идентификатор сериализатора — то, что лежит в `event_journal`. */
  final case class Row(serializerId: Int, manifest: String, bytes: Array[Byte]) {
    def json: JsonNode = mapper.readTree(bytes)
  }

  val mapper: ObjectMapper = new ObjectMapper()

  def write(system: ActorSystem[?], value: AnyRef): Row = {
    val serializer = SerializationExtension(system.classicSystem).findSerializerFor(value) match {
      case withManifest: SerializerWithStringManifest => withManifest
      case other => throw new AssertionError(s"сериализатор без manifest: ${other.getClass.getName}")
    }
    Row(serializer.identifier, serializer.manifest(value), serializer.toBinary(value))
  }

  def read(system: ActorSystem[?], row: Row): AnyRef =
    SerializationExtension(system.classicSystem).deserialize(row.bytes, row.serializerId, row.manifest).get

  /** Все числа дерева JSON: ни одно не должно быть дробным (ПП-5). */
  def numbers(node: JsonNode): List[JsonNode] =
    if (node.isNumber) List(node)
    else node.elements().asScala.toList.flatMap(numbers)
}
