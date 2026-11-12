package auction.entity

import auction.AuctionNode
import auction.aggregate.*
import auction.lot.AuctionId
import auction.lot.LotFixtures.participant
import auction.lot.OpId
import auction.lot.ParticipantId
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.persistence.SlickAuctionViews
import auction.telemetry.ProjectionMetrics
import auction.testkit.PostgresFixture
import io.opentelemetry.api.OpenTelemetry
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.util.Timeout
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec

import java.time.Clock
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.*

/**
 * Промо-видео аукциона (PER-781) на узле, собранном так же, как в `Main`: настоящая entity аукциона под шардингом,
 * журнал и read model на PostgreSQL. Рестарт — рестарт `ActorSystem` на той же базе: видео, записанное до него,
 * восстанавливается из журнала, а не из памяти процесса, и read model отдаёт его тем же снимком.
 */
final class AuctionPromoVideoIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(30, Seconds))

  private given Timeout = Timeout(20.seconds)

  private val person: ParticipantId = participant(1)

  private final class GrantingAuthority extends MeetupAuthority {
    def check(meetup: MeetupId, person: ParticipantId, correlation: Correlation): Future[Authority] =
      Future.successful(Authority.Granted(Standings.published))
  }

  private final case class Node(system: ActorSystem[?], sharding: ClusterSharding, commands: AuctionCommands)

  /** Узел на уже размеченной базе: второй вызов на той же базе — рестарт сервиса. */
  private def onDatabase[A](database: DatabaseSettings)(use: Node => A): A = {
    val kit = ActorTestKit(s"auction-promo-video-${UUID.randomUUID()}", nodeConfig(database))
    try {
      val clock = Clock.systemUTC()
      val sharding = AuctionNode.join(kit.system)
      AuctionNode.registerLots(sharding, clock, UuidV7.generator(clock))
      AuctionNode.registerAuctions(kit.system, sharding, clock, UuidV7.generator(clock), 10.seconds)
      AuctionNode.startProjection(
        kit.system,
        ProjectionMetrics(OpenTelemetry.noop().getMeter("auction"), clock),
        5.seconds
      )
      given scala.concurrent.ExecutionContext = kit.system.executionContext
      val commands = AuctionCommands(
        AuctionGateway.sharded(sharding, 10.seconds),
        LotGateway.sharded(sharding, 10.seconds),
        GrantingAuthority()
      )
      use(Node(kit.system, sharding, commands))
    } finally kit.shutdownTestKit()
  }

  private def newId(): UUID = UuidV7.generator(Clock.systemUTC())()

  private def newOp(): OpId = OpId(newId())

  private def stateOf(node: Node, auction: AuctionId): Auction =
    node.sharding
      .entityRefFor(AuctionEntity.TypeKey, auction.value.toString)
      .ask[Auction](AuctionEntity.Get(_))
      .futureValue

  "promo video" should {

    "keeps the promo video over a service restart, in the entity and in the read model" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val meetup = MeetupId(newId())
      val video = PromoVideo.parse(3_000_000_000L).get
      val auction = onDatabase(database) { node =>
        val auction = node.commands
          .draft(meetup, newOp(), person)
          .futureValue
          .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
        node.commands.setPromoVideo(auction, PromoVideo.parse(17), newOp(), person).futureValue shouldBe Right(())
        // Второе видео заменяет первое: рестарт обязан вернуть его.
        val op = newOp()
        node.commands.setPromoVideo(auction, Some(video), op, person).futureValue shouldBe Right(())
        node.commands.setPromoVideo(auction, Some(video), op, person).futureValue shouldBe Right(())
        stateOf(node, auction).promoVideo shouldBe Some(video)
        auction
      }
      onDatabase(database) { node =>
        stateOf(node, auction).promoVideo shouldBe Some(video)
        val views = SlickAuctionViews(node.system)
        eventually(views.byMeetup(meetup).futureValue.map(_.auction.promoVideo) shouldBe Some(Some(video)))
        node.commands.setPromoVideo(auction, None, newOp(), person).futureValue shouldBe Right(())
        eventually(views.byMeetup(meetup).futureValue.map(_.auction.promoVideo) shouldBe Some(None))
      }
    }
  }
}
