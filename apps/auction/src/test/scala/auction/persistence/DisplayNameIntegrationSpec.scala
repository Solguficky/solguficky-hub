package auction.persistence

import auction.lot.ParticipantId
import auction.naming.AuctionId
import auction.naming.DisplayKind
import auction.naming.DisplayName
import auction.naming.DisplayNameCommands
import auction.naming.NameChoice
import auction.naming.NamingRefusal
import auction.naming.TelegramUsername
import auction.testkit.PostgresFixture
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.postgresql.util.PSQLException
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID
import scala.collection.mutable.ListBuffer
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.util.Using

final class DisplayNameIntegrationSpec extends AnyWordSpec with Matchers with ScalaFutures with PostgresFixture {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(20, Seconds))

  /** Строки одного аукциона как их видит база, мимо сервиса. */
  private def rows(
      database: DatabaseSettings,
      auction: AuctionId
  ): List[(String, Option[String], Option[String], Boolean)] =
    withConnection(database) { connection =>
      Using.resource(
        connection.prepareStatement(
          "SELECT participant_id::text, telegram_username, alias, frozen FROM auction_display_name WHERE auction_id = ?::uuid"
        )
      ) { statement =>
        statement.setString(1, auction.value.toString)
        Using.resource(statement.executeQuery()) { found =>
          val all = ListBuffer.empty[(String, Option[String], Option[String], Boolean)]
          while (found.next())
            all += ((found.getString(1), Option(found.getString(2)), Option(found.getString(3)), found.getBoolean(4)))
          all.toList
        }
      }
    }

  /** Узел и команды поверх его хранилища; узел останавливается после теста. */
  private given ExecutionContext = ExecutionContext.global

  private def withNode[A](database: DatabaseSettings)(use: DisplayNameCommands => A): A = {
    JournalSchema.migrate(database)
    val kit = ActorTestKit(s"auction-${UUID.randomUUID()}", nodeConfig(database))
    try use(DisplayNameCommands(SlickDisplayNameStore(kit.system))(using kit.system.executionContext))
    finally kit.shutdownTestKit()
  }

  private def auctionId() = AuctionId(UUID.randomUUID())

  private def participant() = ParticipantId(UUID.randomUUID())

  private def username(raw: String) = NameChoice.Username(TelegramUsername.from(raw))

  "display names" should {

    "keeps a choice written before the node stopped for the next node on the same database" in {
      val database = freshDatabase()
      val auction = auctionId()
      val someone = participant()
      withNode(database)(commands => commands.choose(auction, someone, NameChoice.Pseudonym(" Кот ")).futureValue)

      val shown = withNode(database)(commands => commands.names(auction, Set(someone)).futureValue)

      shown shouldBe Map(someone -> DisplayName("Кот*", DisplayKind.Pseudonym))
    }

    "gives a pseudonym to exactly one of the participants who take it at the same time" in {
      val database = freshDatabase()
      val auction = auctionId()
      val contenders = List.fill(8)(participant())
      val spellings = List("Кот", "кот", " КОТ ", "Кот", "кОт", "Кот ", "кот", "КОТ")

      val outcomes = withNode(database) { commands =>
        Future
          .traverse(contenders.zip(spellings))((someone, spelling) =>
            commands.choose(auction, someone, NameChoice.Pseudonym(spelling))
          )
          .futureValue
      }

      outcomes.count(_.isRight) shouldBe 1
      outcomes.filter(_.isLeft).distinct shouldBe List(Left(NamingRefusal.AliasTaken))
      rows(database, auction).flatMap(_._3) should have size 1
    }

    "allows the same pseudonym in another auction" in {
      val database = freshDatabase()
      withNode(database) { commands =>
        commands.choose(auctionId(), participant(), NameChoice.Pseudonym("Кот")).futureValue.isRight shouldBe true
        commands.choose(auctionId(), participant(), NameChoice.Pseudonym("Кот")).futureValue.isRight shouldBe true
      }
    }

    "keeps one row when a participant repeats and changes the choice before the first bid" in {
      val database = freshDatabase()
      val auction = auctionId()
      val someone = participant()
      withNode(database) { commands =>
        commands.choose(auction, someone, NameChoice.Pseudonym("Кот")).futureValue
        commands.choose(auction, someone, NameChoice.Pseudonym("Кот")).futureValue
        commands.choose(auction, someone, username("vasya")).futureValue.isRight shouldBe true
      }

      rows(database, auction) shouldBe List((someone.value.toString, Some("vasya"), None, false))
    }

    "frees a pseudonym its holder left before the first bid" in {
      val database = freshDatabase()
      val auction = auctionId()
      val first = participant()
      withNode(database) { commands =>
        commands.choose(auction, first, NameChoice.Pseudonym("Кот")).futureValue
        commands.choose(auction, first, username("vasya")).futureValue

        commands.choose(auction, participant(), NameChoice.Pseudonym("Кот")).futureValue.isRight shouldBe true
      }
    }

    "refuses another choice after the first accepted bid and leaves the row as it was" in {
      val database = freshDatabase()
      val auction = auctionId()
      val someone = participant()
      withNode(database) { commands =>
        commands.choose(auction, someone, NameChoice.Pseudonym("Кот")).futureValue
        commands.participated(auction, someone).futureValue shouldBe true
        commands.participated(auction, someone).futureValue shouldBe true

        commands.choose(auction, someone, username("vasya")).futureValue shouldBe Left(NamingRefusal.NameFrozen)
        commands.choose(auction, someone, NameChoice.Pseudonym("Кот")).futureValue.isRight shouldBe true
      }

      rows(database, auction) shouldBe List((someone.value.toString, None, Some("Кот"), true))
    }

    "ends a choice racing the first accepted bid either written or refused as frozen, never lost" in {
      val database = freshDatabase()
      withNode(database) { commands =>
        (1 to 20).foreach { _ =>
          val auction = auctionId()
          val someone = participant()
          commands.choose(auction, someone, username("vasya")).futureValue

          val (choice, frozen) = Future
            .sequence(
              List(
                commands.choose(auction, someone, NameChoice.Pseudonym("Кот")),
                commands.participated(auction, someone)
              )
            )
            .map { case List(c, f) => (c, f) }
            .futureValue

          frozen shouldBe true
          val stored = rows(database, auction).map(row => (row._2, row._3, row._4))
          choice match {
            case Right(_) => stored shouldBe List((None, Some("Кот"), true))
            case Left(NamingRefusal.NameFrozen) => stored shouldBe List((Some("vasya"), None, true))
            case other => fail(s"unexpected outcome $other")
          }
        }
      }
    }

    "does not freeze a participant without a choice" in {
      val database = freshDatabase()
      val auction = auctionId()
      withNode(database)(commands => commands.participated(auction, participant()).futureValue) shouldBe false

      rows(database, auction) shouldBe empty
    }

    "rejects a row written past the service that holds both kinds of name or a marked pseudonym" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      def insert(username: String, alias: String, key: String) =
        the[PSQLException] thrownBy withConnection(database) {
          _.createStatement().executeUpdate(
            s"""INSERT INTO auction_display_name (auction_id, participant_id, telegram_username, alias, alias_key)
                VALUES ('${UUID.randomUUID()}', '${UUID.randomUUID()}', $username, $alias, $key)"""
          )
        }

      insert("'vasya'", "'Кот'", "'кот'").getSQLState shouldBe "23514"
      insert("NULL", "'Кот*'", "'кот*'").getSQLState shouldBe "23514"
      insert("'@vasya'", "NULL", "NULL").getSQLState shouldBe "23514"
    }
  }
}
