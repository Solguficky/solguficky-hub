package auction.entity

import auction.AuctionNode
import auction.aggregate.*
import auction.catalog.LotId
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
 * Порядок и разделы ленты (PER-719) на узле, собранном так же, как в `Main`: настоящая entity аукциона под шардингом,
 * журнал и read model на PostgreSQL. Рестарт — рестарт `ActorSystem` на той же базе: раскладка, записанная до него,
 * восстанавливается из журнала, а не из памяти процесса, и read model отдаёт её тем же снимком.
 */
final class AuctionLayoutIntegrationSpec
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
    val kit = ActorTestKit(s"auction-layout-${UUID.randomUUID()}", nodeConfig(database))
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

  private def section(id: Int, name: String, lots: LotId*): LotSection =
    LotSection(LotSectionId(id).get, LotSectionName(name).get, lots.toList)

  "lot layout" should {

    "keeps the order and the sections of the feed over a service restart, in the entity and in the read model" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val meetup = MeetupId(newId())
      val (auction, layout) = onDatabase(database) { node =>
        val auction = node.commands
          .draft(meetup, newOp(), person)
          .futureValue
          .fold(denial => fail(s"the auction was not drafted: $denial"), _.auctionId)
        val lots = List.fill(4)(LotId(newId()))
        lots.foreach(lot => node.commands.addLot(auction, lot, newOp(), person).futureValue shouldBe Right(()))
        val first = LotLayout.of(lots.reverse, Nil).toOption.get
        node.commands.setLotLayout(auction, first, newOp(), person).futureValue shouldBe Right(())
        // Вторая раскладка заменяет первую целиком: рестарт обязан вернуть её, а не смесь двух.
        val layout = LotLayout
          .of(List(lots(3)), List(section(2, "Посуда", lots(1), lots(0)), section(1, "Книги", lots(2))))
          .toOption
          .get
        node.commands.setLotLayout(auction, layout, newOp(), person).futureValue shouldBe Right(())
        stateOf(node, auction).layout shouldBe layout
        (auction, layout)
      }
      onDatabase(database) { node =>
        stateOf(node, auction).layout shouldBe layout
        val views = SlickAuctionViews(node.system)
        eventually(views.byMeetup(meetup).futureValue.map(_.auction.layout) shouldBe Some(layout))
      }
    }
  }
}
