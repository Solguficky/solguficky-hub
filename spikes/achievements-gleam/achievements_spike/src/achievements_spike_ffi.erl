-module(achievements_spike_ffi).
-export([ensure_elixir/0]).

%% Приложения elixir и logger в поставке Gleam не стартуют сами: Gleam не пишет
%% их в applications своего .app. Стартуем явно и видим, есть ли они в shipment.
ensure_elixir() ->
    {ok, _} = application:ensure_all_started(elixir),
    {ok, _} = application:ensure_all_started(logger),
    nil.
