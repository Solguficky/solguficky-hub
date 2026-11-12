package auction.screen.load

import auction.testkit.StallingProxy
import auction.v1.auction.AntiSnipe as AntiSnipeMessage
import auction.v1.auction.AuctionConfig as AuctionConfigMessage
import auction.v1.auction.ClosingByDeadline
import auction.v1.auction.ClosingPolicy as ClosingPolicyMessage
import auction.v1.auction.LotDefaults as LotDefaultsMessage
import auction.v1.auction.Money as MoneyMessage
import auction.v1.auction.OnlinePhase as OnlinePhaseMessage
import auction.v1.auction.StepPolicy as StepPolicyMessage
import auction.v1.auction_service as wire
import auction.volley.Outcome
import auction.volley.Shot
import auction.volley.Volley
import auction.volley.VolleyRunner
import com.typesafe.config.ConfigFactory
import identity.v1.access.AccessRight as AccessRightMessage
import io.grpc.Status
import io.grpc.StatusRuntimeException
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.grpc.GrpcClientSettings
import org.apache.pekko.grpc.scaladsl.SingleResponseRequestBuilder
import org.apache.pekko.http.scaladsl.model.Uri

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Paths
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import scala.annotation.tailrec
import scala.concurrent.Await
import scala.concurrent.ExecutionContext
import scala.concurrent.Future
import scala.concurrent.duration.*
import scala.jdk.CollectionConverters.*
import scala.util.Failure
import scala.util.Success
import scala.util.Try
import scala.util.control.NonFatal

/**
 * Прогон экрана зала под залпом ставок (PER-486, ADR-040 «Задержка и проверка»): лёгкие зрители потока, настоящие
 * страницы в Chromium и ставки генератором `auction.volley` с заданной частотой. Задержка — от отправки `PlaceBid` и от
 * его ответа до момента, когда зритель применил цену не ниже ставки, по часам этой машины. Запуск, переменные и форма
 * записи — `docs/services/auction-screen-load.md`, рецепт `just auction-screen-load`.
 *
 * Это инструмент, а не тест: в `verify`, `test-all` и CI он не входит. Стенд `local` поднимает всё сам и нужен Docker;
 * стенд `remote` идёт против развёрнутого сервиса по адресам и токену вызывающего из окружения.
 */
object ScreenLoad {

  /**
   * Своя система акторов инструмента — локальная: на classpath тестов лежит `application.conf` сервиса, и без этого
   * клиент прогона встал бы узлом кластера Auction.
   */
  private val ToolConfig = ConfigFactory.parseString("pekko.actor.provider = local").withFallback(ConfigFactory.load())

  def main(args: Array[String]): Unit = {
    val settings = Settings.fromEnv(sys.env)
    given system: ActorSystem[Nothing] = ActorSystem(Behaviors.empty, "screen-load", ToolConfig)
    given ExecutionContext = system.executionContext
    var stand = Option.empty[LocalStand]
    // Playwright, пулы gRPC и Testcontainers держат недемонические потоки: процесс прогона заканчивается явным выходом
    // и на отказе тоже, иначе упавший прогон висел бы без кода возврата.
    val code =
      try {
        stand = if (settings.local) Some(LocalStand.start(settings.maxStreams)) else None
        val report = Run(settings, stand).execute()
        val path = Paths.get(settings.reportPath).toAbsolutePath
        Files.createDirectories(path.getParent)
        Files.writeString(path, report, StandardCharsets.UTF_8)
        println(report)
        println(s"Отчёт записан: $path")
        0
      } catch {
        case NonFatal(failure) =>
          failure.printStackTrace()
          1
      } finally {
        stand.foreach(_.close())
        system.terminate()
      }
    sys.exit(code)
  }

  /** Сценарии прогона. Каждый — отдельный запуск, чтобы числа одного не смешивались с отказами другого. */
  enum Scenario {

    /** Зрители и залп; две пробные страницы — обрыв сети (только `local`) и заморозка вкладки. */
    case Load

