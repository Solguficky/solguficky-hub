package auction.lot

import auction.lot.LotFixtures.*
import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

/**
 * Живой финал: ask ведущего (П-08), ставка зала и прокси по сетке (ADR-049, О-6.B). Лот финала ведёт человек, поэтому
 * дедлайна у него нет — как после `LotResumed`.
 */
final class LiveFinalSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 200)

  private def live(
      price: Long,
      leader: Option[Int] = None,
      limits: Map[Int, ProxyLimit] = Map.empty,
      ask: Option[Long] = None,
      policy: StepPolicy = fixedHundred
  ): Journal =
    Journal.of(
      trading(
        price = price,
        policy = policy,
        phase = Phase.Live,
        leader = leader.map(participant),
        ask = ask,
        limits = limits.map((who, limit) => participant(who) -> limit),
        closesAt = None
      )
    )

  private def floorOf(bid: BidId, who: Int, amount: Long, previous: Option[Int]): LotEvent.BidPlaced =
    manual(bid, who, amount, previous).copy(origin = BidOrigin.Manual(BidSource.Floor))

  "lot taking the ask of the auctioneer" should {

    "raises its floor without changing its price or leader" in {
      val (result, after) = live(price = 200, leader = Some(1)).ask(advanceAsk(500, opN = 1))

      result shouldBe Right(Decision.Accepted(LotEvent.AskAdvanced(money(500))))
      tradingOf(after.lot).ask shouldBe Some(money(500))
      tradingOf(after.lot).currentPrice shouldBe money(200)
      tradingOf(after.lot).leader shouldBe Some(participant(1))
      Lot.minRequired(tradingOf(after.lot), calm) shouldBe money(500)
    }

    "refuses an ask that does not exceed the floor and names the floor (Т-24)" in {
      val atPrice = live(price = 200, leader = Some(1))
      atPrice.ask(advanceAsk(200, opN = 1)) shouldBe
        (Left(AdvanceAskRejected.AskBelowCurrentPrice(money(200))), atPrice)

      val announced = live(price = 200, leader = Some(1), ask = Some(500))
      announced.ask(advanceAsk(400, opN = 1)) shouldBe
        (Left(AdvanceAskRejected.AskBelowCurrentPrice(money(500))), announced)
    }

    "refuses an ask in a currency other than its own and keeps the ask (Т-33)" in {
      val before = live(price = 200, leader = Some(1), ask = Some(500))

      val (result, after) = before.ask(advanceAsk(700, opN = 1, currency = eur))

      result shouldBe Left(AdvanceAskRejected.CurrencyMismatch)
      tradingOf(after.lot).ask shouldBe Some(money(500))
    }

    "refuses an ask while not trading, the held lot included" in {
      Lot.decide(Lot.initial, advanceAsk(500, opN = 1), proxyBid(1), calm) shouldBe
        Left(AdvanceAskRejected.LotNotFound)
      List(drafted, scheduled(), held(price = 100, leader = participant(1)), sold(price = 100, participant(1)))
        .foreach { lot =>
          Lot.decide(lot, advanceAsk(500, opN = 1), proxyBid(1), calm) shouldBe Left(AdvanceAskRejected.LotNotOpen)
        }
    }

    "answers a repeated ask with the original response and refuses the op_id of another command" in {
      val (_, announced) = live(price = 200, leader = Some(1)).ask(advanceAsk(500, opN = 1))

      Lot.decide(announced.lot, advanceAsk(500, opN = 1), proxyBid(9), calm) shouldBe
        Right(Decision.Repeated(announced.entries.last))
      val (_, bidden) = announced.submit(placeBid(who = 2, amount = 500, opN = 2), bid(1))
      Lot.decide(bidden.lot, advanceAsk(600, opN = 2), proxyBid(9), calm) shouldBe
        Left(AdvanceAskRejected.OpIdTaken)
    }

    "triggers no proxy on an ask while online, even when a limit could take it" in {
      val online = Journal.of(
        trading(
          price = 1700,
          policy = fixedHundred,
          leader = Some(participant(1)),
          limits = Map(participant(2) -> limit(max = 1750, setSeq = 1))
        )
      )

      online.ask(advanceAsk(1750, opN = 1))._1 shouldBe Right(Decision.Accepted(LotEvent.AskAdvanced(money(1750))))
    }
  }

  "proxy answering the ask in the live final" should {

    "takes the ask the auctioneer conceded within its limit in the same transaction (Т-73)" in {
      val final_ = live(price = 1700, leader = Some(1), limits = Map(2 -> limit(max = 1750, setSeq = 1)))

      final_.ask(advanceAsk(1750, opN = 1))._1 shouldBe
        Right(
          Decision.Accepted(LotEvent.AskAdvanced(money(1750)), List(proxied(proxyBid(1), 2, 1750, Some(1))))
        )
    }

    "leaves a jump above its limit unanswered (Т-74)" in {
      val final_ = live(price = 1700, leader = Some(1), limits = Map(2 -> limit(max = 1750, setSeq = 1)))

      final_.ask(advanceAsk(1800, opN = 1))._1 shouldBe Right(Decision.Accepted(LotEvent.AskAdvanced(money(1800))))
    }

    "pays the ask rather than ask plus a step when the limit is set after the ask (Т-75)" in {
      val (_, announced) = live(price = 1000, leader = Some(1)).ask(advanceAsk(1500, opN = 1))

      announced.limit(setProxyLimit(who = 2, max = 1520, opN = 2))._1 shouldBe
        Right(
          Decision.Accepted(
            LotEvent.ProxyLimitSet(participant(2), money(1520)),
            List(proxied(proxyBid(2), 2, 1500, Some(1)))
          )
        )
    }

    "gives the ask to the stronger of two limits that both reach only the ask (Т-76)" in {
      val final_ =
        live(price = 1000, leader = Some(1), limits = Map(1 -> limit(max = 1080, setSeq = 1), 2 -> limit(1090, 2)))

      final_.ask(advanceAsk(1050, opN = 1))._1 shouldBe
        Right(
          Decision.Accepted(LotEvent.AskAdvanced(money(1050)), List(proxied(proxyBid(1), 2, 1050, Some(1))))
        )
    }

    "keeps the leader above the ask when its own limit is the stronger one" in {
      val final_ =
        live(price = 1000, leader = Some(1), limits = Map(1 -> limit(max = 1300, setSeq = 1), 2 -> limit(1150, 2)))

      // Соперник дотягивает до ask, лидер держит позицию по сетке от ask: min(1300, 1150 + 100) → 1250.
      final_.ask(advanceAsk(1050, opN = 1))._1 shouldBe
        Right(
          Decision.Accepted(LotEvent.AskAdvanced(money(1050)), List(proxied(proxyBid(1), 1, 1250, Some(1))))
        )
    }
  }

  "proxy on the grid of the live final" should {

    "places no derived bid on a limit short of the next point of the grid (Т-42)" in {
      val final_ = live(price = 110, leader = Some(1), policy = fixedTen)

      final_.limit(setProxyLimit(who = 2, max = 115, opN = 1))._1 shouldBe
        Right(Decision.Accepted(LotEvent.ProxyLimitSet(participant(2), money(115))))
    }

    "rounds a limit off the grid down to the grid instead of bidding a partial amount" in {
      val final_ = live(price = 100, leader = Some(1), limits = Map(1 -> limit(125, 1)), policy = fixedTen)

      // Онлайн цель была бы min(140, 125 + 10) = 135; в финале — точка сетки 130.
      final_.limit(setProxyLimit(who = 2, max = 140, opN = 1))._1 shouldBe
        Right(
          Decision.Accepted(
            LotEvent.ProxyLimitSet(participant(2), money(140)),
            List(proxied(proxyBid(1), 2, 130, Some(1)))
          )
        )
    }

    "places the first derived bid of a lot without bids at the starting price, the first point of the grid" in {
      live(price = 1000).limit(setProxyLimit(who = 2, max = 1250, opN = 1))._1 shouldBe
        Right(
          Decision.Accepted(
            LotEvent.ProxyLimitSet(participant(2), money(1250)),
            List(proxied(proxyBid(1), 2, 1000, None))
          )
        )
    }

    "takes the starting price with a limit equal to it while the lot has no bids" in {
      live(price = 1000).limit(setProxyLimit(who = 2, max = 1000, opN = 1))._1 shouldBe
        Right(
          Decision.Accepted(
            LotEvent.ProxyLimitSet(participant(2), money(1000)),
            List(proxied(proxyBid(1), 2, 1000, None))
          )
        )
    }

    "places every derived bid on the grid, above the floor and within the winning limit" in {
      val limits = Gen.mapOfN(3, Gen.zip(Gen.chooseNum(2, 6), Gen.chooseNum(100L, 3_000L)))
      forAll(Gen.chooseNum(100L, 2_000L), limits, Gen.option(Gen.chooseNum(1L, 900L))) {
        (price: Long, maxima: Map[Int, Long], jump: Option[Long]) =>
          val ask = jump.map(price + _)
          val sequenced = maxima.toList
            .sortBy(_._1)
            .zipWithIndex
            .map { case ((who, max), seq) =>
              who -> limit(max, seq.toLong + 1)
            }
            .toMap
          val state = tradingOf(live(price, leader = Some(1), limits = sequenced, ask = ask).lot)
          val floor = Lot.floor(state)
          Lot.resolve(state, proxyBid(1), calm).foreach { placed =>
            StepPolicy.gridFloor(fixedHundred, floor, placed.amount) shouldBe Some(placed.amount)
            if (ask.isDefined) placed.amount.minorUnits should be >= floor.minorUnits
            else placed.amount.minorUnits should be > floor.minorUnits
            placed.amount.minorUnits should be <= state.proxyLimits(placed.participant).max.minorUnits
          }
      }
    }
  }

  "lot taking a floor bid in the live final" should {

    "takes it exactly at the announced ask (Т-30)" in {
      val (_, announced) = live(price = 200, leader = Some(1)).ask(advanceAsk(500, opN = 1))

      announced.submit(floorBid(who = 2, amount = 500, opN = 2), bid(1))._1 shouldBe
        Right(Decision.Accepted(floorOf(bid(1), 2, 500, Some(1))))
    }

    "refuses it with the new price when the online bidder took the ask first" in {
      val (_, announced) = live(price = 1000, leader = Some(1)).ask(advanceAsk(1100, opN = 1))
      val (_, online) = announced.submit(placeBid(who = 2, amount = 1100, opN = 2), bid(1))

      online.submit(floorBid(who = 3, amount = 1100, opN = 3), bid(2))._1 shouldBe
        Left(PlaceBidRejected.BidNotAtNextPrice(money(1200)))
    }

    "refuses it with the new price when a proxy took the ask in the transaction of the ask" in {
      val final_ = live(price = 1700, leader = Some(1), limits = Map(2 -> limit(max = 1750, setSeq = 1)))
      val (_, taken) = final_.ask(advanceAsk(1750, opN = 1))

      taken.submit(floorBid(who = 3, amount = 1750, opN = 2), bid(1))._1 shouldBe
        Left(PlaceBidRejected.BidNotAtNextPrice(money(1850)))
    }

    "refuses it with the new ask when the auctioneer raised the ask before the record came" in {
      val (_, first) = live(price = 1000, leader = Some(1)).ask(advanceAsk(1500, opN = 1))
      val (_, raised) = first.ask(advanceAsk(1600, opN = 2))

      raised.submit(floorBid(who = 2, amount = 1500, opN = 3), bid(1))._1 shouldBe
        Left(PlaceBidRejected.BidNotAtNextPrice(money(1600)))
    }

    "gives one leader and one refusal with the new price to it and a bot bid at the same price" in {
      val final_ = live(price = 1000, leader = Some(1))
      val floor = floorBid(who = 2, amount = 1100, opN = 1)
      val bot = placeBid(who = 3, amount = 1100, opN = 2)

      List(List(floor, bot), List(bot, floor)).foreach { order =>
        val (results, after) = final_.submitAll(order)

        results.count(_.isRight) shouldBe 1
        results.collect { case Left(rejected) => rejected } shouldBe Vector(
          PlaceBidRejected.BidNotAtNextPrice(money(1200))
        )
        tradingOf(after.lot).currentPrice shouldBe money(1100)
        tradingOf(after.lot).leader shouldBe Some(order.head.participant)
      }
    }

    "extends no deadline: the lot of the final has none" in {
      val (result, after) = live(price = 1000, leader = Some(1), limits = Map(1 -> limit(1500, 1)))
        .submit(floorBid(who = 2, amount = 1100, opN = 1), bid(1))

      result.toOption.collect { case Decision.Accepted(_, derived) => derived } shouldBe
        Some(List(proxied(proxyBid(1), 1, 1200, Some(2))))
      tradingOf(after.lot).deadline shouldBe None
    }
  }

  "lot trading online under an announced ask" should {

    "refuses a bot bid below the ask and names the ask as the minimum (Т-23)" in {
      val online = Journal.of(trading(price = 200, ask = Some(500)))

      online.submit(placeBid(who = 1, amount = 210, opN = 1), bid(1))._1 shouldBe
        Left(PlaceBidRejected.BidBelowMinimum(money(500)))
    }
  }
}
