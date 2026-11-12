[
  # lib/generated пишет `buf generate` (buf.gen.yaml): код генератора не
  # форматируется руками и в Git не лежит.
  inputs: [
    "{mix,.formatter}.exs",
    "{config,test}/**/*.{ex,exs}",
    "lib/*.{ex,exs}",
    "lib/achievements/**/*.{ex,exs}",
    "priv/repo/migrations/*.exs"
  ],
  import_deps: [:ecto, :ecto_sql]
]
