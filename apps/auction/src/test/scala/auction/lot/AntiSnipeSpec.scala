package auction.lot

import auction.lot.LotFixtures.*
import org.scalacheck.Gen
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

import java.time.Duration
import java.time.Instant

final class AntiSnipeSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 200)

  private val oneMinuteBefore: Instant = deadline.minus(Duration.ofMinutes(1))

  private def extendedTo(minutes: Long, used: Int): LotEvent.DeadlineExtended =
    LotEvent.DeadlineExtended(deadline.plus(Duration.ofMinutes(minutes)), used)

  /** Лот в торгах с окном шире продления: так одна команда с двумя ставками могла бы продлить его дважды. */
  private def wideWindow(lot: Lot): Lot = {
    val trading = tradingOf(lot)
    val antiSnipe = AntiSnipe(Duration.ofMinutes(5), Duration.ofMinutes(2), 3)
    lotIn(LotState.Trading(trading.copy(config = trading.config.copy(antiSnipe = antiSnipe))))
  }

  "anti-sniping" should {

    "extend the deadline after a bid a minute before it and count the extension (Т-09)" in {
      val (result, journal) = Journal.of(trading(price = 100)).submit(placeBid(1, 110, 1), bid(1), oneMinuteBefore)

      result shouldBe Right(Decision.Accepted(manual(bid(1), 1, 110, None), List(extendedTo(2, 1))))
      tradingOf(journal.lot).deadline shouldBe Some(deadline.plus(Duration.ofMinutes(2)))
      tradingOf(journal.lot).extensionsUsed shouldBe 1
    }

    "accept a bid in the window but leave the deadline once the extensions ran out (Т-10)" in {
      val exhausted = trading(price = 100, extensionsUsed = 3)
      val (result, journal) = Journal.of(exhausted).submit(placeBid(1, 110, 1), bid(1), oneMinuteBefore)

      result shouldBe Right(Decision.Accepted(manual(bid(1), 1, 110, None)))
      tradingOf(journal.lot).deadline shouldBe Some(deadline)
      tradingOf(journal.lot).extensionsUsed shouldBe 3
    }

    "leave the deadline after a bid before the window and after a bid exactly at its edge" in {
      val before = deadline.minus(Duration.ofMinutes(3))
      val edge = deadline.minus(antiSnipe.window)

      for (now <- List(before, edge)) {
        val (result, journal) = Journal.of(trading(price = 100)).submit(placeBid(1, 110, 1), bid(1), now)

        result shouldBe Right(Decision.Accepted(manual(bid(1), 1, 110, None)))
        tradingOf(journal.lot).deadline shouldBe Some(deadline)
      }
    }

    "never extend a lot that a person leads" in {
      val (result, _) =
        Journal.of(trading(price = 100, closesAt = None)).submit(placeBid(1, 110, 1), bid(1), oneMinuteBefore)

      result shouldBe Right(Decision.Accepted(manual(bid(1), 1, 110, None)))
    }

    "move the deadline by the extension each time until the limit, then stop" in {
      val bids = (1 to 4).map(n => placeBid(who = n % 2 + 1, amount = 100 + 10 * n, opN = n))
      val journal = bids.zipWithIndex.foldLeft(Journal.of(trading(price = 100))) { case (journal, (command, index)) =>
        // Каждая ставка — за минуту до дедлайна, каким он стал после прошлой.
        val now = tradingOf(journal.lot).deadline.get.minus(Duration.ofMinutes(1))
        journal.submit(command, bid(index + 1), now)._2
      }

      journal.entries.map(_.event).collect { case extended: LotEvent.DeadlineExtended => extended } shouldBe
        Vector(extendedTo(2, 1), extendedTo(4, 2), extendedTo(6, 3))
      tradingOf(journal.lot).deadline shouldBe Some(deadline.plus(Duration.ofMinutes(6)))
    }

    "extend once per command even when a proxy answers the bid within the new window" in {
      val rivalLimit = wideWindow(trading(price = 100, limits = Map(participant(2) -> limit(300, setSeq = 1))))
      val (result, journal) = Journal.of(rivalLimit).submit(placeBid(1, 110, 1), bid(1), oneMinuteBefore)

      result shouldBe Right(
        Decision.Accepted(manual(bid(1), 1, 110, None), List(proxied(proxyBid(1), 2, 120, Some(1)), extendedTo(2, 1)))
      )
      tradingOf(journal.lot).extensionsUsed shouldBe 1
    }

    "write a limit, its derived bid and the extension in one transaction in this order" in {
      val manualLeader = trading(price = 100, leader = Some(participant(1)))
      val (result, journal) = Journal.of(manualLeader).limit(setProxyLimit(2, 200, 1), oneMinuteBefore)

      result shouldBe Right(
        Decision.Accepted(
          LotEvent.ProxyLimitSet(participant(2), money(200)),
          List(proxied(proxyBid(1), 2, 110, Some(1)), extendedTo(2, 1))
        )
      )
      journal.entries.map(_.opId).toSet shouldBe Set(op(1))
    }

    "not extend the deadline for a limit that places no bid" in {
      val leader = trading(price = 100, leader = Some(participant(1)))

      Journal.of(leader).limit(setProxyLimit(1, 200, 1), oneMinuteBefore)._1 shouldBe
        Right(Decision.Accepted(LotEvent.ProxyLimitSet(participant(1), money(200))))
    }

    "answer a repeated limit that extended the deadline with its original response and write nothing (Т-25)" in {
      val command = setProxyLimit(2, 200, 1)
      val (_, journal) =
        Journal.of(trading(price = 100, leader = Some(participant(1)))).limit(command, oneMinuteBefore)

      journal.entries.map(_.event.getClass) shouldBe
        Vector(classOf[LotEvent.ProxyLimitSet], classOf[LotEvent.BidPlaced], classOf[LotEvent.DeadlineExtended])
      journal.limit(command, oneMinuteBefore.plusSeconds(30)) shouldBe
        (Right(Decision.Repeated(journal.entries.head)), journal)
    }

    "keep the deadline and the count after replaying the journal from the start" in {
      val (_, journal) = Journal.of(trading(price = 100)).submit(placeBid(1, 110, 1), bid(1), oneMinuteBefore)

      tradingOf(Lot.replay(trading(price = 100), journal.entries.reverse)) shouldBe tradingOf(journal.lot)
    }

    "extend exactly when the bid lands inside the window and the limit is not spent" in {
      forAll(Gen.choose(-600L, 600L), Gen.choose(0, 4), Gen.oneOf(true, false)) { (offset, used, timed) =>
        val lot = trading(price = 100, closesAt = Option.when(timed)(deadline), extensionsUsed = used)
        val now = deadline.plusSeconds(offset)
        val expected =
          Option.when(timed && offset > -antiSnipe.window.toSeconds && used < antiSnipe.maxExtensions)(
            LotEvent.DeadlineExtended(deadline.plus(antiSnipe.extension), used + 1)
          )

        Lot.decide(lot, placeBid(1, 110, 1), bid(1), proxyBid(1), now) shouldBe
          Right(Decision.Accepted(manual(bid(1), 1, 110, None), expected.toList))
      }
    }
  }
}
