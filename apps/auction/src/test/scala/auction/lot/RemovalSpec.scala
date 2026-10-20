package auction.lot

import auction.lot.LotFixtures.*
import org.scalacheck.Gen
import org.scalacheck.Shrink
import org.scalacheck.rng.Seed
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.ScalaCheckDrivenPropertyChecks

import java.time.Duration
import java.time.Instant

/** Снятие участника с лота: команда `RemoveParticipant`, переигрывание торгов без него (ADR-072, Т-82…Т-96). */
final class RemovalSpec extends AnyWordSpec with Matchers with ScalaCheckDrivenPropertyChecks {

  // Умолчание моста — десять проверок, поэтому число задаётся явно. Оракул отбрасывает истории, где повтор без снятого
  // получил бы отказ, поэтому запас на отброшенные шире умолчания.
  implicit override val generatorDrivenConfig: PropertyCheckConfiguration =
    PropertyCheckConfiguration(minSuccessful = 200, maxDiscardedFactor = 20.0)

  // Сценарии — последовательности команд, где важен порядок; сжатие переставляло бы их и меняло смысл контрпримера.
  implicit def noShrink[T]: Shrink[T] = Shrink.shrinkAny

  private val ann = 1
  private val mal = 2
  private val bob = 3
  private val cid = 4

  /** Лот, открытый со стартовой ценой 100 и шагом 10 первой командой журнала. */
  private def opened(closesAt: Option[Instant] = Some(deadline), windows: List[StepWindow] = Nil): Journal =
    Journal.of(scheduled(startingPrice = 100)).open(OpenLot(closesAt, op(1), windows))._2

  /** Команды по порядку, `op_id` — следующий номер журнала; каждая обязана пройти. */
  private def played(start: Journal, commands: (Journal => (Either[?, Decision], Journal))*): Journal =
    commands.foldLeft(start) { (journal, command) =>
      val (result, next) = command(journal)
      result.isRight shouldBe true
      next
    }

  private def bidBy(who: Int, amount: Long, now: Instant = calm): Journal => (Either[?, Decision], Journal) =
    journal => {
      val n = journal.entries.size + 1
      journal.submit(placeBid(who, amount, n), bid(n), now)
    }

  private def limitBy(who: Int, max: Long, now: Instant = calm): Journal => (Either[?, Decision], Journal) =
    journal => journal.limit(setProxyLimit(who, max, journal.entries.size + 1), now)

  private def withdrawnBy(who: Int): Journal => (Either[?, Decision], Journal) =
    journal => journal.withdraw(withdrawProxyLimit(who, journal.entries.size + 1))

  private def removing(journal: Journal, who: Int, now: Instant = calm) =
    journal.remove(removeParticipant(who, journal.entries.size + 1), now)

  private def removedEvent(result: Either[RemoveParticipantRejected, Decision]): LotEvent.ParticipantRemoved =
    result match {
      case Right(Decision.Accepted(removed: LotEvent.ParticipantRemoved, _)) => removed
      case other => throw new AssertionError(s"снятие не принято: $other")
    }

  private def derivedOf(result: Either[RemoveParticipantRejected, Decision]): List[LotEvent] =
    result match {
      case Right(Decision.Accepted(_, derived)) => derived
      case other => throw new AssertionError(s"снятие не принято: $other")
    }

  /** История Т-82: лимит A 300, ручные M 200 и 290 с ответами A 210 и 300, ручная B 310. */
  private def t82(start: Journal = opened()): Journal =
    played(start, limitBy(ann, 300), bidBy(mal, 200), bidBy(mal, 290), bidBy(bob, 310))

