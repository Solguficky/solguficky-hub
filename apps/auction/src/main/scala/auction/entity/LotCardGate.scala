package auction.entity

import auction.catalog.CardStanding
import auction.lot.LotState

/** Сводит состояние лота к воротам карточки. Журнал каталог не читает: это делает граница перед записью строки. */
object LotCardGate {

  def standing(state: LotState): CardStanding =
    state match {
      case LotState.Sold(_) | LotState.Unsold(_) => CardStanding.Closed
      case LotState.Initial | LotState.Draft | LotState.Scheduled(_) | LotState.Trading(_) | LotState.Held(_) |
          LotState.Withdrawn(_) =>
        CardStanding.Open
    }
}
