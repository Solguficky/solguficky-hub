defmodule Achievements.Catalog do
  @moduledoc """
  Каталог определений поставки: проверенные определения и их картинки. Узел
  загружает его один раз при старте (`load!/1`) — до акторов и gRPC-границы —
  и держит в `:persistent_term`: каталог меняется только новой поставкой.

  Порядок каталога — порядок определений в поставке; в нём отдаются наборы.
  Версия картинки — первые 16 знаков sha256 её байтов: она меняется вместе с
  файлом и совпадает у всех узлов одной поставки.
  """

  alias Achievements.Definition

  @key {__MODULE__, :entries}

  defmodule Entry do
    @moduledoc "Определение каталога с загруженной картинкой."
    @enforce_keys [:definition]
    defstruct [:definition, :image]

    @type image :: %{content: binary(), media_type: String.t(), version: String.t()}
    @type t :: %__MODULE__{definition: Definition.t(), image: image() | nil}
  end

  @media_types %{
    ".png" => "image/png",
    ".jpg" => "image/jpeg",
    ".jpeg" => "image/jpeg",
    ".webp" => "image/webp",
    ".gif" => "image/gif"
  }

  @doc """
  Проверяет определения и загружает картинки. Отказ — `raise` на старте узла:
  поставка с битым определением работать не должна.
  """
  @spec load!([Definition.t()], Path.t()) :: :ok
  def load!(definitions, images_dir \\ default_images_dir()) do
    case build(definitions, images_dir) do
      {:ok, entries} -> :persistent_term.put(@key, entries)
      {:error, reason} -> raise ArgumentError, reason
    end

    :ok
  end

  @doc "Каталог из определений или первый отказ проверки."
  @spec build([Definition.t()], Path.t()) :: {:ok, [Entry.t()]} | {:error, String.t()}
  def build(definitions, images_dir) do
    with :ok <- unique_codes(definitions) do
      Enum.reduce_while(definitions, {:ok, []}, fn definition, {:ok, entries} ->
        with :ok <- Definition.validate(definition),
             {:ok, image} <- image(definition, images_dir) do
          {:cont, {:ok, [%Entry{definition: definition, image: image} | entries]}}
        else
          {:error, reason} -> {:halt, {:error, reason}}
        end
      end)
      |> case do
        {:ok, entries} -> {:ok, Enum.reverse(entries)}
        error -> error
      end
    end
  end

  @doc "Все определения каталога в порядке поставки."
  @spec entries() :: [Entry.t()]
  def entries, do: :persistent_term.get(@key, [])

  @spec fetch(String.t()) :: {:ok, Entry.t()} | :error
  def fetch(code) do
    case Enum.find(entries(), &(&1.definition.code == code)) do
      nil -> :error
      entry -> {:ok, entry}
    end
  end

  @doc "Определения вида события с датой начала не позже `at`."
  @spec started(Definition.event_kind(), DateTime.t()) :: [Entry.t()]
  def started(kind, at) do
    Enum.filter(entries(), fn %Entry{definition: d} ->
      d.event_kind == kind and DateTime.compare(d.starts_at, at) != :gt
    end)
  end

  @doc "Определения с правилом: каждому нужен свой актор."
  @spec with_rule() :: [Definition.t()]
  def with_rule,
    do: for(%Entry{definition: %{issue: :rule} = d} <- entries(), do: d)

  @doc "Коды, которых нет в каталоге, из перечня кодов."
  @spec unknown([String.t()]) :: [String.t()]
  def unknown(codes) do
    known = MapSet.new(entries(), & &1.definition.code)
    Enum.reject(codes, &MapSet.member?(known, &1))
  end

  defp unique_codes(definitions) do
    case definitions |> Enum.frequencies_by(& &1.code) |> Enum.filter(fn {_, n} -> n > 1 end) do
      [] -> :ok
      [{code, _} | _] -> {:error, "achievement code #{code} is defined more than once"}
    end
  end

  defp image(%Definition{image: nil}, _dir), do: {:ok, nil}

  defp image(%Definition{image: file, code: code}, dir) do
    path = Path.expand(file, dir)

    with {:ok, media_type} <- media_type(path, code),
         {:ok, content} <- read(path, code) do
      version =
        :crypto.hash(:sha256, content) |> Base.encode16(case: :lower) |> binary_part(0, 16)

      {:ok, %{content: content, media_type: media_type, version: version}}
    end
  end

  defp media_type(path, code) do
    case Map.fetch(@media_types, path |> Path.extname() |> String.downcase()) do
      {:ok, type} -> {:ok, type}
      :error -> {:error, "achievement #{code} has an image of an unknown type"}
    end
  end

  defp read(path, code) do
    case File.read(path) do
      {:ok, content} -> {:ok, content}
      {:error, _} -> {:error, "achievement #{code} has no image file"}
    end
  end

  defp default_images_dir, do: Application.app_dir(:achievements, "priv/achievements")
end
