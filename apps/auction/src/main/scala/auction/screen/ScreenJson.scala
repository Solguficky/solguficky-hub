package auction.screen

import auction.lot.Money
import auction.prediction.Nomination
import auction.results.NominationValue
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.JsonNodeFactory
import com.fasterxml.jackson.databind.node.ObjectNode

import java.util.UUID

/**
 * JSON состояния экрана — `data` события `state` (ADR-040, дополнение 2026-10-19). Это браузерная граница, а не NATS
 * или gRPC, поэтому JSON правило Protobuf не нарушает; поля описаны в integration.md. Номер схемы — поле `schema`:
 * несовместимая правка формы поднимает его, и страница, которая его не знает, показывает «Подключение».
 */
object ScreenJson {

  val Schema: Int = 1

  private val nodes = JsonNodeFactory.instance
  private val mapper = ObjectMapper()

  /** `predictions` — итоги прогнозов: поле `predictions` несёт только итог завершённого аукциона (PER-839). */
  def render(auctionId: UUID, state: ScreenState, predictions: List[ScreenNomination] = Nil): String = {
    val root = nodes.objectNode()
    root.put("schema", Schema)
    state match {
      case ScreenState.Upcoming(withFinal, finalAt) =>
        root.put("phase", "upcoming")
        root.put("final", withFinal)
        // Ориентировочное время финала: администратор выставляет его как анонс трансляции (ADR-040, дополнение
        // 2026-10-19). Без него экран пишет «скоро».
        optional(root, "final_at", finalAt.map(at => nodes.textNode(at.toString)))
      case ScreenState.Lineup(lots, finalAt) =>
        root.put("phase", "lineup")
        optional(root, "final_at", finalAt.map(at => nodes.textNode(at.toString)))
        val lineup = root.putArray("lineup")
        lots.foreach(lot => lineup.add(this.lot(auctionId, lot)))
      case ScreenState.Live(live) =>
        root.put("phase", "lot")
        val active = this.lot(auctionId, live.lot)
        active.set[JsonNode]("price", money(live.price))
        optional(active, "ask", live.ask.map(money))
        // Следующая цена — главная цифра страницы; остальное — подпись к ней: шаг, время лота и база роста (PER-819).
        active.set[JsonNode]("next", money(live.next))
        active.set[JsonNode]("step", money(live.step))
        optional(active, "started_at", live.startedAt.map(at => nodes.textNode(at.toString)))
        optional(active, "start", live.startingPrice.map(money))
        optional(active, "online_end", live.onlineEndPrice.map(money))
        optional(active, "leader", live.leader.map(nodes.textNode))
        val bids = active.putArray("bids")
        live.bids.foreach { bid =>
          val node = bids.addObject()
          node.put("name", bid.name)
          node.set[JsonNode]("amount", money(bid.amount))
          node.put("channel", channel(bid.channel))
        }
        root.set[JsonNode]("lot", active)
      case ScreenState.Between(closed, next) =>
        root.put("phase", "between")
        val node = this.lot(auctionId, closed.lot)
        closed.outcome match {
          case Outcome.Sold(price, buyer) =>
            node.put("outcome", "sold")
            node.set[JsonNode]("price", money(price))
            node.put("buyer", buyer)
          case Outcome.Unsold => node.put("outcome", "unsold")
          case Outcome.Withdrawn => node.put("outcome", "withdrawn")
        }
        root.set[JsonNode]("closed", node)
        optional(root, "next", next.map(this.lot(auctionId, _)))
      case ScreenState.Finished(sold, totals) =>
        root.put("phase", "finished")
        root.set[JsonNode]("sold", this.sold(auctionId, sold))
        root.set[JsonNode]("totals", this.totals(totals))
        root.set[JsonNode]("predictions", this.predictions(predictions))
      case ScreenState.Cancelled(sold, totals) =>
        root.put("phase", "cancelled")
        root.set[JsonNode]("sold", this.sold(auctionId, sold))
        root.set[JsonNode]("totals", this.totals(totals))
    }
    mapper.writeValueAsString(root)
  }

  /** Адрес изображения меняется вместе с версией, поэтому ответ по нему кэшируется без срока. */
  def imagePath(auctionId: UUID, lotId: UUID, version: String): String =
    s"/screen/$auctionId/lots/$lotId/images/$version"

