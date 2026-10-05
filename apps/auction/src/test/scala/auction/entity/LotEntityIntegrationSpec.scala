package auction.entity

import auction.AuctionNode
import auction.entity.JournalFixtures.*
import auction.lot.*
import auction.lot.LotFixtures.*
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.testkit.PostgresFixture
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.serialization.SerializationExtension
import org.apache.pekko.util.Timeout
import org.scalatest.concurrent.Eventually
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Duration
import java.time.Instant
import java.util.UUID
import scala.collection.mutable.ListBuffer
import scala.concurrent.Await
import scala.concurrent.duration.*
import scala.util.Using

/**
 * Entity лота на настоящем PostgreSQL: рестарт узла, snapshot, повтор команды и конкурентный писатель. In-memory журнал
 * этого не доказывает — он умирает вместе с `ActorSystem` и не держит `(persistence_id, sequence_number)`.
 */
final class LotEntityIntegrationSpec extends AnyWordSpec with Matchers with PostgresFixture with Eventually {

  private val patience = 20.seconds

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(20, Seconds))

  private type BidReply = Either[PlaceBidRejected, Envelope]

  /** Строка журнала: номер, сериализатор, manifest и payload текстом — так, как её читает человек в psql. */
  private final case class JournalRow(sequence: Long, serializerId: Int, manifest: String, payload: String)

  private def rows(database: DatabaseSettings, sql: String, id: String): List[JournalRow] =
    withConnection(database) { connection =>
      Using.resource(connection.prepareStatement(sql)) { statement =>
        statement.setString(1, persistenceId(id))
        Using.resource(statement.executeQuery()) { found =>
          val all = ListBuffer.empty[JournalRow]
          while (found.next())
            all += JournalRow(found.getLong(1), found.getInt(2), found.getString(3), found.getString(4))
          all.toList
        }
      }
    }

  private def journal(database: DatabaseSettings, id: String): List[JournalRow] =
    rows(
      database,
      """SELECT sequence_number, event_ser_id, event_ser_manifest, convert_from(event_payload, 'UTF8')
        |FROM event_journal WHERE persistence_id = ? ORDER BY sequence_number""".stripMargin,
      id
    )

  private def snapshots(database: DatabaseSettings, id: String): List[JournalRow] =
    rows(
      database,
      """SELECT sequence_number, snapshot_ser_id, snapshot_ser_manifest, convert_from(snapshot_payload, 'UTF8')
        |FROM snapshot WHERE persistence_id = ? ORDER BY sequence_number""".stripMargin,
      id
    )

  private def rowsWithOp(database: DatabaseSettings, id: String, opN: Int): Int =
    journal(database, id).count(row => mapper.readTree(row.payload).get("opId").asText == op(opN).value.toString)

  private def persistenceId(id: String) = s"${LotEntity.TypeKey.name}|$id"

  private def node(database: DatabaseSettings): ActorTestKit = {
    JournalSchema.migrate(database)
    ActorTestKit(s"auction-${UUID.randomUUID()}", nodeConfig(database))
  }

  private def lot(kit: ActorTestKit, id: String, snapshotEvery: Int = LotEntity.DefaultSnapshotEvery) =
    kit.spawn(LotEntity(id, clock, UuidV7.generator(clock), snapshotEvery))

  /** Полный путь до торгов: рождение, планирование и открытие занимают `op(1)`–`op(3)` и строки 1–3 журнала. */
  private def openOn(
      kit: ActorTestKit,
      entity: ActorRef[LotEntity.Command],
      input: LotConfigInput = configInput(),
      closesAt: Instant = deadline
  ): Either[OpenLotRejected, Envelope] = {
    val drafted = kit.createTestProbe[Either[DraftLotRejected, Envelope]]()
    entity ! LotEntity.Draft(draftLot(opN = 1), Initiator.Scheduler, drafted.ref)
    drafted.receiveMessage(patience)
    val planned = kit.createTestProbe[Either[ScheduleLotRejected, Envelope]]()
    entity ! LotEntity.Plan(scheduleLot(opN = 2, input = input), Initiator.Operator(participant(9)), planned.ref)
    planned.receiveMessage(patience)
    val replies = kit.createTestProbe[Either[OpenLotRejected, Envelope]]()
    entity ! LotEntity.Open(openLot(opN = 3, deadline = Some(closesAt)), Initiator.Scheduler, replies.ref)
    replies.receiveMessage(patience)
  }

  private def bidOn(kit: ActorTestKit, entity: ActorRef[LotEntity.Command], who: Int, amount: Long, opN: Int) = {
    val replies = kit.createTestProbe[BidReply]()
    entity ! LotEntity.Bid(placeBid(who, amount, opN), Initiator.Participant(participant(who)), replies.ref)
    replies.receiveMessage(patience)
  }

  private def limitOn(kit: ActorTestKit, entity: ActorRef[LotEntity.Command], who: Int, max: Long, opN: Int) = {
    val replies = kit.createTestProbe[Either[SetProxyLimitRejected, Envelope]]()
    entity ! LotEntity.SetLimit(setProxyLimit(who, max, opN), Initiator.Participant(participant(who)), replies.ref)
    replies.receiveMessage(patience)
  }

  private def read(kit: ActorTestKit, entity: ActorRef[LotEntity.Command]): Lot = {
    val replies = kit.createTestProbe[Lot]()
    entity ! LotEntity.Get(replies.ref)
    replies.receiveMessage(patience)
  }

  private def jacksonId(kit: ActorTestKit): Int =
    SerializationExtension(kit.system.classicSystem).serializerFor(classOf[StoredLotEvent]).identifier

  private def floatingPoints(payload: String) = numbers(mapper.readTree(payload)).filterNot(_.isIntegralNumber)

  "lot entity" should {

    "restore price, leader and deadline on a new node and number a command that woke it by the journal (Т-16)" in {
      val database = freshDatabase()
      val id = UUID.randomUUID().toString
      val first = node(database)
      try {
        val entity = lot(first, id)
        openOn(first, entity)
        bidOn(first, entity, who = 1, amount = 110, opN = 4)
        bidOn(first, entity, who = 2, amount = 120, opN = 5)
      } finally first.shutdownTestKit()

      val second = node(database)
      try {
        // Команда уходит сразу после spawn и ждёт recovery в stash — так пассивированный лот будит первая команда.
        val entity = lot(second, id)
        val woke = bidOn(second, entity, who = 1, amount = 130, opN = 6)
        val woken = read(second, entity)
        val restored = tradingOf(woken)

        woke.map(_.sequence) shouldBe Right(6L)
        (restored.currentPrice, restored.leader, restored.deadline) shouldBe
          (money(130), Some(participant(1)), Some(deadline))
        woken.auction shouldBe Some(auctionId(1))
        val written = journal(database, id)
        written.map(_.sequence) shouldBe List(1L, 2L, 3L, 4L, 5L, 6L)
        written.map(row => mapper.readTree(row.payload).get("auctionId").asText).distinct shouldBe
          List(auctionId(1).value.toString)
        written.map(_.manifest).distinct shouldBe List(classOf[StoredLotEvent].getName)
        written.map(_.serializerId).distinct shouldBe List(jacksonId(second))
        written.flatMap(row => floatingPoints(row.payload)) shouldBe Nil
      } finally second.shutdownTestKit()
    }

    "restore proxy limits with the journal positions that set them and act on them after a restart (Т-16)" in {
      // Через replay и через snapshot: `setSeq` в payload нет, и после snapshot его держит только он.
      List(LotEntity.DefaultSnapshotEvery, 2).foreach { snapshotEvery =>
        val database = freshDatabase()
        val id = UUID.randomUUID().toString
        val first = node(database)
        try {
          val entity = lot(first, id, snapshotEvery)
          openOn(first, entity)
          limitOn(first, entity, who = 1, max = 200, opN = 4)
          limitOn(first, entity, who = 2, max = 150, opN = 5)
        } finally first.shutdownTestKit()

        val second = node(database)
        try {
          val entity = lot(second, id, snapshotEvery)
          val restored = tradingOf(read(second, entity))

          restored.proxyLimits shouldBe Map(
            participant(1) -> limit(200, setSeq = 4),
            participant(2) -> limit(150, setSeq = 6)
          )
          (restored.currentPrice, restored.leader) shouldBe (money(160), Some(participant(1)))
          // Лимит восстановлен действующим: ручная ставка выше чужого лимита получает ответ прокси лидера.
          bidOn(second, entity, who = 3, amount = 170, opN = 6).map(_.sequence) shouldBe Right(8L)
          (tradingOf(read(second, entity)).currentPrice, tradingOf(read(second, entity)).leader) shouldBe
            (money(180), Some(participant(1)))
          val written = journal(database, id)
          written.map(_.sequence) shouldBe (1L to 9L).toList
          rowsWithOp(database, id, opN = 6) shouldBe 2
          if (snapshotEvery == 2) snapshots(database, id) should not be empty
        } finally second.shutdownTestKit()
      }
    }

    "keep the extended deadline and the count of extensions on a new node, so their limit is not reset (ПП-2)" in {
      // Окно в час при двух продлениях: часы фиксированы, и каждая ставка ложится в окно, где бы ни был дедлайн.
      val input = configInput().copy(antiSnipe = AntiSnipe(Duration.ofHours(1), Duration.ofMinutes(1), 2))
      val closesAt = decidedAt.plus(Duration.ofMinutes(1))
      List(LotEntity.DefaultSnapshotEvery, 2).foreach { snapshotEvery =>
        val database = freshDatabase()
        val id = UUID.randomUUID().toString
        val first = node(database)
        val beforeRestart =
          try {
            val entity = lot(first, id, snapshotEvery)
            openOn(first, entity, input, closesAt)
            bidOn(first, entity, who = 1, amount = 110, opN = 4)
            bidOn(first, entity, who = 2, amount = 120, opN = 5)
            tradingOf(read(first, entity))
          } finally first.shutdownTestKit()

        val second = node(database)
        try {
          val entity = lot(second, id, snapshotEvery)
          val restored = tradingOf(read(second, entity))

          restored shouldBe beforeRestart
          (restored.deadline, restored.extensionsUsed) shouldBe (Some(closesAt.plus(Duration.ofMinutes(2))), 2)
          // Лимит исчерпан до рестарта и после него не обнулился: ставка в окне пишет одну строку, без продления.
          bidOn(second, entity, who = 1, amount = 130, opN = 6).map(_.sequence) shouldBe Right(8L)
          rowsWithOp(database, id, opN = 6) shouldBe 1
          tradingOf(read(second, entity)).deadline shouldBe restored.deadline
          if (snapshotEvery == 2) snapshots(database, id) should not be empty
        } finally second.shutdownTestKit()
      }
    }

    "recover from a snapshot and the events after it with the deduplication window of the snapshot" in {
      val database = freshDatabase()
      val id = UUID.randomUUID().toString
      val first = node(database)
      val original =
        try {
          val entity = lot(first, id, snapshotEvery = 4)
          openOn(first, entity)
          val original = bidOn(first, entity, who = 1, amount = 110, opN = 4)
          bidOn(first, entity, who = 2, amount = 120, opN = 5)
          eventually(snapshots(database, id).map(_.sequence) shouldBe List(4L))
          original
        } finally first.shutdownTestKit()

      val second = node(database)
      try {
        val entity = lot(second, id, snapshotEvery = 4)
        val repeated = bidOn(second, entity, who = 1, amount = 110, opN = 4)
        val restored = tradingOf(read(second, entity))

        repeated shouldBe original
        (restored.currentPrice, restored.leader, restored.deadline) shouldBe
          (money(120), Some(participant(2)), Some(deadline))
        journal(database, id).map(_.sequence) shouldBe List(1L, 2L, 3L, 4L, 5L)
        val snapshot = snapshots(database, id)
        snapshot.map(_.manifest) shouldBe List(classOf[StoredLot].getName)
        snapshot.flatMap(row => floatingPoints(row.payload)) shouldBe Nil
      } finally second.shutdownTestKit()
    }

    "answer a repeated command with the original response and keep one row for its op id (Т-14)" in {
      val database = freshDatabase()
      val id = UUID.randomUUID().toString
      val first = node(database)
      val original =
        try {
          val entity = lot(first, id)
          openOn(first, entity)
          val original = bidOn(first, entity, who = 1, amount = 110, opN = 4)
          bidOn(first, entity, who = 1, amount = 110, opN = 4) shouldBe original
          original
        } finally first.shutdownTestKit()

      val second = node(database)
      try {
        bidOn(second, lot(second, id), who = 1, amount = 110, opN = 4) shouldBe original
        rowsWithOp(database, id, opN = 4) shouldBe 1
      } finally second.shutdownTestKit()
    }

    "stop a writer whose append the journal rejects and give one outcome to the repeat of its op id" in {
      val database = freshDatabase()
      val id = UUID.randomUUID().toString
      val first = node(database)
      val second = node(database)
      try {
        val stale = lot(first, id)
        openOn(first, stale)

        // Второй писатель того же лота: шардинг сужает такую гонку, но не исключает её (ADR-045).
        val rival = lot(second, id)
        val rivalReply = bidOn(second, rival, who = 1, amount = 110, opN = 4)

        // Первый писатель не видел ставки соперника и занимает тот же номер 4.
        val watcher = first.createTestProbe[Nothing]()
        val staleReplies = first.createTestProbe[BidReply]()
        stale ! LotEntity.Bid(placeBid(1, 110, 4), Initiator.Participant(participant(1)), staleReplies.ref)
        watcher.expectTerminated(stale, patience)
        staleReplies.expectNoMessage(1.second)

        val repeated = bidOn(first, lot(first, id), who = 1, amount = 110, opN = 4)

        rivalReply.map(_.sequence) shouldBe Right(4L)
        repeated shouldBe rivalReply
        journal(database, id).map(_.sequence) shouldBe List(1L, 2L, 3L, 4L)
        rowsWithOp(database, id, opN = 4) shouldBe 1
      } finally {
        first.shutdownTestKit()
        second.shutdownTestKit()
      }
    }

    "serve a lot through cluster sharding on the node as the service assembles it" in {
      val database = freshDatabase()
      val kit = node(database)
      try {
        val sharding = AuctionNode.join(kit.system)
        AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
        given Timeout = Timeout(patience)
        val id = UUID.randomUUID().toString

        val drafted = Await.result(
          sharding
            .entityRefFor(LotEntity.TypeKey, id)
            .ask[Either[DraftLotRejected, Envelope]](LotEntity.Draft(draftLot(opN = 1), Initiator.Scheduler, _)),
          patience
        )

        drafted.map(_.sequence) shouldBe Right(1L)
        journal(database, id).map(_.sequence) shouldBe List(1L)
      } finally kit.shutdownTestKit()
    }
  }
}
