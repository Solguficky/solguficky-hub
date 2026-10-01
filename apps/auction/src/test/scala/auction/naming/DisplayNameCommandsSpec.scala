package auction.naming

import auction.lot.AuctionId
import auction.lot.ParticipantId
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

final class DisplayNameCommandsSpec extends AnyWordSpec with Matchers with ScalaFutures {

  private given ExecutionContext = ExecutionContext.parasitic

  private def auctionId() = AuctionId(UUID.randomUUID())

  private def participant() = ParticipantId(UUID.randomUUID())

  private def username(raw: String) = NameChoice.Username(TelegramUsername.from(raw))

  /** Хранилище, которое нельзя трогать: любой вызов роняет тест. */
  private object Untouchable extends DisplayNameStore {
    private def touched = fail("the store was touched")
    def choose(auction: AuctionId, participant: ParticipantId, name: ChosenName): Future[ChooseResult] = touched
    def freeze(auction: AuctionId, participant: ParticipantId): Future[Boolean] = touched
    def find(auction: AuctionId, participants: Set[ParticipantId]): Future[Map[ParticipantId, ChosenName]] = touched
  }

  /** Модель таблицы: уникальность псевдонима в аукционе и заморозка — те же правила, что держит база. */
  private final class InMemory extends DisplayNameStore {
    private var rows = Map.empty[(AuctionId, ParticipantId), (ChosenName, Boolean)]

    def choose(auction: AuctionId, participant: ParticipantId, name: ChosenName): Future[ChooseResult] =
      synchronized {
        val takenByOther = name match {
          case ChosenName.Pseudonym(alias) =>
            rows.exists {
              case ((a, p), (ChosenName.Pseudonym(held), _)) =>
                a == auction && p != participant && held.key == alias.key
              case _ => false
            }
          case ChosenName.Telegram(_) => false
        }
        rows.get(auction -> participant) match {
          case Some((current, true)) => Future.successful(ChooseResult.Frozen(current))
          case _ if takenByOther => Future.successful(ChooseResult.AliasTaken)
          case _ =>
            rows += (auction -> participant) -> (name -> false)
            Future.successful(ChooseResult.Written)
        }
      }

    def freeze(auction: AuctionId, participant: ParticipantId): Future[Boolean] =
      synchronized {
        rows.get(auction -> participant) match {
          case Some((name, _)) =>
            rows += (auction -> participant) -> (name -> true)
            Future.successful(true)
          case None => Future.successful(false)
        }
      }

    def find(auction: AuctionId, participants: Set[ParticipantId]): Future[Map[ParticipantId, ChosenName]] =
      synchronized {
        Future.successful(rows.collect { case ((a, p), (name, _)) if a == auction && participants(p) => p -> name })
      }
  }

  "display name commands" should {

    "refuses a participant without a username or with an invalid pseudonym before touching the store" in {
      val commands = DisplayNameCommands(Untouchable)

      commands.choose(auctionId(), participant(), NameChoice.Username(None)).futureValue shouldBe
        Left(NamingRefusal.UsernameMissing)
      commands.choose(auctionId(), participant(), NameChoice.Pseudonym("Вася*")).futureValue shouldBe
        Left(NamingRefusal.AliasInvalid)
    }

    "answers the chosen name as it will be shown" in {
      val commands = DisplayNameCommands(InMemory())

      commands.choose(auctionId(), participant(), username("vasya")).futureValue shouldBe
        Right(DisplayName("@vasya", DisplayKind.Username))
      commands.choose(auctionId(), participant(), NameChoice.Pseudonym(" Кот ")).futureValue shouldBe
        Right(DisplayName("Кот*", DisplayKind.Pseudonym))
    }

    "refuses a pseudonym another participant of the auction holds and allows it in another auction" in {
      val commands = DisplayNameCommands(InMemory())
      val auction = auctionId()
      commands.choose(auction, participant(), NameChoice.Pseudonym("Кот")).futureValue

      commands.choose(auction, participant(), NameChoice.Pseudonym("кот")).futureValue shouldBe
        Left(NamingRefusal.AliasTaken)
      commands.choose(auctionId(), participant(), NameChoice.Pseudonym("Кот")).futureValue.isRight shouldBe true
    }

    "lets a participant change the choice until the first accepted bid" in {
      val commands = DisplayNameCommands(InMemory())
      val auction = auctionId()
      val someone = participant()
      commands.choose(auction, someone, username("vasya")).futureValue

      commands.choose(auction, someone, NameChoice.Pseudonym("Кот")).futureValue shouldBe
        Right(DisplayName("Кот*", DisplayKind.Pseudonym))
      commands.names(auction, Set(someone)).futureValue.apply(someone).text shouldBe "Кот*"
    }

    "keeps the name after the first accepted bid and accepts a repetition of the same choice" in {
      val commands = DisplayNameCommands(InMemory())
      val auction = auctionId()
      val someone = participant()
      commands.choose(auction, someone, NameChoice.Pseudonym("Кот")).futureValue
      commands.participated(auction, someone).futureValue shouldBe true

      commands.choose(auction, someone, username("vasya")).futureValue shouldBe Left(NamingRefusal.NameFrozen)
      commands.choose(auction, someone, NameChoice.Pseudonym(" кот ")).futureValue shouldBe
        Left(NamingRefusal.NameFrozen)
      commands.choose(auction, someone, NameChoice.Pseudonym("Кот")).futureValue shouldBe
        Right(DisplayName("Кот*", DisplayKind.Pseudonym))
      commands.names(auction, Set(someone)).futureValue.apply(someone).text shouldBe "Кот*"
    }

    "admits a bid only from a participant who chose a name in that auction" in {
      val commands = DisplayNameCommands(InMemory())
      val auction = auctionId()
      val someone = participant()

      commands.requireChosen(auction, someone).futureValue shouldBe Left(NameNotChosen)
      commands.choose(auction, someone, username("vasya")).futureValue
      commands.requireChosen(auction, someone).futureValue.isRight shouldBe true
      commands.requireChosen(auctionId(), someone).futureValue shouldBe Left(NameNotChosen)
    }

    "names every requested participant, the ones without a choice by a placeholder" in {
      val commands = DisplayNameCommands(InMemory())
      val auction = auctionId()
      val chosen = participant()
      val silent = participant()
      commands.choose(auction, chosen, username("vasya")).futureValue

      val shown = commands.names(auction, Set(chosen, silent)).futureValue

      shown.keySet shouldBe Set(chosen, silent)
      shown(chosen).text shouldBe "@vasya"
      shown(silent).kind shouldBe DisplayKind.Placeholder
    }

    "does not freeze a participant who has not chosen a name" in {
      DisplayNameCommands(InMemory()).participated(auctionId(), participant()).futureValue shouldBe false
    }
  }
}