  private def lot(auctionId: UUID, lot: ScreenLot): ObjectNode = {
    val node = nodes.objectNode()
    node.put("id", lot.lotId.toString)
    optional(node, "title", lot.title.map(nodes.textNode))
    optional(node, "image", lot.image.map(image => nodes.textNode(imagePath(auctionId, lot.lotId, image.value))))
    node
  }

  /** Отсутствие — явный `null`, а не пропущенный ключ: страница отличает «нет» от схемы, где поля нет. */
  private def optional(node: ObjectNode, key: String, value: Option[JsonNode]): Unit =
    value match {
      case Some(present) => node.set[JsonNode](key, present)
      case None => node.putNull(key)
    }

  private def money(value: Money): ObjectNode = {
    val node = nodes.objectNode()
    node.put("amount", value.minorUnits)
    node.put("currency", value.currency.value)
    node
  }

  private def channel(value: BidChannel): String =
    value match {
      case BidChannel.Hall => "hall"
      case BidChannel.Online => "online"
    }

  /** Проданные лоты итога: цена, покупатель по имени и база роста, как у активного лота. */
  private def sold(auctionId: UUID, lots: List[ScreenSold]): com.fasterxml.jackson.databind.node.ArrayNode = {
    val array = nodes.arrayNode()
    lots.foreach { sold =>
      val node = this.lot(auctionId, sold.lot)
      node.set[JsonNode]("price", money(sold.price))
      node.put("buyer", sold.buyer)
      optional(node, "start", sold.startingPrice.map(money))
      optional(node, "online_end", sold.onlineEndPrice.map(money))
      node.put("in_final", sold.inFinal)
      array.add(node)
    }
    array
  }

  /**
   * Итоги прогнозов: номинация именем, общим с ботами, итоговое значение — лоты (`lots`, идентификаторы) или число
   * (`number`: сумма — в минорных единицах валюты продаж, ставки — штуками), число угадавших и их имена.
   */
  private def predictions(list: List[ScreenNomination]): com.fasterxml.jackson.databind.node.ArrayNode = {
    val array = nodes.arrayNode()
    list.foreach { nomination =>
      val node = array.addObject()
      node.put("nomination", nominationName(nomination.nomination))
      nomination.value match {
        case NominationValue.Lots(lots) =>
          val ids = node.putArray("lots")
          lots.toList.map(_.value.toString).sorted.foreach(ids.add)
          node.putNull("number")
        case NominationValue.Number(value) =>
          node.putNull("lots")
          node.put("number", value)
      }
      node.put("winners", nomination.winners)
      val names = node.putArray("names")
      nomination.names.foreach(names.add)
    }
    array
  }

  /** Имена номинаций — те же, что у ботов (`prediction-spec.ts` пакета ботов). */
  private def nominationName(nomination: Nomination): String =
    nomination match {
      case Nomination.MostExpensiveLot => "catalog-most-expensive-lot"
      case Nomination.TotalSales => "catalog-total-sales"
      case Nomination.MostBidsLot => "catalog-most-bids-lot"
      case Nomination.BiggestGrowthLot => "catalog-biggest-growth-lot"
      case Nomination.MostBiddersLot => "catalog-most-bidders-lot"
      case Nomination.TotalBids => "catalog-total-bids"
      case Nomination.FinalMostExpensiveLot => "final-most-expensive-lot"
      case Nomination.FinalTotalSales => "final-total-sales"
      case Nomination.FinalBiggestGrowthLot => "final-biggest-growth-lot"
      case Nomination.FinalTotalBids => "final-total-bids"
    }

  private def totals(value: Totals): ObjectNode = {
    val node = nodes.objectNode()
    node.set[JsonNode]("all", sales(value.all))
    node.set[JsonNode]("online", sales(value.online))
    node.set[JsonNode]("final", sales(value.inFinal))
    node
  }

  private def sales(value: Sales): ObjectNode = {
    val node = nodes.objectNode()
    node.put("count", value.count)
    val sums = node.putArray("sums")
    value.sums.foreach(sum => sums.add(money(sum)))
    node
  }
}
