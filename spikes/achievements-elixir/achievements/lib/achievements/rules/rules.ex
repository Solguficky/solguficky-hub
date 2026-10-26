defmodule Achievements.Rules.Collector do
  @moduledoc "«Коллекционер»: оплатил три лота. Состояние — число оплат субъекта."
  @behaviour Achievements.Achievement
  import Ecto.Query

  def code, do: "collector"
  def title, do: "Коллекционер"
  def single?, do: false

  def rule({:invoice, %{occasion: {:invoice_paid, _}, state: %{winner_id: w}}}, repo) do
    {1, [n]} =
      repo.insert_all("rule_state", [%{achievement: code(), subject: w, count: 1}],
        on_conflict: from(s in "rule_state", update: [inc: [count: 1]]),
        conflict_target: [:achievement, :subject], returning: [:count])

    if n.count == 3, do: [w], else: []
  end

  def rule(_fact, _repo), do: []
end

defmodule Achievements.Rules.FirstBidder do
  @moduledoc "«Первый ставочник»: первая ставка в стриме, один получатель."
  @behaviour Achievements.Achievement
  import Ecto.Query

  def code, do: "first_bidder"
  def title, do: "Первый ставочник"
  def single?, do: true

  def rule({:lot, %{occasion: {:bid_placed, _}, state: %{status: {:trading, %{leader_id: b}}}}}, repo) do
    if repo.exists?(from g in "grants", where: g.achievement == ^code()), do: [], else: [b]
  end

  def rule(_fact, _repo), do: []
end

defmodule Achievements.Rules.Bidder do
  @moduledoc "«Ставочник»: сделал ставку."
  @behaviour Achievements.Achievement

  def code, do: "bidder"
  def title, do: "Ставочник"
  def single?, do: false

  def rule({:lot, %{occasion: {:bid_placed, _}, state: %{status: {:trading, %{leader_id: b}}}}}, _repo), do: [b]
  def rule(_fact, _repo), do: []
end

defmodule Achievements.Rules.FirstPayment do
  @moduledoc "«Первая покупка»: оплатил лот. Добавляется после обработки — дочитывает стрим."
  @behaviour Achievements.Achievement

  def code, do: "first_payment"
  def title, do: "Первая покупка"
  def single?, do: false

  def rule({:invoice, %{occasion: {:invoice_paid, _}, state: %{winner_id: w}}}, _repo), do: [w]
  def rule(_fact, _repo), do: []
end