  "participant removal" should {

    "replay the trading without the removed participant, dropping the limit's answers to them (Т-82)" in {
      val history = t82()
      val n = history.entries.size + 1

      val (result, journal) = removing(history, mal)

      result shouldBe Right(
        Decision.Accepted(
          LotEvent.ParticipantRemoved(participant(mal), money(310), Some(participant(bob)), Some(position(n)))
        )
      )
      val after = tradingOf(journal.lot)
      (after.leader, after.currentPrice, after.leadingBidId) shouldBe (
        Some(participant(bob)),
        money(310),
        Some(position(n))
      )
    }

    "replay the limit's answers to the participants who stay (Т-83)" in {
      val removed = removedEvent(removing(t82(), bob)._1)

      (removed.leader, removed.price) shouldBe (Some(participant(ann)), money(300))
    }

    "not keep an answer to the standing limit of the removed participant (Т-84)" in {
      val history = played(opened(), limitBy(mal, 900), limitBy(ann, 1000))
      tradingOf(history.lot).currentPrice shouldBe money(910)

      val removed = removedEvent(removing(history, mal)._1)

      (removed.leader, removed.price) shouldBe (Some(participant(ann)), money(100))
    }

    "keep the leader of the replay but not raise the price above the one before the removal (Т-97)" in {
      // Без A лимит C 210 приходит при цене 100, и лимит B отвечает ему 220 — дороже, чем B держал лот.
      val history = played(opened(), limitBy(ann, 200), limitBy(bob, 300), limitBy(cid, 210))
      (tradingOf(history.lot).leader, tradingOf(history.lot).currentPrice) shouldBe (Some(participant(bob)), money(210))

      val (result, journal) = removing(history, ann)

      val removed = removedEvent(result)
      (removed.leader, removed.price) shouldBe (Some(participant(bob)), money(210))
      derivedOf(result) shouldBe Nil
      tradingOf(journal.lot).proxyLimits.keySet shouldBe Set(participant(bob), participant(cid))
    }

    "set a limit again at its own moment, where it placed no bid, and keep the price (Т-85)" in {
      val z = 5
      val history = played(opened(), limitBy(z, 290), bidBy(ann, 300), limitBy(cid, 300))

      val (result, _) = removing(history, z)

      val removed = removedEvent(result)
      (removed.leader, removed.price) shouldBe (Some(participant(ann)), money(300))
    }

    "settle a tie of a manual bid and an earlier limit by the order of entries, as in trading (Т-86)" in {
      val z = 5
      val x = 6
      val history = played(opened(), limitBy(cid, 300), bidBy(z, 150), bidBy(x, 300))
      tradingOf(history.lot).leader shouldBe Some(participant(x))

      val removed = removedEvent(removing(history, z)._1)

      (removed.leader, removed.price) shouldBe (Some(participant(x)), money(300))
    }

    "give the leader a position the journal does not have, and sell the lot by it (Т-87)" in {
      val history = played(opened(), bidBy(mal, 100), limitBy(ann, 300), bidBy(mal, 250))
      tradingOf(history.lot).currentPrice shouldBe money(260)
      val n = history.entries.size + 1

      val (result, removed) = removing(history, mal)
      val (sold, _) = removed.close(closeLot(opN = n + 1), deadline)

      removedEvent(result) shouldBe
        LotEvent.ParticipantRemoved(participant(mal), money(100), Some(participant(ann)), Some(position(n)))
      history.entries.map(_.event).collect {
        case placed: LotEvent.BidPlaced if placed.participant == participant(ann) => placed.amount
      } should not contain money(100)
      sold shouldBe Right(Decision.Accepted(LotEvent.LotSold(participant(ann), money(100), position(n), deadline)))
    }

    "leave no leader and no position, and the starting price, when the only participant is removed (Т-88)" in {
      val history = played(opened(), bidBy(mal, 150), limitBy(mal, 400))

      val (result, journal) = removing(history, mal)

      removedEvent(result) shouldBe LotEvent.ParticipantRemoved(participant(mal), money(100), None, None)
      val after = tradingOf(journal.lot)
      (after.leader, after.leadingBidId, after.currentPrice, after.proxyLimits) shouldBe
        (None, None, money(100), Map.empty)
    }

    "set and withdraw a limit at their own moments, and remove one whose only limit was withdrawn (Т-89)" in {
      val history = played(opened(), limitBy(ann, 300), bidBy(mal, 200), withdrawnBy(ann), bidBy(bob, 250))

      val withoutM = removedEvent(removing(history, mal)._1)
      val withoutA = removedEvent(removing(history, ann)._1)

      (withoutM.leader, withoutM.price) shouldBe (Some(participant(bob)), money(250))
      (withoutA.leader, withoutA.price) shouldBe (Some(participant(bob)), money(250))
    }

    "take step windows at the moment of each entry, not at the moment of the removal" in {
      val happyHours = stepWindow("13:00", "14:00", step = 1)
      val history = played(
        opened(windows = List(happyHours)),
        limitBy(ann, 300, now = at("11:00")),
        bidBy(mal, 150, now = at("11:30")),
        limitBy(bob, 250, now = at("13:30"))
      )
      tradingOf(history.lot).currentPrice shouldBe money(251)

      val removed = removedEvent(removing(history, mal, now = at("15:00"))._1)

      (removed.leader, removed.price) shouldBe (Some(participant(ann)), money(251))
    }

    // Окно без `from` начинается в момент команды аукциона, а лот записывает его позже: вход между ними шёл по обычному
    // шагу, и переигрывание обязано дать ему тот же шаг.
    "give a window launched during the trading only to the entries after its row, even inside its time" in {
      val happyHours = stepWindow("13:00", "14:00", step = 1)
      val before = played(opened(), limitBy(ann, 300, now = at("11:00")), bidBy(mal, 150, now = at("13:10")))
      tradingOf(before.lot).currentPrice shouldBe money(160)
      val (launch, launched) = before.addWindow(AddStepWindow(happyHours, op(before.entries.size + 1)))
      launch.isRight shouldBe true
      val history = played(launched, limitBy(bob, 250, now = at("13:30")))
      tradingOf(history.lot).currentPrice shouldBe money(251)

      val removed = removedEvent(removing(history, bob, now = at("15:00"))._1)

      (removed.leader, removed.price) shouldBe (Some(participant(ann)), money(160))
    }

    "extend the deadline once without spending an extension when the removal changes the leader in the window (Т-90)" in {
      val history = t82()
      val late = deadline.minus(Duration.ofSeconds(30))
      val exhausted = history.copy(lot =
        history.lot.copy(state =
          LotState.Trading(tradingOf(history.lot).copy(extensionsUsed = antiSnipe.maxExtensions))
        )
      )

      List(history -> 0, exhausted -> antiSnipe.maxExtensions).foreach { (journal, used) =>
        derivedOf(removing(journal, bob, now = late)._1) shouldBe
          List(LotEvent.DeadlineExtended(deadline.plus(antiSnipe.extension), used))
      }
    }

    "not extend the deadline when the removal in the window keeps the leader and the price (Т-91)" in {
      val z = 5
      val history = played(opened(), limitBy(z, 290), bidBy(ann, 300))

      derivedOf(removing(history, z, now = deadline.minus(Duration.ofSeconds(30)))._1) shouldBe Nil
    }

    "not extend a deadline outside the window" in {
      derivedOf(removing(t82(), mal)._1) shouldBe Nil
    }

    "refuse a removal at the deadline before the close arrives (Т-92)" in {
      val (result, journal) = removing(t82(), mal, now = deadline)

      result shouldBe Left(RemoveParticipantRejected.DeadlinePassed)
      journal.entries.size shouldBe t82().entries.size
    }

    "remove from a held lot, keep it held, record no extension and resume the final with the replayed leader (Т-93)" in {
      val marked = played(t82(), journal => journal.mark(markForFinal(journal.entries.size + 1)))
      val (_, holding) = marked.close(closeLot(opN = marked.entries.size + 1), deadline)
      val withHeldLimit = played(holding, limitBy(cid, 500))
      val n = withHeldLimit.entries.size + 1

      val (result, removed) = removing(withHeldLimit, mal, now = deadline.plus(Duration.ofHours(1)))
      val (_, resumed) = removed.resume(resumeLot(opN = n + 1))

      result shouldBe Right(
        Decision.Accepted(
          LotEvent.ParticipantRemoved(participant(mal), money(310), Some(participant(bob)), Some(position(n)))
        )
      )
      val held = heldOf(removed.lot)
      (held.leader, held.currentPrice, held.proxyLimits.keySet) shouldBe
        (Some(participant(bob)), money(310), Set(participant(ann), participant(cid)))
      val live = tradingOf(resumed.lot)
      live.phase shouldBe Phase.Live
      live.leader shouldBe Some(participant(cid))
    }

    "refuse a removal in the live final, on a sold lot and of a person with no bid or limit (Т-94)" in {
      val marked = played(t82(), journal => journal.mark(markForFinal(journal.entries.size + 1)))
      val (_, holding) = marked.close(closeLot(opN = marked.entries.size + 1), deadline)
      val (_, live) = holding.resume(resumeLot(opN = holding.entries.size + 1))
      val (_, sold) = t82().close(closeLot(opN = 50), deadline)

      removing(live, mal)._1 shouldBe Left(RemoveParticipantRejected.NotInOnlinePhase)
      removing(sold, mal)._1 shouldBe Left(RemoveParticipantRejected.LotNotOpen)
      removing(t82(), who = 9)._1 shouldBe Left(RemoveParticipantRejected.NotALotParticipant)
      removing(Journal.of(drafted), mal)._1 shouldBe Left(RemoveParticipantRejected.LotNotOpen)
      Lot.decide(Lot.initial, removeParticipant(mal, 1), position(1), calm) shouldBe
        Left(RemoveParticipantRejected.LotNotFound)
    }

    "refuse the removed participant a bid and a limit on the lot, and let rules no longer see their limit (Т-95)" in {
      val history = played(opened(), limitBy(mal, 900), bidBy(ann, 200))
      val (_, removed) = removing(history, mal)

      val (bidResult, afterBid) = bidBy(mal, 400)(removed)
      val (limitResult, afterLimit) = limitBy(mal, 1000)(removed)
      val (_, outbid) = bidBy(bob, 300)(removed)

      bidResult shouldBe Left(PlaceBidRejected.ParticipantRemovedFromLot)
      limitResult shouldBe Left(SetProxyLimitRejected.ParticipantRemovedFromLot)
      (afterBid.entries, afterLimit.entries) shouldBe (removed.entries, removed.entries)
      tradingOf(outbid.lot).leader shouldBe Some(participant(bob))
    }

    "answer a repeat of the removal with the original and another op_id with ParticipantAlreadyRemoved (Т-96)" in {
      val history = t82()
      val command = removeParticipant(mal, history.entries.size + 1)
      val (_, removed) = history.remove(command)

      removed.remove(command)._1 shouldBe Right(Decision.Repeated(removed.entries.last))
      removed.remove(RemoveParticipant(participant(bob), command.opId))._1 shouldBe
        Left(RemoveParticipantRejected.OpIdTaken)
      removing(removed, mal)._1 shouldBe Left(RemoveParticipantRejected.ParticipantAlreadyRemoved)
    }

    "replay without everyone removed earlier on a second removal" in {
      val (_, withoutM) = removing(t82(), mal)

      val removed = removedEvent(removing(withoutM, bob)._1)

      (removed.leader, removed.price) shouldBe (Some(participant(ann)), money(100))
    }

    "restore the history and the removed participants from the journal alone" in {
      val (_, removed) = removing(t82(), mal)

      Lot.replay(scheduled(startingPrice = 100), removed.rows) shouldBe removed.lot
    }

    "end like trading without the removed participants did, at most at the price before, on histories without refusals or extensions" in {
      forAll(histories) { history =>
        val outcome = oracle(history)
        whenever(outcome.isDefined) {
          val (removal, expected) = outcome.get
          val price = if (expected.currentPrice <= removal.ceiling) expected.currentPrice else removal.ceiling
          (removal.leader, removal.price) shouldBe (expected.leader, price)
        }
      }
    }

    "never raise the price, and give the leader a position at the price, on any history" in {
      forAll(histories) { history =>
        val journal = play(opened(windows = history.windows), history.moves)
        candidates(journal).foreach { who =>
          val before = tradingOf(journal.lot)
          removing(journal, who, now = history.removedAt)._1 match {
            case Right(Decision.Accepted(removed: LotEvent.ParticipantRemoved, _)) =>
              removed.price.minorUnits should be <= before.currentPrice.minorUnits
              removed.leader.isDefined shouldBe removed.leadingBidId.isDefined
              if (removed.leader.isEmpty) removed.price shouldBe money(100)
            case Left(RemoveParticipantRejected.DeadlinePassed) => ()
            case other => fail(s"снятие $who не принято: $other")
          }
        }
      }
    }

    "change the leader and lower the price often enough on the generated histories for the oracle to mean something" in {
      val sample = (1 to 300).flatMap(n => histories.apply(Gen.Parameters.default, Seed(n.toLong)))
      val decided = sample.flatMap(oracle)
      val changed = decided.count((removal, _) => removal.leader != removal.before.leader)
      val lowered = decided.count((removal, _) => removal.price < removal.before.currentPrice)

      decided.size should be >= 100
      changed should be >= decided.size / 10
      lowered should be >= decided.size / 10
    }
  }

