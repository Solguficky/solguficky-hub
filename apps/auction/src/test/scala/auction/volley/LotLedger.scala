package auction.volley

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper

import java.time.Instant
import java.util.UUID

/** Строка журнала лота: номер и payload JSON модели хранения, как они лежат в `event_journal`. */
final case class JournalRow(sequence: Long, payload: String)

/** Ставка из строки `BidPlaced`: `proxy` — производная ставка прокси, а не команда участника. */
final case class LedgerBid(sequence: Long, opId: UUID, bidId: UUID, participant: UUID, amount: Long, proxy: Boolean)

final case class LedgerSale(winner: UUID, price: Long, bidId: UUID)

/**
 * Состояние лота, свёрнутое из строк журнала напрямую по JSON модели хранения, без `Lot.apply`: оракул рестарта не
 * должен делить код с тем, что он проверяет. Свёртка нарочно проще ядра — правил торгов в ней нет, только итог событий:
 * цена и лидер — последней ставки, лимит — последней записи участника, дедлайн и счётчик — последнего продления.
 */
final case class LotLedger(
    rows: Vector[(Long, JsonNode)],
    price: Option[Long],
    leader: Option[UUID],
    leadingBidId: Option[UUID],
    deadline: Option[Instant],
    extensionsUsed: Int,
    limits: Map[UUID, Long],
    bids: Vector[LedgerBid],
    sale: Option[LedgerSale]
) {

  def maxSequence: Long = rows.lastOption.map(_._1).getOrElse(0L)

  /**
   * Строки журнала, кроме закрытия лота: закрытие пишет таймер аукциона в любой момент, а всё остальное после старта
   * торгов — только команды участников. Счёт по всему журналу, а не по `op_id` залпа: строку, записанную повтором под
   * чужим `op_id`, счёт по `op_id` не увидел бы.
   */
  def trading: Int = rows.count((_, row) => !Set("LotSold", "LotUnsold").contains(row.get("event").get("kind").asText))

  /** Событие команды с этим `op_id`, а не производное: ручная ставка или запись лимита. */
  def own(opId: UUID): Vector[JsonNode] =
    rows.collect {
      case (_, row) if UUID.fromString(row.get("opId").asText) == opId && isOwn(row.get("event")) => row.get("event")
    }

  private def isOwn(event: JsonNode): Boolean =
    event.get("kind").asText match {
      case "BidPlaced" => event.get("bidPlaced").get("origin").asText == "Manual"
      case "ProxyLimitSet" => true
      case _ => false
    }
}

object LotLedger {

  private val mapper = ObjectMapper()

  def fold(journal: Seq[JournalRow]): LotLedger = {
    val parsed = journal.sortBy(_.sequence).map(row => row.sequence -> mapper.readTree(row.payload)).toVector
    parsed.foldLeft(LotLedger(parsed, None, None, None, None, 0, Map.empty, Vector.empty, None)) {
      case (ledger, (sequence, row)) =>
        val event = row.get("event")
        event.get("kind").asText match {
          case "LotOpened" =>
            val opened = event.get("lotOpened")
            ledger.copy(
              price = Some(minor(opened.get("startingPrice"))),
              deadline = optional(opened.get("deadline")).map(Instant.parse)
            )
          case "BidPlaced" =>
            val placed = event.get("bidPlaced")
            val bid = LedgerBid(
              sequence,
              UUID.fromString(row.get("opId").asText),
              UUID.fromString(placed.get("bidId").asText),
              UUID.fromString(placed.get("participant").asText),
              minor(placed.get("amount")),
              placed.get("origin").asText != "Manual"
            )
            ledger.copy(
              price = Some(bid.amount),
              leader = Some(bid.participant),
              leadingBidId = Some(bid.bidId),
              bids = ledger.bids :+ bid
            )
          case "ProxyLimitSet" =>
            val set = event.get("proxyLimitSet")
            ledger.copy(limits =
              ledger.limits.updated(UUID.fromString(set.get("participant").asText), minor(set.get("max")))
            )
          case "ProxyLimitWithdrawn" =>
            ledger.copy(limits =
              ledger.limits - UUID.fromString(event.get("proxyLimitWithdrawn").get("participant").asText)
            )
          case "DeadlineExtended" =>
            val extended = event.get("deadlineExtended")
            ledger.copy(
              deadline = Some(Instant.parse(extended.get("newDeadline").asText)),
              extensionsUsed = extended.get("extensionsUsed").asInt
            )
          case "LotSold" =>
            val sold = event.get("lotSold")
            ledger.copy(
              sale = Some(
                LedgerSale(
                  UUID.fromString(sold.get("winner").asText),
                  minor(sold.get("price")),
                  UUID.fromString(sold.get("bidId").asText)
                )
              )
            )
          case _ => ledger
        }
    }
  }

  private def minor(money: JsonNode): Long = money.get("minorUnits").asLong

  private def optional(node: JsonNode): Option[String] = Option(node).filterNot(_.isNull).map(_.asText)

  /** Числа JSON с дробной частью или экспонентой — ПП-5 запрещает их на любом уровне. */
  def fractional(payload: String): List[JsonNode] = {
    def numbers(node: JsonNode): List[JsonNode] =
      if (node.isNumber) List(node)
      else {
        val children = List.newBuilder[JsonNode]
        node.elements().forEachRemaining(child => children ++= numbers(child))
        children.result()
      }
    numbers(mapper.readTree(payload)).filterNot(_.isIntegralNumber)
  }
}
