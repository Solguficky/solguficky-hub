-module(spike_store_ffi).
%% Хранилище спайка на Mnesia — замена PostgreSQL: pog тянет pgo (rebar3) с hex,
%% а repo.hex.pm закрыт политикой сети среды. Модель та же, что задумана для PG:
%% одна транзакция на факт для актора — processed, состояние правила, выдача
%% с уникальной парой (ачивка, субъект), строка outbox и курсор.
-export([init/0, transaction/1, processed/2, mark_processed/2, count/2, put_count/3,
         has_grant/2, single_holder/1, insert_grant/5, cursor/1, put_cursor/2,
         ready_occasions/1, mark_published/1, grants/0, kill/1,
         arm_crash/3, take_crash/3, register_self/1, whereis_ach/1, counts/1]).

-record(processed, {key, at}).
-record(rule_state, {key, count}).
-record(grant, {key, source_event, seq}).
-record(single, {code, subject}).
-record(outbox, {key, occasion_event, seq, code, subject, published}).
-record(cursor, {code, seq}).

init() ->
    ok = mnesia:start(),
    Tabs = [{processed, record_info(fields, processed), set},
            {rule_state, record_info(fields, rule_state), set},
            {grant, record_info(fields, grant), set},
            {single, record_info(fields, single), set},
            {outbox, record_info(fields, outbox), set},
            {cursor, record_info(fields, cursor), set}],
    [case mnesia:create_table(T, [{attributes, F}, {type, Ty}, {ram_copies, [node()]}]) of
         {atomic, ok} -> ok;
         {aborted, {already_exists, T}} -> ok
     end || {T, F, Ty} <- Tabs],
    ok = mnesia:wait_for_tables([T || {T, _, _} <- Tabs], 5000),
    nil.

transaction(F) ->
    case mnesia:transaction(F) of
        {atomic, R} -> {ok, R};
        {aborted, Reason} -> {error, iolist_to_binary(io_lib:format("~p", [Reason]))}
    end.

processed(Code, EventId) -> mnesia:read(processed, {Code, EventId}) =/= [].
mark_processed(Code, EventId) ->
    mnesia:write(#processed{key = {Code, EventId}, at = erlang:system_time(millisecond)}), nil.

count(Code, Subject) ->
    case mnesia:read(rule_state, {Code, Subject}) of [#rule_state{count = C}] -> C; [] -> 0 end.
put_count(Code, Subject, C) -> mnesia:write(#rule_state{key = {Code, Subject}, count = C}), nil.

has_grant(Code, Subject) -> mnesia:read(grant, {Code, Subject}) =/= [].

single_holder(Code) ->
    case mnesia:read(single, Code) of [#single{subject = S}] -> {some, S}; [] -> none end.

%% Аналог UNIQUE (achievement, subject) и UNIQUE (achievement) у ачивки с одним
%% получателем: нарушение отменяет всю транзакцию, как ошибка ограничения в PG.
insert_grant(Code, Subject, Single, OccasionEvent, Seq) ->
    case mnesia:read(grant, {Code, Subject}) of
        [_] -> mnesia:abort({unique_violation, grant, Code, Subject});
        [] -> ok
    end,
    case Single of
        true ->
            case mnesia:read(single, Code) of
                [_] -> mnesia:abort({unique_violation, single, Code});
                [] -> mnesia:write(#single{code = Code, subject = Subject})
            end;
        false -> ok
    end,
    mnesia:write(#grant{key = {Code, Subject}, source_event = OccasionEvent, seq = Seq}),
    mnesia:write(#outbox{key = {OccasionEvent, Code, Subject}, occasion_event = OccasionEvent,
                         seq = Seq, code = Code, subject = Subject, published = false}),
    nil.

cursor(Code) ->
    case mnesia:dirty_read(cursor, Code) of [#cursor{seq = S}] -> S; [] -> 0 end.
put_cursor(Code, Seq) -> mnesia:write(#cursor{code = Code, seq = Seq}), nil.

%% Релей outbox по предложению к ADR-077 п.8: повод публикуется одним фактом,
%% когда водяной знак — наименьший курсор ачивок стрима — его прошёл.
%% Возвращает [{OccasionEvent, Seq, [{Code, Subject}]}] неопубликованных поводов.
ready_occasions(Codes) ->
    Watermark = lists:min([cursor(C) || C <- Codes]),
    Rows = mnesia:dirty_match_object(#outbox{published = false, _ = '_'}),
    Ready = [R || R = #outbox{seq = S} <- Rows, S =< Watermark],
    Groups = lists:foldl(fun(#outbox{occasion_event = E, seq = S, code = C, subject = Sub}, Acc) ->
                                 maps:update_with({E, S}, fun(L) -> [{C, Sub} | L] end, [{C, Sub}], Acc)
                         end, #{}, Ready),
    lists:sort(fun({_, A, _}, {_, B, _}) -> A =< B end,
               [{E, S, lists:sort(L)} || {{E, S}, L} <- maps:to_list(Groups)]).

mark_published(OccasionEvent) ->
    {atomic, ok} = mnesia:transaction(fun() ->
        Rows = mnesia:match_object(#outbox{occasion_event = OccasionEvent, published = false, _ = '_'}),
        [mnesia:write(R#outbox{published = true}) || R <- Rows], ok end),
    nil.

grants() ->
    lists:sort([{C, S, E, Q} || #grant{key = {C, S}, source_event = E, seq = Q}
                                    <- mnesia:dirty_match_object(#grant{_ = '_'})]).

kill(Pid) -> exit(Pid, kill), nil.

%% Инъекция сбоя: Where = before_commit | after_commit для (Code, Seq), один раз.
arm_crash(Code, Seq, Where) -> persistent_term:put({crash, Code, Seq, Where}, true), nil.
take_crash(Code, Seq, Where) ->
    case persistent_term:get({crash, Code, Seq, Where}, false) of
        true -> persistent_term:erase({crash, Code, Seq, Where}), true;
        false -> false
    end.

register_self(Code) -> persistent_term:put({ach, Code}, self()), nil.
whereis_ach(Code) ->
    case persistent_term:get({ach, Code}, undefined) of
        undefined -> {error, nil};
        Pid -> {ok, Pid}
    end.

counts(Code) ->
    lists:sort([{S, C} || #rule_state{key = {C0, S}, count = C}
                              <- mnesia:dirty_match_object(#rule_state{_ = '_'}), C0 =:= Code]).