  /**
   * История торгов для свойств: ходы участников 1…4 и, в половине случаев, окно сниженного шага посреди неё. Суммы
   * берутся от состояния лота в момент хода — следующая цена или нижняя граница плюс несколько шагов, — поэтому часты
   * равные лимиты, ручная ставка, равная лимиту, и лимит на уровне цены (Т-85, Т-86).
   */
  private final case class History(moves: List[(String, Int, Int)], windows: List[StepWindow], removedAt: Instant)

  private val histories: Gen[History] =
    for {
      size <- Gen.chooseNum(1, 14)
      moves <- Gen.listOfN(
        size,
        for {
          kind <- Gen.frequency(4 -> "limit", 4 -> "bid", 1 -> "withdraw")
          who <- Gen.chooseNum(1, 4)
          steps <- Gen.frequency(3 -> Gen.const(0), 4 -> Gen.chooseNum(1, 4), 2 -> Gen.chooseNum(5, 30))
        } yield (kind, who, steps)
      )
      windowed <- Gen.oneOf(true, false)
      removedAt <- Gen.frequency(3 -> Gen.const(calm), 1 -> Gen.const(deadline.minus(Duration.ofSeconds(30))))
    } yield History(moves, if (windowed) List(stepWindow("10:03", "10:08", step = 1)) else Nil, removedAt)

