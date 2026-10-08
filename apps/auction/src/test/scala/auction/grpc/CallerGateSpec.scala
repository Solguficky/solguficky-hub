package auction.grpc

import auction.v1.auction_service.AuctionService
import com.typesafe.config.ConfigFactory
import org.scalatest.EitherValues
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import scala.jdk.CollectionConverters.*

final class CallerGateSpec extends AnyWordSpec with Matchers with EitherValues {

  private val table = CallerTable
    .fromConfig(
      ConfigFactory.parseString("""auction.grpc.callers { hub-bot = "hub", auction-bot = "auction" }"""),
      MethodAccess.declared
    )
    .value

  private val placeBid = Some("PlaceBid")

  "caller gate" should {

    "admits only the hub bot on lot statistics" in {
      CallerGate.decide(table, Some("GetAuctionLotStatistics"), Some("Bearer hub")) shouldBe
        GateDecision.Admitted(Caller.HubBot)
      CallerGate.decide(table, Some("GetAuctionLotStatistics"), Some("Bearer auction")) shouldBe
        GateDecision.Refused(CallerRefusal.NotDeclared, Some(Caller.AuctionBot))
    }

    "admits only the auction bot on the FAQ methods" in {
      List("GetFaqAcknowledgement", "AcknowledgeFaq").foreach { method =>
        CallerGate.decide(table, Some(method), Some("Bearer auction")) shouldBe GateDecision.Admitted(Caller.AuctionBot)
        CallerGate.decide(table, Some(method), Some("Bearer hub")) shouldBe
          GateDecision.Refused(CallerRefusal.NotDeclared, Some(Caller.HubBot))
      }
    }

    "admits only the hub bot on the conditions of a lot" in {
      CallerGate.decide(table, Some("ScheduleLot"), Some("Bearer hub")) shouldBe GateDecision.Admitted(Caller.HubBot)
      CallerGate.decide(table, Some("ScheduleLot"), Some("Bearer auction")) shouldBe
        GateDecision.Refused(CallerRefusal.NotDeclared, Some(Caller.AuctionBot))
    }

    "admits a declared caller that presents its bearer token" in {
      CallerGate.decide(table, placeBid, Some("Bearer hub")) shouldBe GateDecision.Admitted(Caller.HubBot)
      CallerGate.decide(table, placeBid, Some("bearer auction")) shouldBe GateDecision.Admitted(Caller.AuctionBot)
    }

    "refuses a call without an authorization header as a missing token" in {
      CallerGate.decide(table, placeBid, None) shouldBe GateDecision.Refused(CallerRefusal.MissingToken, None)
    }

    "refuses a credential that is not a bearer token as a missing token" in {
      CallerGate.decide(table, placeBid, Some("Basic hub")) shouldBe
        GateDecision.Refused(CallerRefusal.MissingToken, None)
    }

    "refuses a token no caller holds as an unknown token" in {
      CallerGate.decide(table, placeBid, Some("Bearer stranger")) shouldBe
        GateDecision.Refused(CallerRefusal.UnknownToken, None)
    }

    "refuses a known caller on a method that does not declare it and names the caller" in {
      CallerGate.decide(table, Some("Unknown"), Some("Bearer hub")) shouldBe
        GateDecision.Refused(CallerRefusal.NotDeclared, Some(Caller.HubBot))
      CallerGate.decide(table, None, Some("Bearer hub")) shouldBe
        GateDecision.Refused(CallerRefusal.NotDeclared, Some(Caller.HubBot))
    }
  }

  "method access" should {

    "declares callers for exactly the methods of the service contract" in {
      val contract = AuctionService.descriptor.findServiceByName("AuctionService").getMethods.asScala.map(_.getName)
      MethodAccess.byMethod.keySet shouldBe contract.toSet
    }

    "names the method of a path inside the service only" in {
      MethodAccess.methodOf("/auction.v1.AuctionService/PlaceBid") shouldBe Some("PlaceBid")
      MethodAccess.methodOf("/auction.v1.AuctionService/") shouldBe None
      MethodAccess.methodOf("/identity.v1.IdentityService/ResolveIdentity") shouldBe None
      MethodAccess.methodOf("/health") shouldBe None
    }
  }
}
