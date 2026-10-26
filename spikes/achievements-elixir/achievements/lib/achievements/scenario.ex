defmodule Achievements.Scenario do
  @moduledoc """
  Сценарий спайка: mix run -e 'Achievements.Scenario.run()'. Стрим ACH_FACTS уже
  наполнен publish_facts.py 1; фаза 3 ждёт, пока снаружи опубликуют ещё 6 фактов.
  """
  alias Achievements.{Actor, Application, Relay, Repo, Rules}
  import Ecto.Query

  def run do
    {:ok, last} = last_seq()
    IO.puts("stream last_seq #{last}")
    Actor.arm_crash("collector", 30, :after_commit)
    Actor.arm_crash("bidder", 1, :before_commit)

    first = [Rules.Collector, Rules.FirstBidder, Rules.Bidder]
    Enum.each(first, &Application.start_actor/1)

    wait_all(["collector"], 20)
    IO.puts("killing collector mid-stream, cursor #{Actor.cursor("collector")}")
    Process.exit(Process.whereis(:ach_collector), :kill)
    wait_all(codes(first), last)
    report("PHASE1", codes(first))

    Application.start_actor(Rules.FirstPayment)
    all = codes([Rules.FirstPayment | first])
    wait_all(all, last)
    report("PHASE2", all)

    IO.puts("PHASE2 DONE, waiting for phase 3 facts")
    last3 = wait_stream(last + 6)
    wait_all(all, last3)
    report("PHASE3", all)
    IO.puts("SCENARIO DONE")
  end

  defp codes(mods), do: Enum.map(mods, & &1.code())

  defp last_seq do
    with {:ok, info} <- Gnat.Jetstream.API.Stream.info(:gnat, Actor.stream()), do: {:ok, info.state.last_seq}
  end

  defp wait_all(codes, seq) do
    unless Enum.all?(codes, &(Actor.cursor(&1) >= seq)), do: (Process.sleep(100); wait_all(codes, seq))
  end

  defp wait_stream(seq) do
    case last_seq() do
      {:ok, l} when l >= seq -> l
      _ -> Process.sleep(200); wait_stream(seq)
    end
  end

  defp report(phase, codes) do
    IO.puts("== #{phase}")
    for c <- codes, do: IO.puts("  cursor #{c} = #{Actor.cursor(c)}")
    counts = Repo.all(from s in "rule_state", where: s.achievement == "collector", order_by: s.subject, select: {s.subject, s.count})
    IO.puts("  collector counts #{inspect(counts)}")
    grants = Repo.all(from g in "grants", order_by: [g.achievement, g.subject], select: {g.achievement, g.subject, g.seq})
    IO.puts("  grants total #{length(grants)}")
    for g <- grants, do: IO.puts("  grant #{inspect(g)}")
    {:ok, ready} = Relay.run_once(codes)
    for {e, s, items} <- ready, do: IO.puts("  announce occasion seq #{s} #{e} -> #{inspect(items)}")
    IO.puts("  announcements #{length(ready)}")
  end
end
