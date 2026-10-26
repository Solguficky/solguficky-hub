defmodule Achievements.Release do
  @moduledoc "bin/achievements eval 'Achievements.Release.migrate()' — миграции в поставке без mix."
  def migrate do
    Application.load(:achievements)
    {:ok, _, _} = Ecto.Migrator.with_repo(Achievements.Repo, &Ecto.Migrator.run(&1, :up, all: true))
  end
end
