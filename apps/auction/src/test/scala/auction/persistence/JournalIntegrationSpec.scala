package auction.persistence

import auction.AuctionNode
import auction.testkit.CounterEntity
import auction.testkit.PostgresFixture
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.cluster.sharding.typed.scaladsl.Entity
import org.apache.pekko.util.Timeout
import org.postgresql.util.PSQLException
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID
import scala.collection.mutable.ListBuffer
import scala.concurrent.Await
import scala.concurrent.duration.*
import scala.util.Using

final class JournalIntegrationSpec extends AnyWordSpec with Matchers with PostgresFixture {

  private val patience = 20.seconds

  /** Номера строк журнала одного агрегата и их писатели, в порядке номера. */
  private def journalRows(database: DatabaseSettings, persistenceId: String): List[(Long, String)] =
    withConnection(database) { connection =>
      Using.resource(
        connection.prepareStatement(
          "SELECT sequence_number, writer FROM event_journal WHERE persistence_id = ? ORDER BY sequence_number"
        )
      ) { statement =>
        statement.setString(1, persistenceId)
        Using.resource(statement.executeQuery()) { rows =>
          val found = ListBuffer.empty[(Long, String)]
          while (rows.next()) found += rows.getLong(1) -> rows.getString(2)
          found.toList
        }
      }
    }

  private def node(database: DatabaseSettings): ActorTestKit = {
    JournalSchema.migrate(database)
    ActorTestKit(s"auction-${UUID.randomUUID()}", nodeConfig(database))
  }

  private def persistenceId(id: String) = s"${CounterEntity.TypeKey.name}|$id"

  "journal" should {

    "reject a second row with the same persistence id and sequence number and keep the stream as written" in {
      val database = freshDatabase()
      val kit = node(database)
      try {
        val id = UUID.randomUUID().toString
        val entity = kit.spawn(CounterEntity(id))
        val replies = kit.createTestProbe[Long]()
        entity ! CounterEntity.Append(replies.ref)
        entity ! CounterEntity.Append(replies.ref)
        replies.receiveMessages(2, patience) shouldBe List(1L, 2L)
        val written = journalRows(database, persistenceId(id))

        val duplicate = the[PSQLException] thrownBy withConnection(database) {
          _.createStatement().executeUpdate(
            s"""INSERT INTO event_journal
               |  (persistence_id, sequence_number, writer, event_ser_id, event_ser_manifest, event_payload)
               |SELECT persistence_id, sequence_number, 'intruder', event_ser_id, event_ser_manifest, event_payload
               |FROM event_journal WHERE persistence_id = '${persistenceId(id)}' AND sequence_number = 2""".stripMargin
          )
        }

        duplicate.getSQLState shouldBe "23505"
        written.map(_._1) shouldBe List(1L, 2L)
        journalRows(database, persistenceId(id)) shouldBe written
      } finally kit.shutdownTestKit()
    }

    "stop an entity whose write the journal rejects and recover it from what the journal holds" in {
      val database = freshDatabase()
      val first = node(database)
      val second = node(database)
      try {
        val id = UUID.randomUUID().toString
        val replies = first.createTestProbe[Long]()
        val stale = first.spawn(CounterEntity(id))
        stale ! CounterEntity.Append(replies.ref)
        replies.expectMessage(patience, 1L)

        // Второй писатель того же persistence id — конфликт, который шардинг
        // сужает, но не исключает (ADR-045): его запись занимает номер 2.
        val rival = second.spawn(CounterEntity(id))
        val rivalReplies = second.createTestProbe[Long]()
        rival ! CounterEntity.Append(rivalReplies.ref)
        rivalReplies.expectMessage(patience, 2L)

        // Первый писатель всё ещё считает, что следующий номер — 2.
        val watcher = first.createTestProbe[Nothing]()
        stale ! CounterEntity.Append(replies.ref)

        watcher.expectTerminated(stale, patience)
        replies.expectNoMessage(1.second)
        journalRows(database, persistenceId(id)).map(_._1) shouldBe List(1L, 2L)

        val recovered = first.spawn(CounterEntity(id))
        recovered ! CounterEntity.Read(replies.ref)
        replies.expectMessage(patience, 2L)
      } finally {
        first.shutdownTestKit()
        second.shutdownTestKit()
      }
    }

    "write the events of one command together or not at all" in {
      val database = freshDatabase()
      val kit = node(database)
      try {
        val id = UUID.randomUUID().toString
        val entity = kit.spawn(CounterEntity(id))
        val replies = kit.createTestProbe[Long]()
        entity ! CounterEntity.Append(replies.ref)
        replies.expectMessage(patience, 1L)

        // Чужая строка занимает второе место пакета: первая строка пакета сама
        // по себе свободна, и только атомарность запрещает ей остаться.
        withConnection(database) {
          _.createStatement().executeUpdate(
            s"""INSERT INTO event_journal
               |  (persistence_id, sequence_number, writer, event_ser_id, event_ser_manifest, event_payload)
               |SELECT persistence_id, 3, 'intruder', event_ser_id, event_ser_manifest, event_payload
               |FROM event_journal WHERE persistence_id = '${persistenceId(id)}' AND sequence_number = 1""".stripMargin
          )
        }
        val watcher = kit.createTestProbe[Nothing]()
        entity ! CounterEntity.AppendMany(2, replies.ref)

        watcher.expectTerminated(entity, patience)
        replies.expectNoMessage(1.second)
        journalRows(database, persistenceId(id)).map(_._1) shouldBe List(1L, 3L)
      } finally kit.shutdownTestKit()
    }

    "serve a sharded entity on the single-node cluster" in {
      val database = freshDatabase()
      val kit = node(database)
      try {
        val sharding = AuctionNode.join(kit.system)
        sharding.init(Entity(CounterEntity.TypeKey)(context => CounterEntity(context.entityId)))
        given Timeout = Timeout(patience)
        val id = UUID.randomUUID().toString

        val count =
          Await.result(sharding.entityRefFor(CounterEntity.TypeKey, id).ask(CounterEntity.Append(_)), patience)

        count shouldBe 1L
        journalRows(database, persistenceId(id)).map(_._1) shouldBe List(1L)
      } finally kit.shutdownTestKit()
    }
  }
}
