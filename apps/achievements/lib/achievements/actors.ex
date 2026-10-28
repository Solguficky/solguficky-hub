defmodule Achievements.Actors do
  @moduledoc """
  Супервизор акторов ачивок. Его `init` загружает каталог поставки, сверяет
  его с наборами в базе и называет детей — по актору на ачивку с правилом.
  Поэтому рестарт супервизора поднимает всех акторов заново, а не оставляет
  его пустым.

  Код, вошедший в зафиксированный набор, обязан найтись в поставке (ADR-077,
  п. 4): иначе узел не стартует и называет пропавшие коды, а не отдаёт наборы
  с дырой. Без шины детей нет: читать стрим не из чего, а каталог для чтений
  загружен всё равно.
  """
  use Supervisor

  alias Achievements.{Actor, AuctionFacts, Catalog, Definitions, Reads}

  def start_link(opts), do: Supervisor.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    Catalog.load!(Definitions.all())

    case Catalog.unknown(Reads.set_codes()) do
      [] ->
        :ok

      codes ->
        raise "achievement sets name codes absent from the definitions: #{Enum.join(codes, ", ")}"
    end

    children =
      if Keyword.get(opts, :bus?, false) do
        for definition <- Catalog.with_rule() do
          {Actor,
           [
             definition: definition,
             connection: :gnat,
             stream: AuctionFacts.stream(),
             filter_subject: AuctionFacts.filter_subject()
           ] ++ Keyword.get(opts, :actor, [])}
        end
      else
        []
      end

    Supervisor.init(children, strategy: :one_for_one)
  end
end