  /** Момент хода `index`: минута за минутой с 10:00, так что часть ходов попадает в окно 10:03–10:08. */
  private def momentOf(index: Int): Instant = at("10:00").plus(Duration.ofMinutes(index.toLong))

  private type Played = (String, Int, Long, Instant)

  /** Ходы, сыгранные по лоту: ход, которого лот не принял бы, пропускается — в журнал попадает только принятое. */
  private def accepted(start: Journal, moves: List[(String, Int, Int)]): (Journal, List[Played]) =
    moves.zipWithIndex.foldLeft((start, List.empty[Played])) { case ((journal, done), ((kind, who, steps), index)) =>
      val now = momentOf(index)
      val trading = tradingOf(journal.lot)
      val move = kind match {
        case "bid" if !trading.leader.contains(participant(who)) =>
          Some(("bid", who, Lot.minRequired(trading, now).minorUnits + 10L * steps))
        case "limit" => Some(("limit", who, Lot.floor(trading).minorUnits + 10L * steps))
        case "withdraw" if trading.proxyLimits.contains(participant(who)) => Some(("withdraw", who, 0L))
        case _ => None
      }
      move
        .flatMap((k, p, amount) => perform(journal, k, p, amount, now).map(next => (next, done :+ (k, p, amount, now))))
        .getOrElse((journal, done))
    }

