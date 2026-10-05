package auction.volley

import auction.persistence.DatabaseSettings
import auction.testkit.MeetupsStub
import auction.testkit.PostgresFixture
import auction.testkit.ServiceProcess
import auction.v1.auction.AntiSnipe as AntiSnipeMessage
import auction.v1.auction.AuctionConfig as AuctionConfigMessage
import auction.v1.auction.ClosingByDeadline
import auction.v1.auction.ClosingPolicy as ClosingPolicyMessage
import auction.v1.auction.LotDefaults as LotDefaultsMessage
import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction.OnlinePhase as OnlinePhaseMessage
import auction.v1.auction.StepPolicy as StepPolicyMessage
import auction.v1.auction_service as wire
import com.google.protobuf.descriptor.FieldDescriptorProto
import com.typesafe.config.ConfigFactory
import identity.v1.roles.GlobalRole as GlobalRoleMessage
import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.grpc.GrpcClientSettings
import org.apache.pekko.stream.Materializer
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.Millis
import org.scalatest.time.Seconds
import org.scalatest.time.Span
import org.scalatest.wordspec.AnyWordSpec
import scalapb.descriptors.Descriptor

import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import scala.concurrent.ExecutionContext
import scala.concurrent.duration.*
import scala.util.Random
import scala.util.Using

/**
 * Рестарт под залпом (PER-332, ступень S3 RFC-007): сервис — отдельный процесс `java auction.Main`, как в узле Aspire,
 * и весь путь от аукциона до закрытия лота идёт через его gRPC. Процесс убивается посреди залпа без штатной остановки и
 * поднимается заново на той же базе; после подъёма принятые исходы сверяются с журналом, журнал — с ответами чтения,
 * повтор залпа с теми же `op_id` проверяется на дописку, а лот закрывается таймером аукциона уже в новом процессе.
 *
 * Сверка идёт по свёртке журнала [[LotLedger]], которая не делит кода с ядром лота. Meetups — заглушка в JVM теста,
 * которая подтверждает право одному администратору.
 */
