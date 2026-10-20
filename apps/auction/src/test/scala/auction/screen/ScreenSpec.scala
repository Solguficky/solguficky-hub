package auction.screen

import auction.aggregate.Auction
import auction.aggregate.AuctionFixtures
import auction.aggregate.AuctionState
import auction.aggregate.MeetupId
import auction.aggregate.MeetupLifecycle
import auction.aggregate.MeetupStanding
import auction.aggregate.MeetupVisibility
import auction.catalog.ImageVersion
import auction.catalog.LotCard
import auction.catalog.LotId
import auction.catalog.LotTitle
import auction.lot.BidOrigin
import auction.lot.BidSource
import auction.lot.Lot
import auction.lot.LotFixtures.*
import auction.lot.LotState
import auction.lot.ParticipantId
import auction.lot.Phase
import auction.lot.WithdrawnReason
import auction.projection.LotSnapshotView
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

final class ScreenSpec extends AnyWordSpec with Matchers {

  private val auctionId = UUID.fromString("01890a5d-ac97-7c2b-9f3a-0d1b2c3d4eaa")
  private val meetupId = UUID.fromString("01890a5d-ac97-7c2b-9f3a-0d1b2c3d4ebb")
  private val first = LotId(UUID.fromString("01890a5d-ac97-7c2b-9f3a-0d1b2c3d4e01"))
  private val second = LotId(UUID.fromString("01890a5d-ac97-7c2b-9f3a-0d1b2c3d4e02"))
  private val opened = op(9)

  private def auctionIn(state: AuctionState): Auction =
    Auction(state, Some(MeetupId(meetupId)), Set(first, second), Map.empty)

  private def view(lot: LotId, state: Lot, title: String = "Лот"): LotSnapshotView =
    LotSnapshotView(
      lot.value,
      auctionId,
      1,
      state,
      Some(LotCard(lot, LotTitle(title).toOption.get, "", Some(ImageVersion("v1"))))
    )

  private def reading(
      state: AuctionState,
      lineup: List[LotSnapshotView] = Nil,
      bids: List[RecentBid] = Nil,
      sold: List[SoldLot] = Nil
  ): ScreenReading =
    ScreenReading(auctionId, meetupId, auctionIn(state), lineup, bids, sold)

  private def name(participant: ParticipantId): String = s"@p${participant.value.getLeastSignificantBits}"

  private val visible = StandingAnswer.Found(MeetupStanding(MeetupLifecycle.Planned, MeetupVisibility.Visible))

  "the screen gate" should {

    "open the page of a visible meetup's auction" in {
      Screen.admit(auctionIn(AuctionState.Draft), visible) shouldBe Admission.Open
    }

    "answer not found alike for a hidden meetup, a missing one and one cancelled before trading" in {
      val hidden = StandingAnswer.Found(MeetupStanding(MeetupLifecycle.Planned, MeetupVisibility.Hidden))
      val cancelled = StandingAnswer.Found(MeetupStanding(MeetupLifecycle.Cancelled, MeetupVisibility.Visible))
      val scheduled = auctionIn(AuctionState.Scheduled(AuctionFixtures.config()))

      Screen.admit(scheduled, hidden) shouldBe Admission.NotFound
      Screen.admit(scheduled, StandingAnswer.Missing) shouldBe Admission.NotFound
      Screen.admit(scheduled, cancelled) shouldBe Admission.NotFound
    }

    "keep the page of an auction cancelled after trading started" in {
      val cancelled = StandingAnswer.Found(MeetupStanding(MeetupLifecycle.Cancelled, MeetupVisibility.Visible))
      val auction = auctionIn(AuctionState.Cancelled(AuctionFixtures.config(), opened, op(10)))

      Screen.admit(auction, cancelled) shouldBe Admission.Open
    }

    "not open the page while the meetup state cannot be confirmed" in {
      Screen.admit(auctionIn(AuctionState.Draft), StandingAnswer.Unavailable) shouldBe Admission.Unavailable
    }
  }