  private def perform(journal: Journal, kind: String, who: Int, amount: Long, now: Instant): Option[Journal] = {
    val n = journal.entries.size + 1
    val (result, next) = kind match {
      case "bid" => journal.submit(placeBid(who, amount, n), bid(n), now)
      case "limit" => journal.limit(setProxyLimit(who, amount, n), now)
      case _ => journal.withdraw(withdrawProxyLimit(who, n))
    }
    Option.when(result.isRight)(next)
  }

  private def play(start: Journal, moves: List[(String, Int, Int)]): Journal = accepted(start, moves)._1

  /** Участники лота: у кого есть ставка или выставленный лимит (ADR-072, п. 1). */
  private def candidates(journal: Journal): List[Int] =
    (1 to 4).toList.filter { who =>
      journal.entries.exists(_.event match {
        case LotEvent.BidPlaced(_, p, _, _, BidOrigin.Manual(_), _) => p == participant(who)
        case LotEvent.ProxyLimitSet(p, _) => p == participant(who)
        case _ => false
      })
    }

  /** Итог последнего снятия, торги до первого и цена перед последним — потолок цены снятия (И-23). */
  private final case class Removal(leader: Option[ParticipantId], price: Money, before: TradingState, ceiling: Money)

  /**
   * Оракул ADR-072: на лоте без дедлайна, где продлений нет, снимаются один или два участника, а те же принятые команды
   * оставшихся с теми же моментами прогоняются через агрегат целиком. Если там хоть одна получила бы отказ, история
   * оракулу не подходит.
   */
  private def oracle(history: History): Option[(Removal, TradingState)] = {
    val (journal, played) = accepted(opened(closesAt = None, windows = history.windows), history.moves)
    val who = candidates(journal)
    Option
      .when(who.nonEmpty) {
        val removedSet = if (who.size > 2 && history.moves.size % 2 == 0) who.take(2) else who.take(1)
        val (last, ceiling, _) = removedSet.foldLeft((Option.empty[LotEvent.ParticipantRemoved], money(100), journal)) {
          case ((_, _, current), r) =>
            val (result, next) = removing(current, r)
            (Some(removedEvent(result)), tradingOf(current.lot).currentPrice, next)
        }
        val replayed = played
          .filterNot((_, p, _, _) => removedSet.contains(p))
          .foldLeft(Option(opened(closesAt = None, windows = history.windows))) {
            case (Some(current), (kind, p, amount, now)) => perform(current, kind, p, amount, now)
            case (None, _) => None
          }
        replayed.map { expected =>
          val removal = last.get
          (Removal(removal.leader, removal.price, tradingOf(journal.lot), ceiling), tradingOf(expected.lot))
        }
      }
      .flatten
  }
}