final class LotVolleyRestartIntegrationSpec
    extends AnyWordSpec
    with Matchers
    with PostgresFixture
    with ScalaFutures
    with Eventually {

  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(60, Seconds), interval = Span(200, Millis))

  // Узел теста — только клиент и заглушка Meetups: кластер ему не нужен.
  private val kit = ActorTestKit(
    "volley",
    ConfigFactory.parseString("pekko.actor.provider = local").withFallback(ConfigFactory.load())
  )
  private given system: ActorSystem[?] = kit.system
  private given ExecutionContext = system.executionContext
  private given Materializer = Materializer(system)

  override protected def afterAll(): Unit =
    try kit.shutdownTestKit()
    finally super.afterAll()

  private val hubToken = "volley-hub"
  private val auctionToken = "volley-auction"
  private val ownToken = "volley-own"

  private val administrator = Volley.uuidV7(Random(1), 1_700_000_000_000L).toString
  private val adminViewer = wire.Viewer(administrator, Seq(GlobalRoleMessage.GLOBAL_ROLE_ADMIN))

  private val currency = "RUB"
  private val start = 100_000L
  private val step = 1_000L

  "a lot under a volley of equal bids" should {

    "keeps exactly one leader, and every other bid is refused below the minimum (P-18)" in {
      val database = freshDatabase()
      val meetups = MeetupsStub.start(administrator)
      val service = launch(database, meetups, "equal")
      try {
        val client = clientOf(service)
        val lot = newId()
        val volley = Volley.equal(seed = 18, lot, amount = start + 5 * step, bidders = 120)
        val auction = draftAuction(client, Seq(lot))
        name(client, auction, volley.map(_.participant))
        startTrading(client, auction, Seq(lot), closesAt = Instant.now().plusSeconds(86_400))

        val fired = runner(client).fire(volley, parallelism = 32)().futureValue

        val accepted = fired.filter(_.outcome.isInstanceOf[Outcome.Accepted])
        accepted should have size 1
        fired.map(_.outcome).filterNot(_.isInstanceOf[Outcome.Accepted]).distinct shouldBe
          Vector(Outcome.Refused("BidBelowMinimum"))
        val ledger = LotLedger.fold(journal(database, lot))
        ledger.bids should have size 1
        ledger.leader shouldBe Some(accepted.head.shot.participant)
        eventually {
          snapshot(client, lot, volley.head.participant).getTrading.leaderId shouldBe
            Some(accepted.head.shot.participant.toString)
        }
      } finally {
        service.stop()
        meetups.stop()
      }
    }
  }

  "a lot whose service is killed mid-volley" should {

    "is killed while commands of the volley are still unanswered" in {
      withClue(s"outcomes before the kill: ${histogram(restart.fired)}") {
        restart.acceptedBefore.size should be >= KillAfter
        // Иначе тест проверял бы штатную остановку, а не убийство посреди записи.
        restart.fired.count(_.outcome.isInstanceOf[Outcome.Failed]) should be > 0
      }
    }

    "answers every command accepted before the kill with the same outcome after the restart" in {
      restart.replayed.values.collect { case Outcome.Failed(code) => code } shouldBe empty
      restart.acceptedBefore.foreach((shot, bidId) => restart.replayed(shot) shouldBe Outcome.Accepted(bidId))
    }

    "holds every command accepted before the kill in the journal before any replay, with its participant, amount and bid" in {
      restart.acceptedBefore.foreach { (shot, bidId) =>
        val own = restart.afterRestart.own(shot.opId)
        own should have size 1
        shot match {
          case Shot.Bid(participant, _, amount, _) =>
            val placed = own.head.get("bidPlaced")
            placed.get("participant").asText shouldBe participant.toString
            placed.get("amount").get("minorUnits").asLong shouldBe amount
            bidId shouldBe Some(placed.get("bidId").asText)
          case Shot.Limit(participant, _, max, _) =>
            val set = own.head.get("proxyLimitSet")
            set.get("participant").asText shouldBe participant.toString
            set.get("max").get("minorUnits").asLong shouldBe max
        }
      }
      restart.volley.foreach(shot => restart.afterReplay.own(shot.opId).size should be <= 1)
    }

    "writes no journal row on a replay of the whole volley with the same op_ids" in {
      restart.again.values.collect { case Outcome.Failed(code) => code } shouldBe empty
      // Отказ не запоминается и оценивается заново: его причина могла смениться, если лот успел закрыться, — но
      // принятым он не становится, а принятые отвечают исходным ответом.
      restart.again.filter(_._2.isInstanceOf[Outcome.Accepted]) shouldBe
        restart.replayed.filter(_._2.isInstanceOf[Outcome.Accepted])
      restart.rowsAfterAgain shouldBe restart.rowsAfterReplay
    }

    "reads price, leader, deadline, extensions and proxy limits as the journal holds them" in {
      val reads = restart.reads.getOrElse(fail("the lot closed before the reads were compared: widen closesAt"))
      // Предусловия: залп продлевал дедлайн и будил прокси, иначе их восстановление не проверено.
      reads.ledger.extensionsUsed should be > 0
      reads.ledger.bids.exists(_.proxy) shouldBe true
      reads.ledger.limits should not be empty
      val trading = reads.lot
      trading.version shouldBe reads.ledger.maxSequence
      trading.getTrading.currentPrice shouldBe reads.ledger.price.map(MoneyMessage(_, currency))
      trading.getTrading.leaderId shouldBe reads.ledger.leader.map(_.toString)
      trading.getTrading.leadingBidId shouldBe reads.ledger.leadingBidId.map(_.toString)
      trading.getTrading.deadline shouldBe reads.ledger.deadline.map(_.toString)
      trading.getTrading.extensionsUsed shouldBe reads.ledger.extensionsUsed
      reads.limits shouldBe reads.ledger.limits.map((participant, max) =>
        participant -> Some(MoneyMessage(max, currency))
      )
    }

    "closes the lot in the restarted process to the leader and price of the journal (ПП-1, ПП-2)" in {
      val before = restart.beforeClose
      restart.sale shouldBe LedgerSale(
        before.leader.getOrElse(fail("no leader")),
        before.price.getOrElse(fail("no price")),
        before.leadingBidId.getOrElse(fail("no leading bid"))
      )
      restart.sold.winnerId shouldBe restart.sale.winner.toString
      restart.sold.price shouldBe Some(MoneyMessage(restart.sale.price, currency))
      restart.sold.bidId shouldBe restart.sale.bidId.toString
    }

    "carries no fraction from the journal and the read model to the grpc schema (ПП-5)" in {
      // Пустой вход прошёл бы проверку молча: строки и колонки обязаны найтись.
      restart.lotJournal should not be empty
      restart.auctionJournal should not be empty
      restart.columns.get("lot_bid.minor_units") shouldBe Some("bigint")
      restart.lotJournal.flatMap(row => LotLedger.fractional(row.payload)) shouldBe empty
      restart.auctionJournal.flatMap(row => LotLedger.fractional(row.payload)) shouldBe empty
      LotLedger.fractional(restart.lotView) shouldBe empty
      restart.columns.filter((_, kind) => Set("real", "double precision", "numeric").contains(kind)) shouldBe empty
      floatingFields shouldBe empty
    }
  }

  "the volley oracle" should {

    "detects a journal that lost an accepted bid and a fraction in a payload" in {
      val rows = Vector(
        JournalRow(
          1,
          row("LotOpened", """"lotOpened":{"startingPrice":{"minorUnits":100,"currency":"RUB"},"deadline":null}""")
        ),
        JournalRow(2, row("BidPlaced", bidPlaced("11111111-1111-7111-8111-111111111111", 200))),
        JournalRow(3, row("BidPlaced", bidPlaced("22222222-2222-7222-8222-222222222222", 300)))
      )
      LotLedger.fold(rows).price shouldBe Some(300)
      LotLedger.fold(rows.take(2)).price shouldBe Some(200)
      LotLedger.fold(rows.take(2)).leader should not be LotLedger.fold(rows).leader
      LotLedger.fractional("""{"amount":{"minorUnits":1.5}}""") should have size 1
      LotLedger.fractional("""{"amount":{"minorUnits":1e3}}""") should have size 1
      LotLedger.fractional("""{"amount":{"minorUnits":15}}""") shouldBe empty
    }
  }

  /**
   * Убийство — по счёту принятых ответов, а не по времени. Порог мал по сравнению с залпом: так в момент убийства в
   * полёте остаётся всё окно параллельных команд, а не его хвост.
   */
  private val KillAfter = 10

  /** Чтение после подъёма: снимок лота, свёртка журнала той же версии и лимит каждого участника его глазами. */
  private final case class Reads(ledger: LotLedger, lot: wire.LotSnapshot, limits: Map[UUID, Option[MoneyMessage]])

  /**
   * Наблюдения одного прогона с убийством. Сценарий дорог — два старта JVM и ожидание дедлайна, — и тесты делят его.
   */
  private final case class Restart(
      volley: Vector[Shot],
      fired: Vector[Fired],
      acceptedBefore: Map[Shot, Option[String]],
      afterRestart: LotLedger,
      replayed: Map[Shot, Outcome],
      afterReplay: LotLedger,
      rowsAfterReplay: Int,
      again: Map[Shot, Outcome],
      rowsAfterAgain: Int,
      reads: Option[Reads],
      beforeClose: LotLedger,
      sale: LedgerSale,
      sold: auction.v1.auction.LotSale,
      lotJournal: Vector[JournalRow],
      auctionJournal: Vector[JournalRow],
      lotView: String,
      columns: Map[String, String]
  )

  /**
   * Сценарий: аукцион и залп через gRPC первого процесса, убийство посреди залпа, подъём второго процесса на той же
   * базе, два повтора залпа, чтение и закрытие лота таймером аукциона уже во втором процессе. Окно анти-снайпа шире
   * всего прогона: продлевает каждая принятая команда, пока не кончится лимит.
   */
  private lazy val restart: Restart = {
    val database = freshDatabase()
    val meetups = MeetupsStub.start(administrator)
    val first = launch(database, meetups, "before-kill")
    var second: Option[ServiceProcess] = None
    try {
      val client = clientOf(first)
      val lot = newId()
      val volley = Volley.mixed(seed = 332, lot, start, step, bidders = 120, proxies = 12)
      val auction = draftAuction(client, Seq(lot))
      name(client, auction, volley.map(_.participant))
      startTrading(client, auction, Seq(lot), Instant.now().plusSeconds(90), AntiSnipeMessage(3_600, 2, 5))

      val beforeKill = runner(client)
      val killed = AtomicBoolean(false)
      val fired = beforeKill
        .fire(volley, parallelism = 32) { (_, accepted) =>
          if (accepted == KillAfter && killed.compareAndSet(false, true)) {
            beforeKill.stop()
            first.kill()
          }
        }
        .futureValue
      // Без убийства продолжать нельзя: второй процесс встал бы рядом с живым первым на одной базе.
      if (!killed.get) fail(s"the volley ended before the kill, outcomes: ${histogram(fired)}")

      val restarted = launch(database, meetups, "after-kill")
      second = Some(restarted)
      val revived = clientOf(restarted)
      // Журнал до любого повтора: повтор дописал бы потерянную команду заново, и потеря стала бы невидимой.
      val afterRestart = LotLedger.fold(journal(database, lot))

      // Первый повтор разрешает команды без ответа: каждая либо уже в журнале и возвращает исходный ответ, либо
      // применяется сейчас один раз. Второй повтор идёт, когда ответ получила каждая.
      val replayed = runner(revived).fire(volley, parallelism = 32)().futureValue.map(f => f.shot -> f.outcome).toMap
      val afterReplay = LotLedger.fold(journal(database, lot))
      val again = runner(revived).fire(volley, parallelism = 32)().futureValue.map(f => f.shot -> f.outcome).toMap
      val afterAgain = LotLedger.fold(journal(database, lot))

      val reads =
        try
          Some(eventually {
            val ledger = LotLedger.fold(journal(database, lot))
            if (ledger.sale.nonEmpty) throw ClosedBeforeReads
            val read = snapshot(revived, lot, volley.head.participant)
            read.version shouldBe ledger.maxSequence
            Reads(ledger, read, ledger.limits.keySet.map(p => p -> snapshot(revived, lot, p).viewerProxyLimit).toMap)
          })
        catch { case ClosedBeforeReads => None }

      val beforeClose = LotLedger.fold(journal(database, lot))
      val closing = Duration.between(Instant.now(), beforeClose.deadline.getOrElse(fail("the lot has no deadline")))
      val sale = eventually(timeout(Span(closing.getSeconds.max(0) + 60, Seconds))) {
        LotLedger.fold(journal(database, lot)).sale.getOrElse(fail("the lot is not sold yet"))
      }
      val sold = eventually {
        val read = snapshot(revived, lot, volley.head.participant)
        read.status.isSold shouldBe true
        read.getSold
      }
      Restart(
        volley,
        fired,
        fired.collect { case Fired(shot, Outcome.Accepted(bidId)) => shot -> bidId }.toMap,
        afterRestart,
        replayed,
        afterReplay,
        afterReplay.trading,
        again,
        afterAgain.trading,
        reads,
        beforeClose,
        sale,
        sold,
        journal(database, lot),
        journal(database, auction, "auction"),
        lotView(database, lot),
        columns(database)
      )
    } finally {
      second.foreach(_.stop())
      first.stop()
      meetups.stop()
    }
  }

  /** Лот закрылся раньше, чем чтение догнало журнал: сверять торги уже не с чем. */
  private object ClosedBeforeReads extends RuntimeException("the lot closed before the reads were compared")

  /** Исходы залпа по виду — их несёт провал, чтобы было видно, на чём залп остановился. */
  private def histogram(fired: Seq[Fired]): Map[String, Int] =
    fired.groupMapReduce(_.outcome match {
      case Outcome.Accepted(_) => "Accepted"
      case Outcome.Refused(reason) => reason
      case Outcome.Failed(code) => code.toString
      case Outcome.NotSent => "NotSent"
    })(_ => 1)(_ + _)

  private def row(kind: String, section: String): String =
    s"""{"opId":"${newId()}","event":{"kind":"$kind",$section}}"""

  private def bidPlaced(participant: String, amount: Long): String =
    s""""bidPlaced":{"bidId":"${newId()}","participant":"$participant","amount":{"minorUnits":$amount,"currency":"RUB"},"origin":"Manual"}"""

  /** Сервис отдельным процессом на базе теста: токены вызывающих, свой токен и адрес заглушки Meetups. */
  private def launch(database: DatabaseSettings, meetups: MeetupsStub, name: String): ServiceProcess = {
    val process = ServiceProcess.start(
      Map(
        "AUCTION_DATABASE_JDBC_URL" -> database.url,
        "AUCTION_DATABASE_USER" -> database.user,
        "AUCTION_DATABASE_PASSWORD" -> database.password,
        "AUCTION_CALLER_TOKEN_HUB_BOT" -> hubToken,
        "AUCTION_CALLER_TOKEN_AUCTION_BOT" -> auctionToken,
        "AUCTION_MEETUPS_GRPC_URL" -> meetups.url,
        "AUCTION_SERVICE_TOKEN" -> ownToken
      ),
      ServiceProcess.logOf(s"${getClass.getSimpleName}-$name-${UUID.randomUUID()}")
    )
    process.awaitReady(Duration.ofMinutes(2))
    process
  }

  private def clientOf(service: ServiceProcess): wire.AuctionServiceClient =
    wire.AuctionServiceClient(
      // Срок вызова: без него команда, ушедшая в убитый процесс, ждала бы переподключения клиента без конца.
      GrpcClientSettings.connectToServiceAt("127.0.0.1", service.grpcPort).withTls(false).withDeadline(10.seconds)
    )

  private def runner(client: wire.AuctionServiceClient): VolleyRunner =
    VolleyRunner(client, hubToken, currency)

  private def asHub[Req, Res](
      builder: org.apache.pekko.grpc.scaladsl.SingleResponseRequestBuilder[Req, Res]
  ): org.apache.pekko.grpc.scaladsl.SingleResponseRequestBuilder[Req, Res] =
    builder.addHeader("authorization", s"Bearer $hubToken")

  private def newId(): UUID = Volley.uuidV7(Random(), System.currentTimeMillis())

  /** Онлайн-неделя до `closesAt`, которая закрывает лоты общим дедлайном; лоты — рубли, шаг фиксированный. */
  private def config(closesAt: Instant, antiSnipe: AntiSnipeMessage = AntiSnipeMessage(120, 120, 3)) =
    AuctionConfigMessage(
      Some(OnlinePhaseMessage(Instant.now().minusSeconds(60).toString, Some(closesAt.toString), closesLots = true)),
      0,
      Some(ClosingPolicyMessage().withByDeadline(ClosingByDeadline())),
      Some(
        LotDefaultsMessage(
          currency,
          Some(StepPolicyMessage().withFixed(MoneyMessage(step, currency))),
          Some(antiSnipe),
          proxyEnabled = true
        )
      )
    )

  /** Аукцион у сходки с лотами в реестре: рождение и `AddLot` через gRPC. */
  private def draftAuction(client: wire.AuctionServiceClient, lots: Seq[UUID]): String = {
    val auction = asHub(client.draftAuction())
      .invoke(wire.DraftAuctionRequest(Some(adminViewer), newId().toString, newId().toString))
      .futureValue
      .getAccepted
      .auctionId
    lots.foreach { lot =>
      asHub(client.addLot())
        .invoke(wire.AddLotRequest(Some(adminViewer), auction, lot.toString, newId().toString))
        .futureValue
        .outcome
        .isAccepted shouldBe true
    }
    auction
  }

  /**
   * Планирование, условия лотов и старт онлайн-торгов через gRPC. Идёт после имён участников: отсчёт до дедлайна
   * начинается здесь. Лоты аукцион открывает после ответа, поэтому готовность — лот в торгах в чтении.
   */
  private def startTrading(
      client: wire.AuctionServiceClient,
      auction: String,
      lots: Seq[UUID],
      closesAt: Instant,
      antiSnipe: AntiSnipeMessage = AntiSnipeMessage(120, 120, 3)
  ): Unit = {
    asHub(client.scheduleAuction())
      .invoke(
        wire.ScheduleAuctionRequest(Some(adminViewer), auction, newId().toString, Some(config(closesAt, antiSnipe)))
      )
      .futureValue
      .outcome
      .isAccepted shouldBe true
    lots.foreach { lot =>
      asHub(client.scheduleLot())
        .invoke(
          wire.ScheduleLotRequest(
            Some(adminViewer),
            auction,
            lot.toString,
            newId().toString,
            Some(MoneyMessage(start, currency)),
            Some(StepPolicyMessage().withFixed(MoneyMessage(step, currency)))
          )
        )
        .futureValue
        .outcome
        .isAccepted shouldBe true
    }
    asHub(client.startPrebidding())
      .invoke(wire.StartPrebiddingRequest(Some(adminViewer), auction, newId().toString))
      .futureValue
      .outcome
      .isAccepted shouldBe true
    val reader = newId()
    lots.foreach(lot => eventually(snapshot(client, lot, reader).status.isTrading shouldBe true))
  }

  /** Имя в аукционе каждому участнику: без него ставка до лота не доходит (ADR-059). */
  private def name(client: wire.AuctionServiceClient, auction: String, participants: Seq[UUID]): Unit =
    participants.distinct.zipWithIndex.foreach { (participant, index) =>
      asHub(client.chooseDisplayName())
        .invoke(wire.ChooseDisplayNameRequest(Some(Volley.viewer(participant)), auction).withAlias(s"Bidder$index"))
        .futureValue
        .outcome
        .isAccepted shouldBe true
    }

  private def snapshot(client: wire.AuctionServiceClient, lot: UUID, reader: UUID): wire.LotSnapshot =
    asHub(client.getLot()).invoke(wire.GetLotRequest(Some(Volley.viewer(reader)), lot.toString)).futureValue

  private def journal(database: DatabaseSettings, id: UUID): Vector[JournalRow] = journal(database, id.toString, "lot")

  private def journal(database: DatabaseSettings, id: String, kind: String): Vector[JournalRow] =
    withConnection(database) { connection =>
      Using.resource(
        connection.prepareStatement(
          """SELECT sequence_number, convert_from(event_payload, 'UTF8') FROM event_journal
            |WHERE persistence_id = ? ORDER BY sequence_number""".stripMargin
        )
      ) { statement =>
        statement.setString(1, s"$kind|$id")
        Using.resource(statement.executeQuery()) { rows =>
          Iterator.continually(rows).takeWhile(_.next()).map(r => JournalRow(r.getLong(1), r.getString(2))).toVector
        }
      }
    }

  private def lotView(database: DatabaseSettings, lot: UUID): String =
    withConnection(database) { connection =>
      Using.resource(connection.prepareStatement("SELECT state::text FROM lot_view WHERE lot_id = ?::uuid")) {
        statement =>
          statement.setString(1, lot.toString)
          Using.resource(statement.executeQuery())(rows =>
            if (rows.next()) rows.getString(1) else fail("no lot_view row")
          )
      }
    }

  /** Колонки схемы сервиса с их типом: `таблица.колонка` → `data_type`. */
  private def columns(database: DatabaseSettings): Map[String, String] =
    withConnection(database) { connection =>
      Using.resource(
        connection.prepareStatement(
          """SELECT table_name || '.' || column_name, data_type FROM information_schema.columns
            |WHERE table_schema = 'public'""".stripMargin
        )
      ) { statement =>
        Using.resource(statement.executeQuery()) { rows =>
          Iterator.continually(rows).takeWhile(_.next()).map(r => r.getString(1) -> r.getString(2)).toMap
        }
      }
    }

  /**
   * Поля `float` и `double` в схемах домена аукциона: сервис, значения и события. Импорт Identity несёт только роли и
   * сумм не знает.
   */
  private def floatingFields: Set[String] = {
    def messages(message: Descriptor): Vector[Descriptor] = message +: message.nestedMessages.flatMap(messages)
    val files = Seq(
      wire.AuctionServiceProto.scalaDescriptor,
      auction.v1.auction.AuctionProto.scalaDescriptor,
      auction.v1.auction_events.AuctionEventsProto.scalaDescriptor
    )
    files.flatMap(_.messages.flatMap(messages)).toSet.flatMap { message =>
      message.fields.collect {
        case field
            if field.protoType == FieldDescriptorProto.Type.TYPE_DOUBLE ||
              field.protoType == FieldDescriptorProto.Type.TYPE_FLOAT =>
          s"${message.fullName}.${field.name}"
      }
    }
  }
}
