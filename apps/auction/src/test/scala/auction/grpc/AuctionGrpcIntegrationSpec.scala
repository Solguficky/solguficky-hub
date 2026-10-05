package auction.grpc

import auction.AuctionNode
import auction.aggregate.Auction
import auction.aggregate.AuctionState
import auction.aggregate.Authority
import auction.aggregate.Correlation
import auction.aggregate.MeetupAuthority
import auction.aggregate.MeetupId
import auction.entity.AuctionEntity
import auction.entity.Initiator
import auction.entity.LotEntity
import auction.entity.UuidV7
import auction.lot.*
import auction.lot.LotFixtures.*
import auction.persistence.DatabaseSettings
import auction.persistence.JournalSchema
import auction.telemetry.ProjectionMetrics
import auction.testkit.PostgresFixture
import auction.catalog.LotImage
import auction.catalog.TestImages
import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction_service as wire
import com.google.protobuf.ByteString
import com.typesafe.config.ConfigFactory
import identity.v1.roles.GlobalRole as GlobalRoleMessage
import io.opentelemetry.api.OpenTelemetry
import io.grpc.Status
import io.grpc.StatusRuntimeException
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.grpc.GrpcClientSettings
import org.apache.pekko.grpc.scaladsl.SingleResponseRequestBuilder
import org.apache.pekko.http.scaladsl.Http
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
 * Ставка через gRPC на узле, собранном так же, как в `Main`: кластер, шардинг лота, журнал и каталог на PostgreSQL и
 * граница с проверкой вызывающего. Клиент ходит по проводу с токеном бота хаба, как будет ходить бот.
 */
