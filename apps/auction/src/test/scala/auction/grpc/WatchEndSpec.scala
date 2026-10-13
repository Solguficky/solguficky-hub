package auction.grpc

import auction.v1.auction as model
import auction.v1.auction_events.AuctionState
import auction.v1.auction_service as wire
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Когда `WatchAuction` закрывается (ADR-047, дополнение 2026-10-12): после законченного аукциона сразу, после
 * отменённого — когда ни один лот состава уже не торгуется и не удержан, чтобы последнее сообщение несло снятые лоты.
 */
final class WatchEndSpec extends AnyWordSpec with Matchers {

  private def watch(status: wire.AuctionSnapshot.Status, lineup: wire.LotSnapshot*): wire.AuctionWatch =
    wire.AuctionWatch(auction = Some(wire.AuctionSnapshot(status = status)), lineup = lineup)

  private val trading = wire.LotSnapshot().withTrading(model.LotTrading())
  private val held = wire.LotSnapshot().withHeld(model.LotHeld())
  private val withdrawn =
    wire.LotSnapshot().withWithdrawn(model.WithdrawnReason.WITHDRAWN_REASON_AUCTION_CANCELLED)
  private val cancelled = wire.AuctionSnapshot.Status.Cancelled(AuctionState.Cancelled())

  "the end of the auction watch" should {

    "come right after a finished auction, whatever its lineup" in {
      AuctionGrpcService.terminal(
        watch(wire.AuctionSnapshot.Status.Finished(AuctionState.Finished()), trading)
      ) shouldBe
        true
    }

    "come after a cancelled auction only once no lot of the lineup trades or is held" in {
      AuctionGrpcService.terminal(watch(cancelled)) shouldBe true
      AuctionGrpcService.terminal(watch(cancelled, withdrawn)) shouldBe true
      AuctionGrpcService.terminal(watch(cancelled, withdrawn, trading)) shouldBe false
      AuctionGrpcService.terminal(watch(cancelled, held)) shouldBe false
    }

    "not come while the auction is in the final" in {
      AuctionGrpcService.terminal(
        watch(wire.AuctionSnapshot.Status.InFinal(AuctionState.Final()), withdrawn)
      ) shouldBe false
    }
  }
}