    /** Тот же залп без единого зрителя — базовая линия приёма ставок. */
    case Baseline

    /** Зрители и залп, посреди залпа — убийство и подъём Auction (только `local`). */
    case Restart

    /** Предел потоков занят лёгкими зрителями, страницы получают отказ и повторяют; посреди залпа половина уходит. */
    case Limit

    /** Зрители без ставок дольше таймаута бездействия публичного входа: держит ли heartbeat поток. */
    case Idle
  }

  final case class Settings(
      scenario: Scenario,
      local: Boolean,
      grpc: Uri,
      screen: Uri,
      token: String,
      auction: Option[String],
      lot: Option[String],
      step: Long,
      currency: String,
      viewers: Int,
      pages: Int,
      slow: Int,
      bids: Int,
      rate: Double,
      idle: FiniteDuration,
      maxStreams: Int,
      seed: Long,
      reportPath: String
  )

  object Settings {

    def fromEnv(env: Map[String, String]): Settings = {
      def text(key: String, default: => String): String = env.get(key).filter(_.nonEmpty).getOrElse(default)
      def required(key: String): String = env.get(key).filter(_.nonEmpty).getOrElse(sys.error(s"$key is not set"))
      def number(key: String, default: Long): Long =
        env
          .get(key)
          .filter(_.nonEmpty)
          .map(v => v.toLongOption.getOrElse(sys.error(s"$key is not a number: $v")))
          .getOrElse(default)
      val scenario = Scenario.values
        .find(_.toString.equalsIgnoreCase(text("SCREEN_LOAD_SCENARIO", "load")))
        .getOrElse(sys.error(s"SCREEN_LOAD_SCENARIO is one of ${Scenario.values.mkString(", ")}"))
      val local = text("SCREEN_LOAD_STAND", "local") match {
        case "local" => true
        case "remote" => false
        case other => sys.error(s"SCREEN_LOAD_STAND is local or remote, not $other")
      }
      if (!local && (scenario == Scenario.Restart || scenario == Scenario.Limit))
        sys.error(s"scenario $scenario needs the local stand: it kills the service or sets its stream limit")
      val audience = scenario != Scenario.Baseline
      val viewers = if (audience) number("SCREEN_LOAD_VIEWERS", 90).toInt else 0
      val stamp = Instant.now().toString.replace(':', '-')
      Settings(
        scenario,
        local,
        if (local) Uri("http://127.0.0.1") else Uri(required("SCREEN_LOAD_GRPC_URL")),
        if (local) Uri("http://127.0.0.1") else Uri(required("SCREEN_LOAD_SCREEN_URL")),
        if (local) LocalStand.HubToken else required("SCREEN_LOAD_TOKEN"),
        if (local) None else Some(required("SCREEN_LOAD_AUCTION")),
        if (local) None else Some(required("SCREEN_LOAD_LOT")),
        if (local) 10_000 else number("SCREEN_LOAD_STEP", -1).ensuring(_ > 0, "SCREEN_LOAD_STEP is not set"),
        text("SCREEN_LOAD_CURRENCY", "RUB"),
        viewers,
        if (audience) number("SCREEN_LOAD_PAGES", 10).toInt else 0,
        if (scenario == Scenario.Load) number("SCREEN_LOAD_SLOW", 5).toInt else 0,
        if (scenario == Scenario.Idle) 0 else number("SCREEN_LOAD_BIDS", 200).toInt,
        text("SCREEN_LOAD_RATE", "5").toDoubleOption
          .filter(_ > 0)
          .getOrElse(sys.error("SCREEN_LOAD_RATE is a positive number")),
        number("SCREEN_LOAD_IDLE", if (scenario == Scenario.Idle) 130 else 0).seconds,
        // Предел сценария Limit — ровно лёгкие зрители: страницам места не остаётся, пока часть из них не уйдёт.
        if (scenario == Scenario.Limit) viewers else number("SCREEN_LOAD_MAX_STREAMS", 500).toInt,
        // Повтор залпа с тем же seed — те же участники и `op_id`, и лот отвечает исходными ответами, не двигая цену:
        // второй прогон на том же лоте stage зачёл бы ставки, которых не было. Поэтому seed по умолчанию — от часов.
        number("SCREEN_LOAD_SEED", System.currentTimeMillis()),
        text("SCREEN_LOAD_REPORT", s"target/screen-load/${scenario.toString.toLowerCase}-$stamp.md")
      )
    }
  }

