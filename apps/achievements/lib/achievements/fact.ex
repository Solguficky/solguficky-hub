defmodule Achievements.Fact do
  @moduledoc """
  Доменный факт модуля, каким его видят правила. Сгенерированные модули
  контракта за адаптер разбора (`Achievements.AuctionFacts`) не выходят:
  правило знает вид факта, событие, субъекта и данные вида, а не конверт шины.

  - `event_id` — id строки outbox модуля, ключ дедупликации;
  - `event` — событие, к набору которого факт относится;
  - `occurred_at` — момент решения модуля: с ним сравнивается дата начала
    действия ачивки;
  - `subject` — identity id человека, о котором факт, если он есть;
  - `data` — поля вида, нужные правилам.

  Данные видов аукциона:

  - факты лота — `lot_id` и `version`, позиция в журнале лота; порядок фактов
    лота задаёт она, а не порядок прихода;
  - `:bid_placed` — `bidder` (лидер снимка того же факта), `origin`
    (`:manual` или `:proxy`) и `overtaken` (ставку той же командой перебила
    чужая автоставка); `subject` — ставящий;
  - `:lot_sold` — `winner`, победитель торгов; `subject` — он же;
  - `:participant_removed` — `leader` снимка после снятия и
    `previous_leader`, оба могут быть `nil`;
  - `:lot_held_for_final`, `:lot_resumed` — `leader` снимка;
  - `:trading_started` — `prebidding_started` или `final_started`, `lot_ids` —
    реестр лотов снимка;
  - `:auction_finished` — конец аукциона, `lot_ids` — реестр лотов снимка;
  - `:invoice_paid` — `lot_id` и `invoice_id`; `subject` — покупатель;
  - `:raffle_drawn` — `subject` — владелец выигравшего билета;
  - `:prediction_results_settled` — `manual` и `participations`: тройки
    `participant`, `nomination`, `guessed`.
  """

  @enforce_keys [:kind, :event_id, :event, :occurred_at]
  defstruct [:kind, :event_id, :event, :occurred_at, :subject, data: %{}]

  @type kind ::
          :lot_opened
          | :bid_placed
          | :lot_sold
          | :lot_unsold
          | :lot_withdrawn
          | :lot_held_for_final
          | :lot_resumed
          | :participant_removed
          | :trading_started
          | :auction_finished
          | :invoice_paid
          | :raffle_drawn
          | :prediction_results_settled

  @type event :: {:auction | :meetup, String.t()}

  @type t :: %__MODULE__{
          kind: kind(),
          event_id: String.t(),
          event: event(),
          occurred_at: DateTime.t(),
          subject: String.t() | nil,
          data: map()
        }
end