  "the screen state" should {

    "count down to the final before the lineup freezes and drop the countdown without a final" in {
      val withFinal = AuctionState.Prebidding(AuctionFixtures.config(), opened)
      val withoutFinal =
        AuctionState.Prebidding(AuctionFixtures.config(AuctionFixtures.configInput(finalBlocks = 0)), opened)

      Screen.of(reading(withFinal), name) shouldBe ScreenState.Upcoming(withFinal = true)
      Screen.of(reading(withoutFinal), name) shouldBe ScreenState.Upcoming(withFinal = false)
    }

    "show the lineup in its order once frozen and until the first lot goes out" in {
      val lineup = List(view(second, held(300, participant(1))), view(first, held(200, participant(2))))
      val frozen = AuctionState.LineupFrozen(AuctionFixtures.config(), opened, List(second, first))
      val started = AuctionState.Final(AuctionFixtures.config(), opened, List(second, first), Nil, Nil)

      val expected = ScreenState.Lineup(
        List(
          ScreenLot(second.value, Some("Лот"), Some(ImageVersion("v1"))),
          ScreenLot(first.value, Some("Лот"), Some(ImageVersion("v1")))
        )
      )
      Screen.of(reading(frozen, lineup), name) shouldBe expected
      Screen.of(reading(started, lineup), name) shouldBe expected
    }

    "show the active lot with its price, ask, leader by name and recent bids by channel" in {
      val live =
        trading(price = 700, phase = Phase.Live, leader = Some(participant(1)), ask = Some(750), closesAt = None)
      val state = AuctionState.Final(AuctionFixtures.config(), opened, List(second, first), List(second), Nil)
      val bids = List(
        RecentBid(participant(1), money(700), BidOrigin.Manual(BidSource.Floor)),
        RecentBid(participant(2), money(650), BidOrigin.Proxy),
        RecentBid(participant(1), money(600), BidOrigin.Manual(BidSource.Bot))
      )

      Screen.of(reading(state, List(view(second, live), view(first, held(200, participant(2)))), bids), name) shouldBe
        ScreenState.Live(
          LiveLot(
            ScreenLot(second.value, Some("Лот"), Some(ImageVersion("v1"))),
            money(700),
            Some(money(750)),
            Some("@p1"),
            List(
              ScreenBid("@p1", money(700), BidChannel.Hall),
              ScreenBid("@p2", money(650), BidChannel.Online),
              ScreenBid("@p1", money(600), BidChannel.Online)
            )
          )
        )
    }

    "show the outcome of the closed lot and the next one between lots" in {
      val state = AuctionState.Final(AuctionFixtures.config(), opened, List(second, first), List(second), List(second))
      val lineup = List(view(second, sold(900, participant(3))), view(first, held(200, participant(2))))

      Screen.of(reading(state, lineup), name) shouldBe ScreenState.Between(
        ClosedLot(ScreenLot(second.value, Some("Лот"), Some(ImageVersion("v1"))), Outcome.Sold(money(900), "@p3")),
        Some(ScreenLot(first.value, Some("Лот"), Some(ImageVersion("v1"))))
      )
    }

    "show an active lot sold before its completion is recorded as closed" in {
      val state = AuctionState.Final(AuctionFixtures.config(), opened, List(second), List(second), Nil)
      val withdrawn = lotIn(LotState.Withdrawn(WithdrawnReason.AuctionCancelled))

      Screen.of(reading(state, List(view(second, withdrawn))), name) shouldBe ScreenState.Between(
        ClosedLot(ScreenLot(second.value, Some("Лот"), Some(ImageVersion("v1"))), Outcome.Withdrawn),
        None
      )
    }

    "show an activated lot whose resumption is not yet read as the next one rather than an outcome" in {
      val previous = view(second, sold(900, participant(3)))
      val activated = view(first, held(200, participant(2)))
      val next =
        AuctionState.Final(AuctionFixtures.config(), opened, List(second, first), List(second, first), List(second))
      val firstOut = AuctionState.Final(AuctionFixtures.config(), opened, List(first), List(first), Nil)

      Screen.of(reading(next, List(previous, activated)), name) shouldBe ScreenState.Between(
        ClosedLot(ScreenLot(second.value, Some("Лот"), Some(ImageVersion("v1"))), Outcome.Sold(money(900), "@p3")),
        Some(ScreenLot(first.value, Some("Лот"), Some(ImageVersion("v1"))))
      )
      reading(next, List(previous, activated)).participants should contain(participant(3))
      Screen.of(reading(firstOut, List(activated)), name) shouldBe
        ScreenState.Lineup(List(ScreenLot(first.value, Some("Лот"), Some(ImageVersion("v1")))))
    }

    "total the whole auction, online and in the final from the sold lots" in {
      val finished = AuctionState.Finished(AuctionFixtures.config(), opened)
      val sales = List(
        SoldLot(money(500), inLineup = false),
        SoldLot(money(900), inLineup = true),
        SoldLot(money(100), inLineup = false)
      )

      Screen.of(reading(finished, sold = sales), name) shouldBe ScreenState.Finished(
        Totals(Sales(3, List(money(1500))), Sales(2, List(money(600))), Sales(1, List(money(900))))
      )
    }

    "name only the leader, bidders and buyer of the shown lot" in {
      val live = trading(price = 700, phase = Phase.Live, leader = Some(participant(1)), closesAt = None)
      val state = AuctionState.Final(AuctionFixtures.config(), opened, List(second), List(second), Nil)
      val bids = List(RecentBid(participant(2), money(650), BidOrigin.Proxy))

      reading(state, List(view(second, live)), bids).participants shouldBe Set(participant(1), participant(2))
    }
  }

  "the screen json" should {

    "carry the schema, the phase and the image address without anyone's identifier" in {
      val live = LiveLot(
        ScreenLot(second.value, Some("Лот"), Some(ImageVersion("v1"))),
        money(700),
        None,
        Some("@p1"),
        List(ScreenBid("@p1", money(700), BidChannel.Hall))
      )
      val json = ScreenJson.render(auctionId, ScreenState.Live(live))

      json should include(""""schema":1""")
      json should include(""""phase":"lot"""")
      json should include(s""""image":"/screen/$auctionId/lots/${second.value}/images/v1"""")
      json should include(""""ask":null""")
      json should include(""""channel":"hall"""")
      json should not include participant(1).value.toString
      json should not include "\n"
    }

    "say the final time is unknown before the lineup freezes" in {
      ScreenJson.render(auctionId, ScreenState.Upcoming(withFinal = true)) shouldBe
        """{"schema":1,"phase":"upcoming","final":true,"final_at":null}"""
    }
  }
}