  /** Один прогон: подготовка аукциона, зрители, залп по сценарию, сбор наблюдений и отчёт. */
  private final class Run(settings: Settings, stand: Option[LocalStand])(using
      system: ActorSystem[Nothing],
      ec: ExecutionContext
  ) {

    private val grpcPort = stand.fold(settings.grpc.effectivePort)(_.grpcPort)
    private val screen = ScreenTarget(stand.fold(settings.screen)(s => Uri(s"http://127.0.0.1:${s.httpPort}")))

    private val client = wire.AuctionServiceClient(
      GrpcClientSettings
        .connectToServiceAt(settings.grpc.authority.host.address, grpcPort)
        .withTls(settings.grpc.scheme == "https")
        .withDeadline(10.seconds)
    )

    private val admin =
      wire.Viewer(LocalStand.Administrator, rights = Seq(AccessRightMessage.ACCESS_RIGHT_RUN_AUCTIONS))

    private def await[A](future: Future[A]): A = Await.result(future, 30.seconds)

    private def asCaller[Req, Res](
        builder: SingleResponseRequestBuilder[Req, Res]
    ): SingleResponseRequestBuilder[Req, Res] =
      builder.addHeader("authorization", s"Bearer ${settings.token}")

    private def newId(): String = LocalStand.newId().toString

    def execute(): String = {
      val (auction, lot) = (settings.auction, settings.lot) match {
        case (Some(a), Some(l)) => (a, l)
        case _ => trading()
      }
      val shots = Volley.ladder(settings.seed, UUID.fromString(lot), nextPrice(lot), settings.step, settings.bids)
      chooseNames(auction, shots.map(_.participant))
      new Observation(auction, lot, shots, price(lot)).run()
    }

    /**
     * Аукцион локального стенда в живом финале с одним лотом: экран показывает цену только у активного лота финала
     * (ADR-040, дополнение 2026-10-19), а в онлайн-торгах — фазу `upcoming` без цены. Путь — gRPC, как у L1 рестарта
     * под залпом: рождение, планирование с финалом, онлайн-торги в 20 секунд, выбор финалиста, общий дедлайн, заморозка
     * состава, старт финала и выход лота.
     */
    private def trading(): (String, String) = {
      val lot = newId()
      val closesAt = Instant.now().plusSeconds(20)
      // Первый вызов Meetups у только что поднятого сервиса может не дождаться ответа: UNAVAILABLE до готовности.
      val auction = untilAvailable(
        asCaller(client.draftAuction()).invoke(wire.DraftAuctionRequest(Some(admin), newId(), newId()))
      ).getAccepted.auctionId
      accepted(
        "AddLot",
        await(
          asCaller(client.addLot()).invoke(wire.AddLotRequest(Some(admin), auction, lot, newId()))
        ).outcome.isAccepted
      )
      val config = AuctionConfigMessage(
        Some(
          OnlinePhaseMessage(
            Instant.now().minusSeconds(60).toString,
            Some(closesAt.toString),
            closesLots = true
          )
        ),
        1,
        Some(ClosingPolicyMessage().withByDeadline(ClosingByDeadline())),
        Some(
          LotDefaultsMessage(
            settings.currency,
            Some(StepPolicyMessage().withFixed(MoneyMessage(settings.step, settings.currency))),
            Some(AntiSnipeMessage(120, 120, 3)),
            proxyEnabled = true
          )
        )
      )
      accepted(
        "ScheduleAuction",
        await(
          asCaller(client.scheduleAuction())
            .invoke(wire.ScheduleAuctionRequest(Some(admin), auction, newId(), Some(config)))
        ).outcome.isAccepted
      )
      accepted(
        "ScheduleLot",
        await(
          asCaller(client.scheduleLot()).invoke(
            wire.ScheduleLotRequest(
              Some(admin),
              auction,
              lot,
              newId(),
              Some(MoneyMessage(100_000, settings.currency)),
              Some(StepPolicyMessage().withFixed(MoneyMessage(settings.step, settings.currency)))
            )
          )
        ).outcome.isAccepted
      )
      accepted(
        "StartPrebidding",
        await(
          asCaller(client.startPrebidding()).invoke(wire.StartPrebiddingRequest(Some(admin), auction, newId()))
        ).outcome.isAccepted
      )
      // Лоты аукцион открывает после ответа, а чтение отстаёт на проекцию: до неё лот — NOT_FOUND.
      retrying("lot trading")(Try(snapshot(lot).status.isTrading).getOrElse(false))
      retrying("SelectForFinal")(
        Try(
          await(
            asCaller(client.selectForFinal()).invoke(wire.SelectForFinalRequest(Some(admin), auction, lot, newId()))
          ).outcome.isAccepted
        ).getOrElse(false)
      )
      // Заморозка ждёт перерыва после общего дедлайна, а до ответа лотов отвечает LineupUnknown (UNAVAILABLE).
      retrying("FreezeFinalLineup")(
        Try(
          await(
            asCaller(client.freezeFinalLineup())
              .invoke(wire.FreezeFinalLineupRequest(Some(admin), auction, newId(), Seq(lot)))
          ).outcome.isAccepted
        ).getOrElse(false)
      )
      accepted(
        "StartFinal",
        await(
          asCaller(client.startFinal()).invoke(wire.StartFinalRequest(Some(admin), auction, newId()))
        ).outcome.isAccepted
      )
      accepted(
        "StartNextLot",
        await(
          asCaller(client.startNextLot()).invoke(wire.StartNextLotRequest(Some(admin), auction, newId()))
        ).outcome.isAccepted
      )
      retrying("lot in the live final")(
        Try(snapshot(lot).status.trading.exists(_.phase.isLotPhaseLive)).getOrElse(false)
      )
      (auction, lot)
    }

    private def untilAvailable[A](call: => Future[A]): A = {
      val until = System.nanoTime() + 60.seconds.toNanos
      @tailrec def attempt(): A = Try(await(call)) match {
        case Success(value) => value
        case Failure(e: StatusRuntimeException)
            if e.getStatus.getCode == Status.Code.UNAVAILABLE && System.nanoTime() < until =>
          Thread.sleep(500)
          attempt()
        case Failure(e) => throw e
      }
      attempt()
    }

    /** Повторяет шаг подготовки раз в полсекунды до успеха; минута без него — отказ прогона. */
    private def retrying(step: String)(done: => Boolean): Unit = {
      val until = System.nanoTime() + 60.seconds.toNanos
      while (!done) {
        if (System.nanoTime() > until) sys.error(s"$step did not succeed in a minute")
        Thread.sleep(500)
      }
    }

    private def accepted(step: String, isAccepted: Boolean): Unit =
      if (!isAccepted) sys.error(s"$step was refused while preparing the run")

    private def snapshot(lot: String): wire.LotSnapshot =
      await(asCaller(client.getLot()).invoke(wire.GetLotRequest(Some(Volley.viewer(LocalStand.newId())), lot)))

    /** Следующая цена лота: с неё начинается лесенка финала, иначе первая ставка ушла бы в `BidNotAtNextPrice`. */
    private def nextPrice(lot: String): Long =
      snapshot(lot).nextPrice.map(_.minorUnits).getOrElse(sys.error(s"lot $lot has no next price: it is not trading"))

    /** Текущая цена лота — с ней в конце сверяется последняя цена каждого зрителя. */
    private def price(lot: String): Long =
      snapshot(lot).status.trading
        .flatMap(_.currentPrice)
        .map(_.minorUnits)
        .getOrElse(sys.error(s"lot $lot is not trading"))

    /** Имя в аукционе каждому участнику залпа: без него ставка до лота не доходит (ADR-059). */
    private def chooseNames(auction: String, participants: Seq[UUID]): Unit =
      participants.distinct.zipWithIndex.foreach { (participant, index) =>
        val chosen = await(
          asCaller(client.chooseDisplayName())
            .invoke(wire.ChooseDisplayNameRequest(Some(Volley.viewer(participant)), auction).withAlias(s"Load$index"))
        )
        accepted("ChooseDisplayName", chosen.outcome.isAccepted)
      }

    /** Ход одного сценария. Все отметки времени — `System.currentTimeMillis` этой машины. */
    private final class Observation(auction: String, lot: String, shots: Vector[Shot], opening: Long) {

      private val runner = VolleyRunner(client, settings.token, settings.currency)
      private val marks = ConcurrentLinkedQueue[(Shot, Long, Long, Outcome)]()
      private val notes = Vector.newBuilder[String]

      private val viewers = Vector.fill(settings.viewers)(StreamViewer(screen, auction, slow = false))
      private val slow = Vector.fill(settings.slow)(StreamViewer(screen, auction, slow = true))

      /** Страница с обрывом сети идёт через прокси, чья сеть замолкает; он есть только у локального стенда. */
      private val stalling =
        stand.filter(_ => settings.scenario == Scenario.Load && settings.pages >= 3).map(s => StallingProxy(s.httpPort))

      private def pageUrls: Vector[String] = Vector.tabulate(settings.pages) { index =>
        stalling.filter(_ => index == 0).fold(screen.page(auction))(p => s"http://127.0.0.1:${p.port}/screen/$auction")
      }

      /** Пробные страницы (обрыв и заморозка) в задержку не входят: их наблюдения — про восстановление. */
      private def probes: Set[Int] =
        if (settings.scenario == Scenario.Load && settings.pages >= 3) Set(1) ++ stalling.map(_ => 0) else Set.empty

      def run(): String = {
        val started = System.currentTimeMillis()
        viewers.foreach(_.start())
        slow.foreach(_.start())
        if (settings.scenario == Scenario.Limit) awaitFirstState(viewers, 60.seconds)
        val pages = PageViewers(pageUrls)
        try {
          if (settings.scenario != Scenario.Limit) awaitFirstState(viewers, 60.seconds)
          if (settings.idle > Duration.Zero) {
            notes += s"Тишина без ставок: ${settings.idle.toSeconds} с."
            Thread.sleep(settings.idle.toMillis)
          }
          val volley = fire()
          timeline(pages)
          Await.result(volley, Duration.Inf)
          Thread.sleep(10_000) // зрители догоняют последнюю ставку
          val finalPrice = price(lot)
          report(pages, started, finalPrice)
        } finally {
          viewers.foreach(_.stop())
          slow.foreach(_.stop())
          pages.close()
          stalling.foreach(_.close())
        }
      }

      private def awaitFirstState(group: Seq[StreamViewer], within: FiniteDuration): Unit = {
        val until = System.nanoTime() + within.toNanos
        while (group.exists(_.states == 0) && System.nanoTime() < until) Thread.sleep(200)
        val waiting = group.count(_.states == 0)
        if (waiting > 0) notes += s"Без первого состояния за ${within.toSeconds} с: $waiting из ${group.size} зрителей."
      }

      private def interval: Long = (1000 / settings.rate).toLong.max(1)

      /**
       * Ставки по одной, как в живом финале: следующая уходит в свой момент, но не раньше ответа на предыдущую — иначе
       * обогнавшая ставка получила бы `BidNotAtNextPrice`, а за ней и все остальные. Ставку без ответа (сбой, рестарт)
       * прогон повторяет с тем же `op_id`: принятая вернёт исходный ответ, не записанная запишется сейчас.
       */
      private def fire(): Future[Unit] =
        Future {
          val origin = System.currentTimeMillis()
          shots.zipWithIndex.foreach { (shot, index) =>
            val wait = origin + index * interval - System.currentTimeMillis()
            if (wait > 0) Thread.sleep(wait)
            val sent = System.currentTimeMillis()
            val until = sent + 120_000
            var outcome = once(shot)
            while (outcome.isInstanceOf[Outcome.Failed] && System.currentTimeMillis() < until) {
              Thread.sleep(500)
              outcome = once(shot)
            }
            marks.add((shot, sent, System.currentTimeMillis(), outcome))
          }
        }(using
          ExecutionContext.fromExecutor(java.util.concurrent.Executors.newSingleThreadExecutor { task =>
            val thread = Thread(task, "screen-load-volley")
            thread.setDaemon(true)
            thread
          })
        )

      private def once(shot: Shot): Outcome =
        Await.result(runner.fire(Seq(shot), parallelism = 1)(), 30.seconds).headOption.fold(Outcome.NotSent)(_.outcome)

      /** Действия сценария посреди залпа — с потока прогона: Playwright не потокобезопасен. */
      private def timeline(pages: PageViewers): Unit = {
        val duration = (shots.size * interval).max(1)
        settings.scenario match {
          case Scenario.Load if probes.nonEmpty =>
            Thread.sleep(duration / 4)
            stalling.foreach { proxy =>
              proxy.silence()
              notes += s"Страница 0: сеть замолкла в ${System.currentTimeMillis()}."
            }
            pages.freeze(1)
            notes += s"Страница 1: заморожена в ${System.currentTimeMillis()}."
            Thread.sleep(20_000)
            stalling.foreach { proxy =>
              proxy.restore()
              returned += 0 -> System.currentTimeMillis()
              notes += s"Страница 0: сеть вернулась в ${returned(0)}."
            }
            Thread.sleep(10_000)
            pages.thaw(1)
            returned += 1 -> System.currentTimeMillis()
            notes += s"Страница 1: разморожена в ${returned(1)}."
          case Scenario.Restart =>
            Thread.sleep(duration / 2)
            stand.foreach { s =>
              val (killed, ready) = s.restart()
              notes += s"Auction убит в $killed, новый процесс готов в $ready (${ready - killed} мс)."
              restarted = Some(killed -> ready)
            }
          case Scenario.Limit =>
            Thread.sleep(duration / 2)
            viewers.take(viewers.size / 2).foreach(_.stop())
            freed = Some(System.currentTimeMillis())
            notes += s"Половина лёгких зрителей ушла в ${freed.get}: место в пределе освободилось."
          case _ => ()
        }
      }

      private val RestartMargin = 5_000L

      @volatile private var restarted: Option[(Long, Long)] = None
      @volatile private var freed: Option[Long] = None

      /** Момент возврата пробной страницы: сеть вернулась или вкладка разморожена. */
      @volatile private var returned = Map.empty[Int, Long]

      private def report(pages: PageViewers, started: Long, finalPrice: Long): String = {
        val outcomes = marks.asScala.toVector
        val accepted = outcomes.collect { case (Shot.Bid(_, _, amount, _), sent, answered, Outcome.Accepted(_)) =>
          BidMark(amount, sent, answered)
        }
        // Ставка не выше цены до залпа неотличима у зрителя от стартовой цены: первое же состояние после отправки
        // засчитало бы её до фиксации. При рестарте в замер идут ставки, принятые за `RestartMargin` до убийства и
        // раньше: позднюю зритель увидит только после подъёма, и простой сервиса попал бы в задержку пути.
        val measured = accepted
          .filter(_.amount > opening)
          .filter(bid => restarted.forall((killed, _) => bid.answeredAt < killed - RestartMargin))
        val answers = outcomes.map((_, sent, answered, _) => answered - sent)
        val refused = outcomes.count(_._4.isInstanceOf[Outcome.Refused])
        val failed = outcomes.count(_._4.isInstanceOf[Outcome.Failed])

        val streamDelays = viewers.map(v => ScreenLatency.delays(measured, v.seen.asScala.toVector))
        val pageIndexes = pages.pages.indices.filterNot(probes.contains)
        val pageDelays = pageIndexes.map(i => ScreenLatency.delays(measured, pages.seen(i)))
        val all = (streamDelays ++ pageDelays).flatMap(_._1)

        val lines = Vector.newBuilder[String]
        lines += s"# Прогон экрана зала: ${settings.scenario.toString.toLowerCase}"
        lines += ""
        lines += "## Условия"
        lines += ""
        lines += s"- стенд: ${if (settings.local) "local (машина прогона)" else "remote"}; экран ${screen.base}"
        lines += s"- аукцион $auction, лот $lot; начало ${Instant.ofEpochMilli(started)}"
        lines += s"- лёгких зрителей ${settings.viewers}, страниц Chromium ${settings.pages}, медленных ${settings.slow}"
        lines += s"- ставок ${settings.bids}, частота ${settings.rate}/с, шаг ${settings.step}, seed ${settings.seed}"
        if (settings.local) lines += s"- предел потоков `auction.screen.max-streams` = ${settings.maxStreams}"
        lines += ""
        lines += "## Ставки"
        lines += ""
        lines += s"- принято ${accepted.size}, отказ $refused, сбой $failed из ${outcomes.size}"
        lines += s"- ответ `PlaceBid`, мс: ${stats(answers)}"
        lines += ""
        lines += "## Задержка до зрителя"
        lines += ""
        lines += s"Ставок в замере ${measured.size}" +
          restarted.fold("")(_ => s" (принятые раньше чем за ${RestartMargin / 1000} с до рестарта)") +
          "; пробные страницы и ставки не выше цены до залпа не входят."
        // Пустой замер — не «задержек нет»: без строки ниже пустая таблица читалась бы как чистый прогон.
        if (measured.isEmpty && settings.bids > 0)
          lines += "**Замера нет: ни одна принятая ставка в него не вошла — числа ниже ничего не говорят о задержке.**"
        lines += ""
        lines += "| Кто | Пар | От отправки, мс | От ответа, мс | Не увидели |"
        lines += "|---|---|---|---|---|"
        lines += row("Все", all, (streamDelays ++ pageDelays).map(_._2).sum)
        lines += row("Лёгкие", streamDelays.flatMap(_._1), streamDelays.map(_._2).sum)
        lines += row("Страницы", pageDelays.flatMap(_._1), pageDelays.map(_._2).sum)
        lines += ""
        // Растущая от четверти к четверти задержка — очередь, которая копится под залпом; ровная — цена пути.
        val quarters = measured.sortBy(_.sentAt).grouped((measured.size + 3) / 4 max 1).toVector
        val byQuarter = quarters.map { part =>
          val delays = viewers.flatMap(v => ScreenLatency.delays(part, v.seen.asScala.toVector)._1) ++
            pageIndexes.flatMap(i => ScreenLatency.delays(part, pages.seen(i))._1)
          ScreenLatency.percentile(delays.map(_.fromSent), 0.95).fold("—")(_.toString)
        }
        lines += s"p95 от отправки по четвертям залпа, мс: ${byQuarter.mkString(" · ")}"
        if (settings.scenario == Scenario.Limit)
          lines += "В этом сценарии задержка страниц включает ожидание места в пределе, а «не увидели» — ставки после " +
            "ухода половины лёгких зрителей: числа таблицы про предел, а не про путь ставки."
        lines += ""
        lines += "## Подключения"
        lines += ""
        val streamAnswers = (viewers ++ slow).flatMap(_.answers.asScala)
        lines += s"- лёгкие и медленные: ${histogram(streamAnswers)}"
        lines += s"- страницы: ${histogram(pages.pages.indices.flatMap(pages.answers))}"
        lines += ""
        lines += "## Актуальность в конце"
        lines += ""
        lines += s"Цена лота по `GetLot`: $finalPrice."
        lines += ""
        val remaining = if (freed.isDefined) viewers.drop(viewers.size / 2) else viewers
        lines += s"- лёгкие с этой ценой: ${remaining.count(_.lastPrice.contains(finalPrice))} из ${remaining.size}"
        lines += s"- лёгких, переподключавшихся хоть раз: ${viewers.count(_.answers.size > 1)} из ${viewers.size}"
        pages.pages.indices.foreach { i =>
          val label = if (probes.contains(i)) s"страница $i (проба)" else s"страница $i"
          val back = returned.get(i).fold("") { at =>
            val target = accepted.filter(_.answeredAt <= at).map(_.amount).maxOption.getOrElse(0L)
            pages
              .seen(i)
              .find(s => s.at >= at && s.price >= target)
              .map(s => s"; после возврата актуальная цена через ${s.at - at} мс")
              .orElse(
                pages.lastPrice(i).filter(_ >= target).map(_ => "; цена после возврата не менялась и была актуальной")
              )
              .getOrElse("; после возврата цена не догнала")
          }
          lines += s"- $label: последняя цена ${pages.lastPrice(i).getOrElse("—")}, статусы ${statusLine(pages.statuses(i))}$back"
        }
        restarted.foreach { (killed, ready) =>
          // Поток рвётся вместе с процессом, поэтому первое состояние после убийства — уже от нового процесса. Отсчёт —
          // от убийства: готовность по опросу health зритель может опередить.
          val recovery = viewers.flatMap(_.seen.asScala.find(_.at >= killed).map(_.at - killed))
          lines += ""
          lines += s"Первое состояние после убийства, мс: ${stats(recovery)} (новый процесс готов через " +
            s"${ready - killed}); без восстановления ${viewers.size - recovery.size} из ${viewers.size} лёгких."
        }
        if (settings.scenario == Scenario.Limit) {
          lines += ""
          lines += "## Повторы отказанных страниц"
          lines += ""
          pages.pages.indices.foreach { i =>
            val attempts = pages.answers(i)
            lines += s"- страница $i: ${attempts.map(_.status).mkString(" ")}; паузы, мс: " +
              ScreenLatency.gaps(attempts.map(_.at)).mkString(" ")
          }
        }
        val written = notes.result()
        if (written.nonEmpty) {
          lines += ""
          lines += "## Ход прогона"
          lines += ""
          written.foreach(note => lines += s"- $note")
        }
        lines.result().mkString("", "\n", "\n")
      }

      private def row(who: String, delays: Seq[Delay], missed: Int): String =
        s"| $who | ${delays.size} | ${stats(delays.map(_.fromSent))} | ${stats(delays.map(_.fromAnswer))} | $missed |"

      private def stats(values: Seq[Long]): String =
        if (values.isEmpty) "—"
        else {
          def p(q: Double) = ScreenLatency.percentile(values, q).getOrElse(0L)
          s"p50 ${p(0.5)}, p95 ${p(0.95)}, max ${values.max}"
        }

      private def histogram(answers: Seq[Answer]): String =
        answers.groupMapReduce(_.status)(_ => 1)(_ + _).toVector.sorted.map((s, n) => s"$s×$n").mkString(", ")

      /** Смены статуса страницы подряд без повторов: `live → stale → live`. */
      private def statusLine(statuses: Seq[(Long, String)]): String =
        statuses
          .map(_._2)
          .foldLeft(Vector.empty[String])((acc, s) => if (acc.lastOption.contains(s)) acc else acc :+ s)
          .mkString(" → ")
    }
  }
}