final class AuctionGrpcIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(timeout = Span(30, Seconds))

  private val hubToken = "hub-token"

  "FAQ grpc" should {
    "store completion through the production boundary only for the auction bot and its viewer" in withNode { node =>
      val viewer = wire.Viewer("01926f3c-8b7a-7cde-8f00-000000000001", Seq(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC))
      val read = wire.GetFaqAcknowledgementRequest(Some(viewer))
      val finish = wire.AcknowledgeFaqRequest(Some(viewer))
      node.client
        .getFaqAcknowledgement()
        .addHeader("authorization", "Bearer auction")
        .invoke(read)
        .futureValue
        .acknowledged shouldBe false
      node.client
        .acknowledgeFaq()
        .addHeader("authorization", "Bearer auction")
        .invoke(finish)
        .futureValue
        .acknowledged shouldBe true
      node.client
        .acknowledgeFaq()
        .addHeader("authorization", "Bearer auction")
        .invoke(finish)
        .futureValue
        .acknowledged shouldBe true
      node.client
        .getFaqAcknowledgement()
        .addHeader("authorization", "Bearer auction")
        .invoke(read)
        .futureValue
        .acknowledged shouldBe true
      val other = read.withViewer(viewer.withIdentityId("01926f3c-8b7a-7cde-8f00-000000000002"))
      node.client
        .getFaqAcknowledgement()
        .addHeader("authorization", "Bearer auction")
        .invoke(other)
        .futureValue
        .acknowledged shouldBe false
      statusOf(
        node.client.acknowledgeFaq().addHeader("authorization", s"Bearer $hubToken").invoke(finish)
      ) shouldBe Status.Code.UNAUTHENTICATED
    }
  }

  private val callers = CallerTable
    .fromConfig(
      ConfigFactory.parseString(s"""auction.grpc.callers { hub-bot = "$hubToken", auction-bot = "auction" }"""),
      MethodAccess.declared
    )
    .fold(reason => fail(reason), table => table)

  /**
   * Meetups узла: отвечает тем, что тест положил, и считает вопросы. Провод Auction → Meetups этот сьют не проверяет —
   * его держит L0 адаптера и контур; здесь проверяется, что делает с ответом узел.
   */
  private final class StubAuthority extends MeetupAuthority {
    @volatile var answer: Authority = Authority.Granted
    @volatile var asked: Int = 0
    @volatile var correlations: List[Correlation] = Nil
    def check(meetup: MeetupId, person: ParticipantId, correlation: Correlation): Future[Authority] = {
      asked += 1
      correlations :+= correlation
      Future.successful(answer)
    }
  }

  private final case class Node(
      kit: ActorTestKit,
      sharding: ClusterSharding,
      client: wire.AuctionServiceClient,
      authority: StubAuthority
  )

  private def withNode[A](use: Node => A): A = {
    val database = freshDatabase()
    JournalSchema.migrate(database)
    onDatabase(database)(use)
  }

  /** Узел на уже размеченной базе: второй вызов на той же базе — рестарт сервиса. */
  private def onDatabase[A](database: DatabaseSettings)(use: Node => A): A = {
    val kit = ActorTestKit(s"auction-grpc-${UUID.randomUUID()}", nodeConfig(database))
    given ActorSystem[?] = kit.system
    val authority = StubAuthority()
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
      val binding = Http()
        .newServerAt("127.0.0.1", 0)
        .withSettings(AuctionNode.grpcServerSettings(kit.system))
        .bind(AuctionNode.grpc(kit.system, sharding, callers, 10.seconds, authority))
        .futureValue
      val client = wire.AuctionServiceClient(
        GrpcClientSettings.connectToServiceAt("127.0.0.1", binding.localAddress.getPort).withTls(false)
      )
      try use(Node(kit, sharding, client, authority))
      finally client.close().futureValue
    } finally kit.shutdownTestKit()
  }

  private given Timeout = Timeout(20.seconds)

  /** Лот в торгах: рождение, планирование со стартовой ценой 100 и шагом 10, открытие. */
  private def tradingLot(node: Node, auction: AuctionId = auctionId(1)): UUID = {
    val id = UuidV7.generator(Clock.systemUTC())()
    val lot = node.sharding.entityRefFor(LotEntity.TypeKey, id.toString)
    lot
      .ask[Either[DraftLotRejected, Envelope]](LotEntity.Draft(draftLot(opN = 1, of = auction), Initiator.Scheduler, _))
      .futureValue
      .isRight shouldBe true
    lot
      .ask[Either[ScheduleLotRejected, Envelope]](
        LotEntity.Plan(scheduleLot(opN = 2), Initiator.Operator(participant(9)), _)
      )
      .futureValue
      .isRight shouldBe true
    lot
      .ask[Either[OpenLotRejected, Envelope]](LotEntity.Open(openLot(opN = 3), Initiator.Scheduler, _))
      .futureValue
      .isRight shouldBe true
    id
  }

  private def currentPrice(node: Node, lotId: UUID): Money =
    node.sharding.entityRefFor(LotEntity.TypeKey, lotId.toString).ask[Lot](LotEntity.Get(_)).futureValue.state match {
      case LotState.Trading(trading) => trading.currentPrice
      case other => fail(s"lot is not trading: $other")
    }

  private def viewer(roles: GlobalRoleMessage*): wire.Viewer =
    wire.Viewer(UuidV7.generator(Clock.systemUTC())().toString, roles)

  private def bid(lotId: UUID, amount: Long, who: wire.Viewer): wire.PlaceBidRequest =
    wire.PlaceBidRequest(
      Some(who),
      lotId.toString,
      Some(MoneyMessage(amount, "RUB")),
      UuidV7.generator(Clock.systemUTC())().toString
    )

  private def asHubBot[Req, Res](call: SingleResponseRequestBuilder[Req, Res]) =
    call.addHeader("authorization", s"Bearer $hubToken")

  private def statusOf(call: Future[?]): Status.Code =
    call.failed.futureValue match {
      case refused: StatusRuntimeException => refused.getStatus.getCode
      case other => fail(s"expected a status, got $other")
    }

  private def newId(): String = UuidV7.generator(Clock.systemUTC())().toString

  private def administrator: wire.Viewer = viewer(GlobalRoleMessage.GLOBAL_ROLE_ADMIN)

  private def enable(node: Node, meetup: String, op: String = newId()): wire.DraftAuctionResponse =
    asHubBot(node.client.draftAuction()).invoke(wire.DraftAuctionRequest(Some(administrator), meetup, op)).futureValue

  private def meetupAuction(node: Node, meetup: String): Option[wire.AuctionSnapshot] =
    asHubBot(node.client.getMeetupAuction())
      .invoke(wire.GetMeetupAuctionRequest(Some(administrator), meetup))
      .futureValue
      .auction

  private def feed(node: Node, auction: String): Seq[String] =
    asHubBot(node.client.listAuctionLots())
      .invoke(wire.ListAuctionLotsRequest(Some(viewer(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)), auction))
      .futureValue
      .lots
      .map(_.id)

  private def auctionState(node: Node, auction: String): Auction =
    node.sharding.entityRefFor(AuctionEntity.TypeKey, auction).ask[Auction](AuctionEntity.Get(_)).futureValue

  "auction at a meetup grpc" should {

    "enables one auction per meetup: a repeated op_id answers as the first call and a new one finds it" in withNode {
      node =>
        val meetup = newId()
        val op = newId()
        val first = enable(node, meetup, op).getAccepted
        first.alreadyExisted shouldBe false
        first.auctionId shouldBe Auction.idOf(MeetupId(UUID.fromString(meetup))).value.toString
        enable(node, meetup, op).getAccepted shouldBe first
        enable(node, meetup).getAccepted shouldBe first.copy(alreadyExisted = true)
        // Один аукцион — одна строка журнала рождения, сколько бы раз его ни включали.
        auctionState(node, first.auctionId).seen should have size 1
        eventually {
          val read = meetupAuction(node, meetup).getOrElse(fail("the meetup auction is not readable yet"))
          read.id shouldBe first.auctionId
          read.status.isDraft shouldBe true
        }
    }

    "refuses a viewer whom meetups does not confirm as administrator and creates no auction" in withNode { node =>
      val meetup = newId()
      node.authority.answer = Authority.NotAdministrator
      enable(node, meetup).getRefused.reason.isNotMeetupAdministrator shouldBe true
      node.authority.answer = Authority.MeetupNotFound
      enable(node, meetup).getRefused.reason.isMeetupNotFound shouldBe true
      node.authority.answer = Authority.Unavailable
      statusOf(
        asHubBot(node.client.draftAuction()).invoke(wire.DraftAuctionRequest(Some(administrator), meetup, newId()))
      ) shouldBe Status.Code.UNAVAILABLE
      auctionState(node, Auction.idOf(MeetupId(UUID.fromString(meetup))).value.toString).state shouldBe
        AuctionState.Initial
      meetupAuction(node, meetup) shouldBe None
    }

    "passes x-request-id and x-use-case of the call on to meetups" in withNode { node =>
      asHubBot(node.client.draftAuction())
        .addHeader("x-request-id", "req-auction-1")
        .addHeader("x-use-case", "enable-meetup-auction")
        .invoke(wire.DraftAuctionRequest(Some(administrator), newId(), newId()))
        .futureValue
        .outcome
        .isAccepted shouldBe true
      node.authority.correlations shouldBe List(Correlation(Some("req-auction-1"), Some("enable-meetup-auction")))
    }

    "answers NOT_FOUND to a registry command on an auction that was never enabled, without asking meetups" in withNode {
      node =>
        val auction = Auction.idOf(MeetupId(UUID.fromString(newId()))).value.toString
        statusOf(
          asHubBot(node.client.addLot()).invoke(wire.AddLotRequest(Some(administrator), auction, newId(), newId()))
        ) shouldBe Status.Code.NOT_FOUND
        node.authority.asked shouldBe 0
    }

    "shows an added lot in the feed of the meetup auction and drops it after RemoveLot" in withNode { node =>
      val auction = enable(node, newId()).getAccepted.auctionId
      val lot = newId()
      val add = wire.AddLotRequest(Some(administrator), auction, lot, newId())
      asHubBot(node.client.addLot()).invoke(add).futureValue.outcome.isAccepted shouldBe true
      // Повтор того же op_id отвечает так же и не спрашивает Meetups второй раз.
      val asked = node.authority.asked
      asHubBot(node.client.addLot()).invoke(add).futureValue.outcome.isAccepted shouldBe true
      node.authority.asked shouldBe asked
      eventually(feed(node, auction) shouldBe Seq(lot))
      eventually(meetupAuction(node, auctionMeetup(node, auction)).map(_.lotIds) shouldBe Some(Seq(lot)))

      val remove = wire.RemoveLotRequest(Some(administrator), auction, lot, newId())
      asHubBot(node.client.removeLot()).invoke(remove).futureValue.outcome.isAccepted shouldBe true
      eventually(feed(node, auction) shouldBe empty)
      asHubBot(node.client.removeLot())
        .invoke(remove.withOpId(newId()))
        .futureValue
        .getRefused
        .reason
        .isLotNotInAuction shouldBe true

      // Лот, снятый с реестра, остаётся рождённым и возвращается в ленту повторным добавлением.
      asHubBot(node.client.addLot()).invoke(add.withOpId(newId())).futureValue.outcome.isAccepted shouldBe true
      eventually(feed(node, auction) shouldBe Seq(lot))
    }

    "refuses a lot born in another auction with FAILED_PRECONDITION and keeps it out of the feed" in withNode { node =>
      val auction = enable(node, newId()).getAccepted.auctionId
      // Лот тестового аукциона из настройки бота: рождён в нём, а не в аукционе сходки.
      val foreign = tradingLot(node, AuctionId(UuidV7.generator(Clock.systemUTC())()))
      statusOf(
        asHubBot(node.client.addLot())
          .invoke(wire.AddLotRequest(Some(administrator), auction, foreign.toString, newId()))
      ) shouldBe Status.Code.FAILED_PRECONDITION
      auctionState(node, auction).lots shouldBe empty
    }

    "keeps the auction, its meetup and its registry over a service restart" in {
      val database = freshDatabase()
      JournalSchema.migrate(database)
      val meetup = newId()
      val lot = newId()
      val auction = onDatabase(database) { node =>
        val id = enable(node, meetup).getAccepted.auctionId
        asHubBot(node.client.addLot())
          .invoke(wire.AddLotRequest(Some(administrator), id, lot, newId()))
          .futureValue
          .outcome
          .isAccepted shouldBe true
        id
      }
      onDatabase(database) { node =>
        val restored = auctionState(node, auction)
        restored.meetup shouldBe Some(MeetupId(UUID.fromString(meetup)))
        restored.lots.map(_.value.toString) shouldBe Set(lot)
        enable(node, meetup).getAccepted.alreadyExisted shouldBe true
        eventually(feed(node, auction) shouldBe Seq(lot))
      }
    }
  }

  /** Сходка аукциона — из entity: снимок чтения её не несёт, а чтение по сходке её требует. */
  private def auctionMeetup(node: Node, auction: String): String =
    auctionState(node, auction).meetup.map(_.value.toString).getOrElse(fail("the auction has no meetup"))

  /** Аукцион с идентификатором по контракту: поля аукциона лота принимают только канонический UUID версии 5 или 7. */
  private def freshAuction(): AuctionId = AuctionId(UuidV7.generator(Clock.systemUTC())())

  private def choose(node: Node, who: wire.Viewer, auction: AuctionId, alias: String): wire.ChooseDisplayNameResponse =
    asHubBot(node.client.chooseDisplayName())
      .invoke(wire.ChooseDisplayNameRequest(Some(who), auction.value.toString).withAlias(alias))
      .futureValue

  /** Участник с ролью `public`, выбравший имя в аукционе: без имени ставка до лота не доходит (ADR-059). */
  private def named(node: Node, auction: AuctionId, alias: String = "Кот"): wire.Viewer = {
    val who = viewer(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)
    choose(node, who, auction, alias).outcome.isAccepted shouldBe true
    who
  }

  "auction grpc" should {

    "places a bid through the wire and leaves the new price in the lot" in withNode { node =>
      val auction = freshAuction()
      val lotId = tradingLot(node, auction)
      val response = asHubBot(node.client.placeBid()).invoke(bid(lotId, 150, named(node, auction)))
      response.futureValue.outcome.isAccepted shouldBe true
      currentPrice(node, lotId) shouldBe money(150)
    }

    "places a bid through the wire and answers the new price through GetLot and ListAuctionLots" in withNode { node =>
      val auction = freshAuction()
      val lotId = tradingLot(node, auction)
      val bidder = named(node, auction)
      asHubBot(node.client.placeBid()).invoke(bid(lotId, 150, bidder)).futureValue.outcome.isAccepted shouldBe true
      // GetLot читает read model, которую пишет проекция: новая цена приходит с её задержкой, а не сразу.
      eventually {
        val snapshot =
          asHubBot(node.client.getLot()).invoke(wire.GetLotRequest(Some(bidder), lotId.toString)).futureValue
        snapshot.version shouldBe 4
        snapshot.getTrading.currentPrice shouldBe Some(MoneyMessage(150, "RUB"))
        snapshot.getTrading.leaderId shouldBe Some(bidder.identityId)
        snapshot.nextPrice shouldBe Some(MoneyMessage(160, "RUB"))
      }
      val listed = asHubBot(node.client.listAuctionLots())
        .invoke(wire.ListAuctionLotsRequest(Some(bidder), auction.value.toString))
        .futureValue
      listed.lots.map(_.id) shouldBe Seq(lotId.toString)
      listed.nextPageToken shouldBe ""
    }

    "answers the history of a lot in journal order with a proxy war folded into one entry and no limit" in withNode {
      node =>
        val sale = freshAuction()
        val lotId = tradingLot(node, sale)
        val rival = named(node, sale, "Кот")
        val holder = named(node, sale, "Пёс")
        def limit(who: wire.Viewer, max: Long) =
          asHubBot(node.client.setProxyLimit())
            .invoke(wire.SetProxyLimitRequest(Some(who), lotId.toString, Some(MoneyMessage(max, "RUB")), newId()))
            .futureValue
            .outcome
            .isAccepted shouldBe true
        def history() =
          asHubBot(node.client.listLotHistory())
            .invoke(wire.ListLotHistoryRequest(Some(rival), lotId.toString, "", 2))
            .futureValue
        asHubBot(node.client.placeBid()).invoke(bid(lotId, 150, rival)).futureValue.outcome.isAccepted shouldBe true
        limit(holder, 300)
        // Лимит 250 против 300: война лимитов — одна команда и одно событие с итоговой ценой.
        limit(rival, 250)
        val entries = eventually {
          val first = history()
          first.nextPageToken should not be empty
          val rest = asHubBot(node.client.listLotHistory())
            .invoke(wire.ListLotHistoryRequest(Some(rival), lotId.toString, first.nextPageToken, 2))
            .futureValue
          rest.nextPageToken shouldBe ""
          val all = first.entries ++ rest.entries
          all should have size 3
          all
        }
        val bids = entries.map(_.getBid)
        bids.map(_.participantId) shouldBe Seq(rival.identityId, holder.identityId, holder.identityId)
        bids.map(_.origin.isProxy) shouldBe Seq(false, true, true)
        bids.head.getManual.source shouldBe auction.v1.auction.BidSource.BID_SOURCE_BOT
        val sequences = entries.map(_.sequence)
        sequences shouldBe sequences.sorted
        sequences.distinct should have size 3
        val amounts = bids.flatMap(_.amount).map(_.minorUnits)
        amounts.head shouldBe 150
        amounts(2) should (be > 250L and be <= 300L)
        amounts should not contain 300L
        amounts should not contain 250L
    }

    "answers NOT_FOUND through ListLotHistory for a lot that was never drafted" in withNode { node =>
      statusOf(
        asHubBot(node.client.listLotHistory()).invoke(
          wire.ListLotHistoryRequest(Some(viewer(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)), newId())
        )
      ) shouldBe Status.Code.NOT_FOUND
    }

    "answers NOT_FOUND through GetLot for a lot that was never drafted" in withNode { node =>
      val unknown = UuidV7.generator(Clock.systemUTC())().toString
      statusOf(
        asHubBot(node.client.getLot()).invoke(
          wire.GetLotRequest(Some(viewer(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)), unknown)
        )
      ) shouldBe Status.Code.NOT_FOUND
    }

    "answers a bid below the minimum with the minimum price and leaves the price and the name as they were" in withNode {
      node =>
        val auction = freshAuction()
        val lotId = tradingLot(node, auction)
        val bidder = named(node, auction)
        val refused = asHubBot(node.client.placeBid())
          .invoke(bid(lotId, 105, bidder))
          .futureValue
          .getRefused
        refused.getBidBelowMinimum.minRequired shouldBe Some(MoneyMessage(110, "RUB"))
        currentPrice(node, lotId) shouldBe money(100)
        // Отклонённая ставка имя не замораживает: обещание — «до первой принятой».
        choose(node, bidder, auction, "Пёс").outcome.isAccepted shouldBe true
    }

    "refuses a bid of a participant without a chosen name and leaves the lot untouched" in withNode { node =>
      val auction = freshAuction()
      val lotId = tradingLot(node, auction)
      val stranger = viewer(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)
      // Имя в другом аукционе не в счёт: выбор действует в одном аукционе.
      choose(node, stranger, freshAuction(), "Кот").outcome.isAccepted shouldBe true
      asHubBot(node.client.placeBid())
        .invoke(bid(lotId, 150, stranger))
        .futureValue
        .getRefused
        .reason
        .isDisplayNameNotChosen shouldBe true
      currentPrice(node, lotId) shouldBe money(100)
    }

    "freezes the name after an accepted bid: another name is NameFrozen, the same one succeeds" in withNode { node =>
      val auction = freshAuction()
      val lotId = tradingLot(node, auction)
      val bidder = named(node, auction, "Кот")
      asHubBot(node.client.placeBid()).invoke(bid(lotId, 150, bidder)).futureValue.outcome.isAccepted shouldBe true
      choose(node, bidder, auction, "Пёс").getRefused.reason.isNameFrozen shouldBe true
      choose(node, bidder, auction, "Кот").getAccepted shouldBe
        wire.DisplayName("Кот*", wire.DisplayNameKind.DISPLAY_NAME_KIND_ALIAS)
    }

    "refuses a proxy limit without a chosen name and freezes the name after an accepted one" in withNode { node =>
      val auction = freshAuction()
      val lotId = tradingLot(node, auction)
      def limit(who: wire.Viewer) =
        asHubBot(node.client.setProxyLimit())
          .invoke(wire.SetProxyLimitRequest(Some(who), lotId.toString, Some(MoneyMessage(300, "RUB")), newId()))
          .futureValue
      limit(viewer(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)).getRefused.reason.isDisplayNameNotChosen shouldBe true
      currentPrice(node, lotId) shouldBe money(100)
      val bidder = named(node, auction, "Кот")
      limit(bidder).outcome.isAccepted shouldBe true
      choose(node, bidder, auction, "Пёс").getRefused.reason.isNameFrozen shouldBe true
    }

    "answers every requested participant by name, and one without a choice by a placeholder" in withNode { node =>
      val auction = freshAuction()
      val chosen = named(node, auction, "Кот")
      val silent = viewer(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)
      val names = asHubBot(node.client.getDisplayNames())
        .invoke(
          wire.GetDisplayNamesRequest(Some(silent), auction.value.toString, Seq(chosen.identityId, silent.identityId))
        )
        .futureValue
        .names
      names.keySet shouldBe Set(chosen.identityId, silent.identityId)
      names(chosen.identityId) shouldBe wire.DisplayName("Кот*", wire.DisplayNameKind.DISPLAY_NAME_KIND_ALIAS)
      names(silent.identityId).kind shouldBe wire.DisplayNameKind.DISPLAY_NAME_KIND_PLACEHOLDER
      names(silent.identityId).text shouldBe s"Участник ${silent.identityId.takeRight(4)}"
    }

    "refuses a viewer without the public role and leaves the lot untouched" in withNode { node =>
      val lotId = tradingLot(node)
      val call = asHubBot(node.client.placeBid()).invoke(bid(lotId, 150, viewer(GlobalRoleMessage.GLOBAL_ROLE_MEMBER)))
      statusOf(call) shouldBe Status.Code.PERMISSION_DENIED
      currentPrice(node, lotId) shouldBe money(100)
    }

    "refuses a call without a caller token before the lot is reached" in withNode { node =>
      val lotId = tradingLot(node)
      statusOf(node.client.placeBid(bid(lotId, 150, viewer(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)))) shouldBe
        Status.Code.UNAUTHENTICATED
      currentPrice(node, lotId) shouldBe money(100)
    }

    "answers NOT_FOUND to a bid on a lot that was never drafted" in withNode { node =>
      val unknown = UuidV7.generator(Clock.systemUTC())()
      val call =
        asHubBot(node.client.placeBid()).invoke(bid(unknown, 150, viewer(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)))
      statusOf(call) shouldBe Status.Code.NOT_FOUND
    }

    "creates a lot card for an administrator and answers the stored card" in withNode { node =>
      val admin = viewer(GlobalRoleMessage.GLOBAL_ROLE_ADMIN)
      val lotId = UuidV7.generator(Clock.systemUTC())().toString
      val created = asHubBot(node.client.createLotCard())
        .invoke(wire.CreateLotCardRequest(Some(admin), lotId, "Лот", "описание"))
        .futureValue
      created.getAccepted shouldBe wire.LotCard("Лот", "описание")
      val conflict = asHubBot(node.client.createLotCard())
        .invoke(wire.CreateLotCardRequest(Some(admin), lotId, "Другой", ""))
        .futureValue
      conflict.getRefused.reason.isCardConflict shouldBe true
    }

    "writes a lot image at the limit through the wire and reads the same bytes back with their version" in withNode {
      node =>
        val admin = viewer(GlobalRoleMessage.GLOBAL_ROLE_ADMIN, GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)
        val lotId = tradingLot(node)
        val atLimit = IArray.genericWrapArray(TestImages.jpeg(LotImage.MaxBytes)).toArray
        val created = asHubBot(node.client.createLotCard())
          .invoke(
            wire.CreateLotCardRequest(Some(admin), lotId.toString, "Лот", "", Some(upload(atLimit)))
          )
          .futureValue
        val version = created.getAccepted.image.map(_.version).getOrElse(fail("the card has no image"))

        // Лот виден изображению тогда же, когда GetLot: после того как проекция записала его в read model.
        val read = eventually {
          asHubBot(node.client.getLotImage()).invoke(wire.GetLotImageRequest(Some(admin), lotId.toString)).futureValue
        }
        read.content.toByteArray shouldBe atLimit
        read.mediaType shouldBe "image/jpeg"
        read.version shouldBe version
        asHubBot(node.client.getLot())
          .invoke(wire.GetLotRequest(Some(admin), lotId.toString))
          .futureValue
          .card
          .flatMap(_.image) shouldBe Some(wire.LotImageRef(version))

        // Сразу за пределом и крупнее умолчания pekko-http в 8 MiB: оба получают именованный отказ, а не сбой транспорта.
        for (size <- Seq(LotImage.MaxBytes + 1, 12 * 1024 * 1024)) {
          val oversized = IArray.genericWrapArray(TestImages.jpeg(size)).toArray
          val refused = asHubBot(node.client.editLotCard())
            .invoke(wire.EditLotCardRequest(Some(admin), lotId.toString, "Лот", "").withReplaceImage(upload(oversized)))
            .futureValue
          refused.getRefused.reason.imageTooLarge shouldBe Some(wire.ImageTooLarge(LotImage.MaxBytes.toLong))
        }

        val replaced = asHubBot(node.client.editLotCard())
          .invoke(
            wire
              .EditLotCardRequest(Some(admin), lotId.toString, "Лот", "")
              .withReplaceImage(upload(IArray.genericWrapArray(TestImages.png()).toArray))
          )
          .futureValue
        val reread =
          asHubBot(node.client.getLotImage()).invoke(wire.GetLotImageRequest(Some(admin), lotId.toString)).futureValue
        reread.mediaType shouldBe "image/png"
        reread.version should not be version
        Some(reread.version) shouldBe replaced.getAccepted.image.map(_.version)
    }

    "answers NOT_FOUND through GetLotImage for a lot without an image and for one the read model does not hold" in
      withNode { node =>
        val reader = viewer(GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)
        val bare = tradingLot(node)
        eventually {
          asHubBot(node.client.getLot()).invoke(wire.GetLotRequest(Some(reader), bare.toString)).futureValue
        }
        statusOf(
          asHubBot(node.client.getLotImage()).invoke(wire.GetLotImageRequest(Some(reader), bare.toString))
        ) shouldBe Status.Code.NOT_FOUND
        // Карточка с изображением есть, а лота в read model нет: изображение не видно, как и лот.
        val cardOnly = UuidV7.generator(Clock.systemUTC())().toString
        val admin = viewer(GlobalRoleMessage.GLOBAL_ROLE_ADMIN, GlobalRoleMessage.GLOBAL_ROLE_PUBLIC)
        asHubBot(node.client.createLotCard())
          .invoke(
            wire.CreateLotCardRequest(
              Some(admin),
              cardOnly,
              "Лот",
              "",
              Some(upload(IArray.genericWrapArray(TestImages.jpeg()).toArray))
            )
          )
          .futureValue
          .outcome
          .isAccepted shouldBe true
        statusOf(
          asHubBot(node.client.getLotImage()).invoke(wire.GetLotImageRequest(Some(reader), cardOnly))
        ) shouldBe Status.Code.NOT_FOUND
      }
  }

  private def upload(bytes: Array[Byte]): wire.LotImageUpload = wire.LotImageUpload(ByteString.copyFrom(bytes))
}
