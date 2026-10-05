package auction.lot

import auction.lot.LotFixtures.*
import org.scalacheck.Gen
import org.scalacheck.Prop
import org.scalacheck.Prop.propBoolean
import org.scalacheck.commands.Commands
import org.scalatest.wordspec.AnyWordSpec
import org.scalatestplus.scalacheck.Checkers

import scala.util.Random
import scala.util.Try

/**
 * Последовательности команд ставки против независимой референсной модели (testing-strategy.md, L4).
 *
 * Порядок здесь и есть предмет проверки: залп равных сумм, повтор принятого и отклонённого `op_id` — своим участником и
 * чужим, — смена лидера. Модель держит цену, лидера и принятые `op_id` на примитивах и считает шаг своим способом, а не
 * через [[StepPolicy.step]], поэтому расхождение ядра с правилами RFC-011 не прячется за общей реализацией.
 */
final class LotCommandsSpec extends AnyWordSpec with Checkers {

  "lot" should {

    "answer every sequence of bids exactly as the reference model of RFC-011 does" in {
      check(LotCommands.property(), MinSuccessful(200))
    }
  }
}

object LotCommands extends Commands {

  /** Референсная модель: только примитивы, никаких типов ядра, кроме фазы. */
  final case class Model(
      phase: Phase,
      tiers: List[(Long, Long)],
      price: Long,
      leader: Option[Int],
      accepted: Map[Int, (Int, Long)],
      lastOp: Int
  ) {
    def step(at: Long): Long = tiers.filter((bound, _) => bound <= at).last._2

    def next: Long = price + step(price)
  }

  /** Ожидаемый ответ модели на команду. */
  enum Expected {
    case Accept(who: Int, amount: Long, previousLeader: Option[Int])
    case Repeat(original: (Int, Long))
    case Reject(rejection: PlaceBidRejected)
  }

  final case class Outcome(result: Either[PlaceBidRejected, Decision], journal: Journal, start: Lot)

  final class Sut(val start: Lot) {
    var journal: Journal = Journal.of(start)
    var bids: Int = 0
  }

  type State = Model

  def canCreateNewSut(newState: State, initSuts: Iterable[State], runningSuts: Iterable[Sut]): Boolean = true

  def newSut(state: State): Sut =
    new Sut(trading(price = state.price, policy = tiered(state.tiers*), phase = state.phase))

  def destroySut(sut: Sut): Unit = ()

  def initialPreCondition(state: State): Boolean = state.accepted.isEmpty && state.leader.isEmpty

  def genInitialState: Gen[State] =
    for {
      phase <- Gen.oneOf(Phase.Online, Phase.Live)
      tiers <- Gen.oneOf(List(0L -> 10L), List(0L -> 10L, 150L -> 20L))
    } yield Model(phase, tiers, price = 100, leader = None, accepted = Map.empty, lastOp = 0)

  def genCommand(state: State): Gen[Command] = {
    // Сумма залпа — следующая цена от старта: равные ставки разных участников приходят подряд.
    val volley = 100 + state.step(100)
    val amounts = Gen.frequency(
      4 -> Gen.const(state.next),
      3 -> Gen.const(volley),
      2 -> Gen.chooseNum(1L, 40L).map(state.next + _),
      2 -> Gen.chooseNum(1L, 15L).map(state.next - _)
    )
    val ops = Gen.frequency(3 -> Gen.const(state.lastOp + 1), 1 -> Gen.chooseNum(1, math.max(1, state.lastOp)))
    for {
      who <- Gen.chooseNum(1, 4)
      amount <- amounts
      opN <- ops
      foreign <- Gen.frequency(11 -> false, 1 -> true)
    } yield Bid(who, amount, opN, foreign)
  }

  final case class Bid(who: Int, amount: Long, opN: Int, foreign: Boolean) extends Command {

    type Result = Outcome

    private def command: PlaceBid = placeBid(who, amount, opN, if (foreign) eur else rub)

    def run(sut: Sut): Result = {
      sut.bids += 1
      val (result, next) = sut.journal.submit(command, bid(sut.bids))
      sut.journal = next
      Outcome(result, next, sut.start)
    }

    private def expected(state: State): Expected =
      state.accepted.get(opN) match {
        case Some(original @ (owner, _)) =>
          if (owner == who) Expected.Repeat(original) else Expected.Reject(PlaceBidRejected.OpIdTaken)
        case None =>
          val required = state.next
          if (foreign) Expected.Reject(PlaceBidRejected.CurrencyMismatch)
          else if (state.leader.contains(who)) Expected.Reject(PlaceBidRejected.BidderIsLeader(money(state.price)))
          else if (state.phase == Phase.Live && amount != required)
            Expected.Reject(PlaceBidRejected.BidNotAtNextPrice(money(required)))
          else if (amount < required) Expected.Reject(PlaceBidRejected.BidBelowMinimum(money(required)))
          else Expected.Accept(who, amount, state.leader)
      }

    def nextState(state: State): State = {
      val advanced = state.copy(lastOp = math.max(state.lastOp, opN))
      expected(state) match {
        case Expected.Accept(_, _, _) =>
          advanced.copy(price = amount, leader = Some(who), accepted = state.accepted.updated(opN, (who, amount)))
        case _ => advanced
      }
    }

    def preCondition(state: State): Boolean = true

    def postCondition(state: State, result: Try[Result]): Prop = {
      val after = nextState(state)
      result.toOption.fold(Prop.falsified :| "run threw") { outcome =>
        val answer = (expected(state), outcome.result) match {
          case (Expected.Accept(w, a, prev), Right(Decision.Accepted(placed: LotEvent.BidPlaced, _))) =>
            placed.participant == participant(w) && placed.amount == money(a) &&
            placed.previousLeader == prev.map(participant) && placed.origin == BidOrigin.Manual(BidSource.Bot)
          case (Expected.Repeat((w, a)), Right(Decision.Repeated(original))) =>
            original.opId == op(opN) && (original.event match {
              case placed: LotEvent.BidPlaced => placed.participant == participant(w) && placed.amount == money(a)
              case _ => false
            })
          case (Expected.Reject(rejection), Left(actual)) => rejection == actual
          case _ => false
        }
        val journal = outcome.journal
        val trading = tradingOf(journal.lot)
        val shuffled = new Random(journal.entries.size.toLong).shuffle(journal.entries)
        (answer :| s"answer ${outcome.result} for $this in $state") &&
        (journal.entries.size == after.accepted.size) :| "one journal entry per accepted op_id" &&
        (trading.leader == after.leader.map(participant)) :| "leader follows the model" &&
        (trading.currentPrice == money(after.price)) :| "price follows the model" &&
        (Lot.replay(outcome.start, shuffled) == journal.lot) :| "replay in sequence order restores the lot"
      }
    }
  }
}
