package auction.projection

import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.time.Instant
import java.util.UUID

final class LotContestSpec extends AnyWordSpec with Matchers {

  private val lotId = new UUID(9L, 9L)
  private val start = Instant.parse("2026-10-20T00:00:00Z")

  private def person(n: Int): UUID = new UUID(1L, n.toLong)

  private val (ann, bob, cid) = (person(1), person(2), person(3))

  // Сочинённая хронология: запись на минуту, номер события — её позиция. Снятие участника — `None` вместо автора.
  private def chronicle(entries: (Option[UUID], Boolean, Option[UUID])*): List[HistoryRecord] =
    entries.toList.zipWithIndex.map { case ((author, removed, leader), index) =>
      val sequence = index.toLong + 1
      val at = start.plusSeconds(60L * index)
      author.fold(HistoryRecord.Removal(sequence, 100 * sequence, "EUR", leader, at)) { participant =>
        HistoryRecord.Bid(
          BidRecord(
            lotId,
            sequence,
            new UUID(2L, sequence),
            participant,
            100 * sequence,
            "EUR",
            "manual",
            None,
            at,
            removed
          )
        )
      }
    }

  private def bid(participant: UUID) = (Some(participant), false, None)
  private def removedBid(participant: UUID) = (Some(participant), true, None)
  private def removal(leader: Option[UUID]) = (None, false, leader)

  private def bids(participants: UUID*): List[HistoryRecord] = chronicle(participants.map(bid)*)

  "lot contest" should {

    "has no leader change and no duel for a lot without bids" in {
      LotContest.of(Nil) shouldBe LotContest(0, 0)
    }

    "does not count the first bid as a leader change" in {
      LotContest.of(bids(ann)) shouldBe LotContest(0, 0)
    }

    "counts every bid that takes the lead from another person" in {
      LotContest.of(bids(ann, bob, cid, ann)).leaderChanges shouldBe 3
    }

    "measures a duel by the leader changes between the same two people in a row" in {
      LotContest.of(bids(ann, bob, ann, bob, ann)) shouldBe LotContest(4, 4)
    }

    "ends a duel when a third person takes the lead" in {
      LotContest.of(bids(ann, bob, ann, cid, ann, cid)) shouldBe LotContest(5, 3)
    }

    "keeps the longest of several duels" in {
      LotContest.of(bids(ann, bob, ann, cid, bob, cid, bob, cid)) shouldBe LotContest(7, 4)
    }

    "treats consecutive bids of one leader as one position, not a change" in {
      LotContest.of(bids(ann, bob, bob, ann)) shouldBe LotContest(2, 2)
    }

    "drops the bids of a removed participant from the contest" in {
      val contest =
        LotContest.of(chronicle(bid(ann), removedBid(cid), bid(bob), removedBid(cid), bid(ann), removal(Some(ann))))
      contest shouldBe LotContest(2, 2)
    }

    "does not count a removal as a leader change and ends the duel when it changes the leader" in {
      val contest = LotContest.of(chronicle(bid(ann), bid(bob), bid(ann), removal(Some(bob)), bid(ann), bid(bob)))
      contest shouldBe LotContest(4, 2)
    }

    "starts afresh after a removal that leaves the lot without a leader" in {
      LotContest.of(chronicle(removedBid(ann), removal(None), bid(bob))) shouldBe LotContest(0, 0)
    }

    "counts inside a window only, with the leader at its opening taken from the bids before it" in {
      // Ставки на минутах 0–4: ann, bob, ann, bob, ann; окно — с минуты 2 по минуту 4 не включая.
      val window = Some((start.plusSeconds(120), start.plusSeconds(240)))
      LotContest.of(bids(ann, bob, ann, bob, ann), window) shouldBe LotContest(2, 2)
    }

    "counts a duel that began before the window from its first change inside it" in {
      val window = Some((start.plusSeconds(180), start.plusSeconds(600)))
      LotContest.of(bids(ann, bob, ann, bob, ann, bob), window) shouldBe LotContest(3, 3)
    }
  }
}
