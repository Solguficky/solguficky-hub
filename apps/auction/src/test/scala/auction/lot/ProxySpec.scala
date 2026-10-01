package auction.lot

import auction.lot.LotFixtures.*
import org.scalacheck.Gen
import org.scalacheck.Shrink
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

/** Прокси-лимит и прокси-перебивание: команды `SetProxyLimit` и `WithdrawProxyLimit`, правило П-02. */
final class ProxySpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  // Умолчание моста — десять проверок, поэтому число задаётся явно.
  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 200)

  // Сценарии — последовательности команд, где важен порядок; сжатие переставляло бы их и меняло смысл контрпримера.
  implicit def noShrink[T]: Shrink[T] = Shrink.shrinkAny

  /** Лот в торгах со стартовой ценой 100 и шагом 10, без ставок и лимитов. */
  private val open: Journal = Journal.of(trading(price = 100))

  /** События, которые журнал получил после `before` строк. */
  private def written(journal: Journal, before: Int): List[LotEvent] = journal.entries.drop(before).map(_.event).toList

  private def bids(events: List[LotEvent]): List[LotEvent.BidPlaced] =
    events.collect { case placed: LotEvent.BidPlaced => placed }

  "proxy limit" should {

    "raise the price one step above a manual leader and take the lead (Т-05)" in {
      val (_, manual) = open.submit(placeBid(who = 1, amount = 110, opN = 1), bid(1))
      val (result, journal) = manual.limit(setProxyLimit(who = 2, max = 200, opN = 2))

      result shouldBe Right(
        Decision.Accepted(
          LotEvent.ProxyLimitSet(participant(2), money(200)),
          List(proxied(proxyBid(2), who = 2, amount = 120, previous = Some(1)))
        )
      )
      tradingOf(journal.lot).currentPrice shouldBe money(120)
      tradingOf(journal.lot).leader shouldBe Some(participant(2))
    }

    "let the stronger proxy keep the lead and raise the price to the weaker one plus a step, one bid per command (Т-06)" in {
      val (_, first) = open.limit(setProxyLimit(who = 1, max = 200, opN = 1))
      val (_, second) = first.limit(setProxyLimit(who = 2, max = 150, opN = 2))

      written(first, before = 0) shouldBe List(
        LotEvent.ProxyLimitSet(participant(1), money(200)),
        proxied(proxyBid(1), who = 1, amount = 110, previous = None)
      )
      written(second, before = first.entries.size) shouldBe List(
        LotEvent.ProxyLimitSet(participant(2), money(150)),
        proxied(proxyBid(3), who = 1, amount = 160, previous = Some(1))
      )
      tradingOf(second.lot).currentPrice shouldBe money(160)
      tradingOf(second.lot).leader shouldBe Some(participant(1))
    }

    "refuse a limit below the current price with ProxyBelowCurrentPrice and keep no trace of it (Т-07)" in {
      val journal = Journal.of(trading(price = 150))
      val (result, after) = journal.limit(setProxyLimit(who = 1, max = 140, opN = 1))

      result shouldBe Left(SetProxyLimitRejected.ProxyBelowCurrentPrice)
      after shouldBe journal
      tradingOf(after.lot).proxyLimits shouldBe Map.empty
    }

    "measure the limit against the announced ask when it is above the price" in {
      val lot = trading(price = 150, ask = Some(200))

      Lot.decide(lot, setProxyLimit(who = 1, max = 190, opN = 1), 1, proxyBid(1)) shouldBe
        Left(SetProxyLimitRejected.ProxyBelowCurrentPrice)
    }

    "accept a limit equal to the current price without a bid" in {
      val (result, journal) = Journal.of(trading(price = 150)).limit(setProxyLimit(who = 1, max = 150, opN = 1))

      result shouldBe Right(Decision.Accepted(LotEvent.ProxyLimitSet(participant(1), money(150))))
      tradingOf(journal.lot).proxyLimits shouldBe Map(participant(1) -> limit(150, setSeq = 1))
      tradingOf(journal.lot).leader shouldBe None
    }

    "keep the leader on equal maximums when the leader set the limit first (Т-18)" in {
      val (_, first) = open.limit(setProxyLimit(who = 1, max = 200, opN = 1))
      val (_, second) = first.limit(setProxyLimit(who = 2, max = 200, opN = 2))

      bids(written(second, before = first.entries.size)) shouldBe
        List(proxied(proxyBid(3), who = 1, amount = 200, previous = Some(1)))
      tradingOf(second.lot).currentPrice shouldBe money(200)
      tradingOf(second.lot).leader shouldBe Some(participant(1))
    }

    "place a derived bid below the next manual price when the limit runs out there in the online phase (Т-22)" in {
      val (_, manual) = open.submit(placeBid(who = 1, amount = 110, opN = 1), bid(1))
      val (_, journal) = manual.limit(setProxyLimit(who = 2, max = 115, opN = 2))

      bids(written(journal, before = 1)) shouldBe List(proxied(proxyBid(2), who = 2, amount = 115, previous = Some(1)))
      Lot.minRequired(tradingOf(manual.lot)) shouldBe money(120)
    }

    "refuse a limit in another currency with CurrencyMismatch and keep no trace of it (Т-26)" in {
      val (result, after) = open.limit(setProxyLimit(who = 1, max = 200, opN = 1, currency = eur))

      result shouldBe Left(SetProxyLimitRejected.CurrencyMismatch)
      after shouldBe open
    }

    "let a manual leader's own bid outweigh the leader's older lower limit (Т-28)" in {
      val lot = trading(price = 250, leader = Some(participant(1)), limits = Map(participant(1) -> limit(150, 3)))
      val (_, journal) = Journal.of(lot).limit(setProxyLimit(who = 2, max = 300, opN = 1))

      bids(written(journal, before = 0)) shouldBe List(proxied(proxyBid(1), who = 2, amount = 260, previous = Some(1)))
      tradingOf(journal.lot).leader shouldBe Some(participant(2))
    }

    "hand the lead to the rival whose equal limit was set before the leader's (Т-29)" in {
      // Командами в онлайн-фазе такого состояния не собрать: соперник с более ранним равным лимитом забрал бы
      // лидерство на своём пересчёте. Поэтому состояние собрано руками, а пересчёт запускает третий лимит.
      val lot = trading(
        price = 250,
        leader = Some(participant(1)),
        limits = Map(participant(1) -> limit(300, setSeq = 9), participant(2) -> limit(300, setSeq = 5))
      )

      Lot.resolve(tradingOf(lot), proxyBid(1)) shouldBe Some(
        proxied(proxyBid(1), who = 2, amount = 300, previous = Some(1))
      )
      val (_, journal) = Journal.of(lot).limit(setProxyLimit(who = 3, max = 260, opN = 1))
      tradingOf(journal.lot).currentPrice shouldBe money(300)
      tradingOf(journal.lot).leader shouldBe Some(participant(2))
    }

    "answer a manual bid with the proxy in the same transaction, the manual bid first" in {
      val (_, limited) = open.limit(setProxyLimit(who = 1, max = 200, opN = 1))
      val (result, journal) = limited.submit(placeBid(who = 2, amount = 150, opN = 2), bid(2))

      result shouldBe Right(
        Decision.Accepted(
          manual(bid(2), who = 2, amount = 150, previous = Some(1)),
          List(proxied(proxyBid(3), who = 1, amount = 160, previous = Some(2)))
        )
      )
      journal.entries.drop(limited.entries.size).map(_.opId).distinct shouldBe Vector(op(2))
      tradingOf(journal.lot).leader shouldBe Some(participant(1))
    }

    "refuse a limit on a lot whose configuration disables proxies before any other check" in {
      val lot = trading(price = 100, proxyEnabled = false)

      Lot.decide(lot, setProxyLimit(who = 1, max = 50, opN = 1, currency = eur), 1, proxyBid(1)) shouldBe
        Left(SetProxyLimitRejected.ProxyDisabledForLot)
    }

    "refuse a limit on a lot that is not trading" in {
      Lot.decide(Lot.initial, setProxyLimit(who = 1, max = 200, opN = 1), 1, proxyBid(1)) shouldBe
        Left(SetProxyLimitRejected.LotNotFound)
      List(drafted, scheduled(), sold(price = 100, winner = participant(2))).foreach { lot =>
        Lot.decide(lot, setProxyLimit(who = 1, max = 200, opN = 1), 1, proxyBid(1)) shouldBe
          Left(SetProxyLimitRejected.LotNotOpen)
      }
    }

    "keep a limit set on a held lot without a derived bid until the final" in {
      val (result, journal) = Journal.of(held(price = 300, leader = participant(1))).limit(setProxyLimit(2, 500, 1))

      result shouldBe Right(Decision.Accepted(LotEvent.ProxyLimitSet(participant(2), money(500))))
      journal.lot.state match {
        case LotState.Held(state) =>
          state.proxyLimits shouldBe Map(participant(2) -> limit(500, setSeq = 1))
          state.leader shouldBe Some(participant(1))
        case other => fail(s"лот не удержан: $other")
      }
    }

    "place no derived bid in the live phase, where rounding to the grid belongs to a later slice" in {
      val lot = trading(price = 110, phase = Phase.Live, leader = Some(participant(1)))

      Lot.decide(lot, setProxyLimit(who = 2, max = 200, opN = 1), 1, proxyBid(1)) shouldBe
        Right(Decision.Accepted(LotEvent.ProxyLimitSet(participant(2), money(200))))
    }

    "replace a participant's earlier limit and take the sequence of the new one" in {
      val (_, first) = Journal.of(trading(price = 100)).limit(setProxyLimit(who = 1, max = 100, opN = 1))
      val (_, second) = first.limit(setProxyLimit(who = 1, max = 300, opN = 2))

      tradingOf(second.lot).proxyLimits shouldBe Map(participant(1) -> limit(300, setSeq = 2))
    }

    "let the leader lower the own limit down to the current price but not below it" in {
      val (_, leading) = open.limit(setProxyLimit(who = 1, max = 200, opN = 1))
      val (lowered, journal) = leading.limit(setProxyLimit(who = 1, max = 110, opN = 2))

      lowered shouldBe Right(Decision.Accepted(LotEvent.ProxyLimitSet(participant(1), money(110))))
      tradingOf(journal.lot).currentPrice shouldBe money(110)
      journal.limit(setProxyLimit(who = 1, max = 100, opN = 3))._1 shouldBe
        Left(SetProxyLimitRejected.ProxyBelowCurrentPrice)
    }

    "answer a repeated limit with the original response and write nothing (Т-25 without the deadline)" in {
      val command = setProxyLimit(who = 1, max = 200, opN = 1)
      val (_, journal) = open.limit(command)

      journal.limit(command) shouldBe (Right(Decision.Repeated(journal.entries.head)), journal)
      journal.entries.head.event shouldBe LotEvent.ProxyLimitSet(participant(1), money(200))
    }
  }

  "proxy limit withdrawal" should {

    "remove the limit, the leader's included, without moving the price or the lead" in {
      val (_, leading) = open.limit(setProxyLimit(who = 1, max = 200, opN = 1))
      val (result, journal) = leading.withdraw(withdrawProxyLimit(who = 1, opN = 2))

      result shouldBe Right(Decision.Accepted(LotEvent.ProxyLimitWithdrawn(participant(1))))
      tradingOf(journal.lot).proxyLimits shouldBe Map.empty
      tradingOf(journal.lot).currentPrice shouldBe tradingOf(leading.lot).currentPrice
      tradingOf(journal.lot).leader shouldBe Some(participant(1))
    }

    "leave the lot to manual bids once the leader withdrew" in {
      val (_, leading) = open.limit(setProxyLimit(who = 1, max = 200, opN = 1))
      val (_, withdrawn) = leading.withdraw(withdrawProxyLimit(who = 1, opN = 2))
      val (result, _) = withdrawn.submit(placeBid(who = 2, amount = 150, opN = 3), bid(3))

      result shouldBe Right(Decision.Accepted(manual(bid(3), who = 2, amount = 150, previous = Some(1))))
    }

    "refuse a withdrawal without an active limit with NoActiveProxyLimit" in {
      List(drafted, trading(price = 100), held(price = 100, leader = participant(1))).foreach { lot =>
        Lot.decide(lot, withdrawProxyLimit(who = 1, opN = 1)) shouldBe Left(
          WithdrawProxyLimitRejected.NoActiveProxyLimit
        )
      }
      Lot.decide(Lot.initial, withdrawProxyLimit(who = 1, opN = 1)) shouldBe Left(
        WithdrawProxyLimitRejected.LotNotFound
      )
    }

    "remove a limit kept on a held lot" in {
      val lot = held(price = 300, leader = participant(1), limits = Map(participant(2) -> limit(500, setSeq = 4)))
      val (_, journal) = Journal.of(lot).withdraw(withdrawProxyLimit(who = 2, opN = 1))

      journal.lot.state match {
        case LotState.Held(state) => state.proxyLimits shouldBe Map.empty
        case other => fail(s"лот не удержан: $other")
      }
    }
  }

  "proxy bidding" should {

    "end at min(max of the leader, second maximum plus its step), the earlier limit winning a tie, in any order" in {
      val policies = Gen.oneOf(fixedTen, tiered((0, 10), (200, 25), (400, 50)))
      // Оба лимита выше первой цены: второй не отклоняется и не остаётся инертным на её уровне.
      val maximums = Gen.chooseNum(111L, 600L)
      forAll(policies, maximums, maximums, Gen.oneOf(true, false)) {
        (policy: StepPolicy, maxA: Long, maxB: Long, aFirst: Boolean) =>
          val first = if (aFirst) (1, maxA) else (2, maxB)
          val second = if (aFirst) (2, maxB) else (1, maxA)
          val (_, one) = Journal.of(trading(price = 100, policy = policy)).limit(setProxyLimit(first._1, first._2, 1))
          val (_, two) = one.limit(setProxyLimit(second._1, second._2, 2))

          val (leader, top, runnerUp) =
            if (first._2 >= second._2) (first._1, first._2, second._2) else (second._1, second._2, first._2)
          val expected = math.min(top, runnerUp + StepPolicy.step(policy, money(runnerUp)).minorUnits)
          tradingOf(two.lot).currentPrice shouldBe money(expected)
          tradingOf(two.lot).leader shouldBe Some(participant(leader))
          bids(written(two, before = one.entries.size)).size should be <= 1
      }
    }

    "never lower the price, write at most one derived bid per command, keep every proxy bid within a limit and leave nothing to recompute" in {
      val command = for {
        who <- Gen.chooseNum(1, 4)
        kind <- Gen.frequency(4 -> "limit", 3 -> "bid", 1 -> "withdraw")
        amount <- Gen.chooseNum(100L, 700L)
      } yield (kind, who, amount)
      forAll(Gen.listOfN(25, command)) { (commands: List[(String, Int, Long)]) =>
        commands.zipWithIndex.foldLeft(open) { case (journal, ((kind, who, amount), index)) =>
          val opN = index + 1
          val before = journal.entries.size
          val price = tradingOf(journal.lot).currentPrice
          val next = kind match {
            case "limit" => journal.limit(setProxyLimit(who, amount, opN))._2
            case "bid" => journal.submit(placeBid(who, amount, opN), bid(opN))._2
            case _ => journal.withdraw(withdrawProxyLimit(who, opN))._2
          }
          val after = tradingOf(next.lot)
          val derived = bids(written(next, before)).filter(_.origin == BidOrigin.Proxy)

          after.currentPrice.minorUnits should be >= price.minorUnits
          derived.size should be <= 1
          derived.foreach { placed =>
            after.proxyLimits
              .get(placed.participant)
              .map(_.max.minorUnits)
              .getOrElse(0L) should be >= placed.amount.minorUnits
          }
          Lot.resolve(after, proxyBid(0)) shouldBe None
          next
        }
      }
    }
  }
}
