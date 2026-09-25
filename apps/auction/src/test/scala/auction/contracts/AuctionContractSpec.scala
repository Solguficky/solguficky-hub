package auction.contracts

import auction.v1.auction_events.{BidPlaced, LotEvent, LotState, ManualBid, ProxyBid, SessionState}
import auction.v1.auction_service.{AuctionService, LotSnapshot}
import com.google.protobuf.Descriptors.{Descriptor, FieldDescriptor}
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import scala.jdk.CollectionConverters.*

/**
 * Держит проверяемой кодогенерацию собственного контракта аукциона, как `IdentityContractSpec` держит чужой.
 *
 * Поведение торгов здесь не проверяется: ядра ещё нет. Проверяется то, что обещает схема и что прошлое поколение ломало
 * на проводе, — отсутствие значения остаётся отсутствием, а не нулём (дефект 5.7 архива, RFC-011 П-01).
 */
final class AuctionContractSpec extends AnyWordSpec with Matchers {

  "generated auction contract" should {

    // Прежний продюсер писал `PreviousLeaderId ?? 0` в optional-поле, взводил
    // признак присутствия всегда, и Notifications рассылал «вашу ставку
    // перебили» пользователю с id 0.
    "keeps the previous leader absent on the first bid after a round trip" in {
      val firstBid = BidPlaced(origin = BidPlaced.Origin.Manual(ManualBid()))

      BidPlaced.parseFrom(firstBid.toByteArray).previousLeaderId shouldBe None
    }

    "keeps a proxy bid free of a source" in {
      val proxyBid = BidPlaced(previousLeaderId = Some("0190a0e0-0000-7000-8000-000000000001"))
        .withProxy(ProxyBid())

      BidPlaced.parseFrom(proxyBid.toByteArray).origin.manual shouldBe None
    }

    "leaves the occasion unset on an event that carries none" in {
      LotEvent.parseFrom(LotEvent(eventId = "e", lotId = "l", version = 1).toByteArray).occasion.isEmpty shouldBe true
    }

    // Между лотами финала активного лота нет; `""` в этом поле читалось бы как
    // идентификатор лота, которого нет.
    "keeps the active lot absent between the lots of the final after a round trip" in {
      val between = SessionState(id = "s").withInFinal(SessionState.Final(order = Seq("l")))

      SessionState.parseFrom(between.toByteArray).status.inFinal.flatMap(_.activeLotId) shouldBe None
    }

    // Снимок факта на шине и снимок чтения — два определения с обещанием «номера
    // полей совпадают». Ни buf, ни гейт nats-tester их не сравнивают: до этого
    // теста зеркальность держалась на комментарии в схеме.
    "keeps the lot state of the bus aligned with the read snapshot field for field" in {
      // Имя, тип, label и принадлежность oneof: поле, вынесенное из `status`
      // наверх с тем же номером и типом, — тоже расхождение.
      def shape(descriptor: Descriptor): Map[Int, (String, String, String, Option[String])] =
        descriptor.getFields.asScala.map { field =>
          val typeName = field.getType match {
            case FieldDescriptor.Type.MESSAGE => field.getMessageType.getFullName
            case FieldDescriptor.Type.ENUM => field.getEnumType.getFullName
            case other => other.name
          }
          val label = if (field.toProto.getProto3Optional) "optional" else field.toProto.getLabel.name
          field.getNumber -> (field.getName, typeName, label, Option(field.getContainingOneof).map(_.getName))
        }.toMap

      val state = shape(LotState.javaDescriptor)
      val snapshot = shape(LotSnapshot.javaDescriptor)
      val reservedByState = LotState.javaDescriptor.toProto.getReservedRangeList.asScala
        .flatMap(range => range.getStart until range.getEnd)

      state.foreach { case (number, field) => snapshot.get(number) shouldBe Some(field) }
      (snapshot.keySet -- state.keySet) should contain theSameElementsAs reservedByState
    }

    // Серверный трейт генерирует pekko-grpc поверх того же ScalaPB (ADR-048).
    // Ссылка на тип держит его появление в сборке: пропавшая генерация роняет
    // компиляцию этого теста, а не первого обработчика, который его реализует.
    "exposes the server side of the service" in {
      AuctionService.name shouldBe "auction.v1.AuctionService"
    }
  }
}
