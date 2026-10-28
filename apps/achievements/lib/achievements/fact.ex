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
  """

  @enforce_keys [:kind, :event_id, :event, :occurred_at]
  defstruct [:kind, :event_id, :event, :occurred_at, :subject, data: %{}]

  @type kind :: :invoice_paid
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
