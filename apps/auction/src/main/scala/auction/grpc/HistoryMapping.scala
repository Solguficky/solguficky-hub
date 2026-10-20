package auction.grpc

import auction.contract.LotValues
import auction.lot.BidSource
import auction.projection.BidRecord
import auction.projection.HistoryRecord
import auction.v1.auction as model
import auction.v1.auction_events as events
import auction.v1.auction_service as wire

/**
 * Отображение хронологии лота из read model в `LotHistoryEntry`.
 *
 * Строка `lot_bid` — свёрнутый `BidPlaced`: серия автоставок уже одна строка с итоговой ценой (RFC-011, ось F), а
 * лимита в строке нет вовсе, поэтому и наружу ему взяться неоткуда. Снятие участника (PER-658) — строка `lot_removal` с
 * ценой и лидером, с которыми лот пошёл дальше; кого сняли, наружу говорят только пометки его ставок.
 */
object HistoryMapping {

  def entry(record: HistoryRecord): wire.LotHistoryEntry =
    record match {
      case HistoryRecord.Bid(bid) =>
        wire.LotHistoryEntry(
          sequence = bid.sequence,
          occurredAt = LotValues.instant(bid.occurredAt),
          kind = wire.LotHistoryEntry.Kind.Bid(
            wire.HistoryBid(
              bidId = bid.bidId.toString,
              participantId = bid.participant.toString,
              amount = Some(model.Money(bid.minorUnits, bid.currency)),
              origin = origin(bid),
              removed = bid.removed
            )
          )
        )
      case HistoryRecord.Removal(sequence, minorUnits, currency, leader, occurredAt) =>
        wire.LotHistoryEntry(
          sequence = sequence,
          occurredAt = LotValues.instant(occurredAt),
          kind = wire.LotHistoryEntry.Kind.Removal(
            wire.HistoryRemoval(price = Some(model.Money(minorUnits, currency)), leaderId = leader.map(_.toString))
          )
        )
    }

  /** Сочетания, которые пишет проекция; иное — строка, записанная в обход неё, и это дефект, а не ставка без канала. */
  private def origin(bid: BidRecord): wire.HistoryBid.Origin =
    (bid.origin, bid.source) match {
      case ("Manual", Some(channel)) =>
        wire.HistoryBid.Origin.Manual(events.ManualBid(LotValues.bidSource(source(bid, channel))))
      case ("Proxy", None) => wire.HistoryBid.Origin.Proxy(events.ProxyBid())
      case (origin, source) =>
        throw new IllegalStateException(
          s"lot_bid of lot ${bid.lotId} at ${bid.sequence} holds origin $origin with source $source"
        )
    }

  private def source(bid: BidRecord, channel: String): BidSource =
    BidSource.values
      .find(_.toString == channel)
      .getOrElse(
        throw new IllegalStateException(s"lot_bid of lot ${bid.lotId} at ${bid.sequence} holds source $channel")
      )
}
