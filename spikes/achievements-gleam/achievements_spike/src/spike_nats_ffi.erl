-module(spike_nats_ffi).
%% Минимальный клиент NATS/JetStream поверх gen_tcp для спайка.
%% Настоящий клиент (gnat) недоступен без hex; здесь ровно то, что нужно
%% актору: стрим, эфемерный pull-consumer с opt_start_seq, fetch по одному, ack.
-export([connect/2, ensure_stream/3, publish/4, create_consumer/3,
         fetch/3, ack/2, stream_last_seq/2, close/1]).

connect(Host, Port) ->
    case gen_tcp:connect(binary_to_list(Host), Port,
                         [binary, {active, false}, {packet, line}, {nodelay, true}]) of
        {ok, S} ->
            {ok, <<"INFO ", _/binary>>} = gen_tcp:recv(S, 0, 5000),
            ok = gen_tcp:send(S, <<"CONNECT {\"verbose\":false,\"pedantic\":false,\"headers\":true}\r\nPING\r\n">>),
            {ok, <<"PONG\r\n">>} = gen_tcp:recv(S, 0, 5000),
            Inbox = <<"_INBOX.", (integer_to_binary(erlang:unique_integer([positive])))/binary>>,
            ok = gen_tcp:send(S, [<<"SUB ">>, Inbox, <<".* 1\r\n">>]),
            {ok, {S, Inbox}};
        {error, R} -> {error, list_to_binary(io_lib:format("~p", [R]))}
    end.

close({S, _}) -> gen_tcp:close(S), nil.

pub(S, Subject, Reply, Payload) ->
    Size = integer_to_binary(byte_size(Payload)),
    gen_tcp:send(S, [<<"PUB ">>, Subject, <<" ">>, Reply, <<" ">>, Size, <<"\r\n">>, Payload, <<"\r\n">>]).

pub_headers(S, Subject, Headers, Payload) ->
    H = iolist_to_binary([<<"NATS/1.0\r\n">>, [[K, <<": ">>, V, <<"\r\n">>] || {K, V} <- Headers], <<"\r\n">>]),
    HS = byte_size(H),
    Total = HS + byte_size(Payload),
    gen_tcp:send(S, [<<"HPUB ">>, Subject, <<" ">>, integer_to_binary(HS), <<" ">>,
                     integer_to_binary(Total), <<"\r\n">>, H, Payload, <<"\r\n">>]).

%% Читает следующее сообщение, отвечая на PING. Возвращает {Subject, Reply, Headers, Payload}.
read_msg(S, Timeout) ->
    case gen_tcp:recv(S, 0, Timeout) of
        {ok, <<"PING\r\n">>} -> gen_tcp:send(S, <<"PONG\r\n">>), read_msg(S, Timeout);
        {ok, <<"+OK\r\n">>} -> read_msg(S, Timeout);
        {ok, <<"-ERR", _/binary>> = E} -> {error, E};
        {ok, <<"MSG ", Rest/binary>>} ->
            Parts = binary:split(string:trim(Rest), <<" ">>, [global]),
            {Subj, Reply, Size} = case Parts of
                [Sb, _Sid, Sz] -> {Sb, <<>>, binary_to_integer(Sz)};
                [Sb, _Sid, R, Sz] -> {Sb, R, binary_to_integer(Sz)}
            end,
            {ok, Body} = recv_exact(S, Size + 2),
            {ok, {Subj, Reply, <<>>, binary:part(Body, 0, Size)}};
        {ok, <<"HMSG ", Rest/binary>>} ->
            Parts = binary:split(string:trim(Rest), <<" ">>, [global]),
            {Subj, Reply, HSize, Size} = case Parts of
                [Sb, _Sid, Hs, Sz] -> {Sb, <<>>, binary_to_integer(Hs), binary_to_integer(Sz)};
                [Sb, _Sid, R, Hs, Sz] -> {Sb, R, binary_to_integer(Hs), binary_to_integer(Sz)}
            end,
            {ok, Body} = recv_exact(S, Size + 2),
            <<H:HSize/binary, P/binary>> = binary:part(Body, 0, Size),
            {ok, {Subj, Reply, H, P}};
        {error, timeout} -> timeout;
        {error, R} -> {error, list_to_binary(io_lib:format("~p", [R]))}
    end.

recv_exact(S, N) ->
    ok = inet:setopts(S, [{packet, raw}]),
    R = gen_tcp:recv(S, N, 5000),
    ok = inet:setopts(S, [{packet, line}]),
    R.

request({S, Inbox}, Subject, Payload) ->
    Reply = <<Inbox/binary, ".r">>,
    ok = pub(S, Subject, Reply, Payload),
    case read_msg(S, 5000) of
        {ok, {_, _, _, Body}} -> {ok, json:decode(Body)};
        Other -> {error, list_to_binary(io_lib:format("~p", [Other]))}
    end.

ensure_stream(Conn, Name, Subjects) ->
    Cfg = json:encode(#{name => Name, subjects => Subjects, storage => file,
                        duplicate_window => 120000000000}),
    case request(Conn, <<"$JS.API.STREAM.CREATE.", Name/binary>>, iolist_to_binary(Cfg)) of
        {ok, #{<<"error">> := #{<<"err_code">> := 10058}}} -> {ok, nil}; % уже есть
        {ok, #{<<"error">> := E}} -> {error, iolist_to_binary(json:encode(E))};
        {ok, _} -> {ok, nil};
        {error, E} -> {error, E}
    end.

%% Публикация в стрим с Nats-Msg-Id = event_id: дедупликация окна JetStream.
publish({S, Inbox}, Subject, MsgId, Payload) ->
    Reply = <<Inbox/binary, ".p">>,
    H = iolist_to_binary([<<"NATS/1.0\r\nNats-Msg-Id: ">>, MsgId, <<"\r\n\r\n">>]),
    HS = byte_size(H),
    ok = gen_tcp:send(S, [<<"HPUB ">>, Subject, <<" ">>, Reply, <<" ">>, integer_to_binary(HS), <<" ">>,
                          integer_to_binary(HS + byte_size(Payload)), <<"\r\n">>, H, Payload, <<"\r\n">>]),
    case read_msg(S, 5000) of
        {ok, {_, _, _, Body}} ->
            case json:decode(Body) of
                #{<<"seq">> := Seq} -> {ok, Seq};
                E -> {error, iolist_to_binary(json:encode(E))}
            end;
        Other -> {error, list_to_binary(io_lib:format("~p", [Other]))}
    end.

stream_last_seq(Conn, Stream) ->
    case request(Conn, <<"$JS.API.STREAM.INFO.", Stream/binary>>, <<>>) of
        {ok, #{<<"state">> := #{<<"last_seq">> := L}}} -> {ok, L};
        Other -> {error, list_to_binary(io_lib:format("~p", [Other]))}
    end.

%% Эфемерный consumer от позиции курсора: по одному сообщению в полёте.
create_consumer(Conn, Stream, StartSeq) ->
    Cfg = #{stream_name => Stream,
            config => #{deliver_policy => by_start_sequence, opt_start_seq => StartSeq,
                        ack_policy => explicit, max_ack_pending => 1,
                        ack_wait => 30000000000, inactive_threshold => 60000000000}},
    case request(Conn, <<"$JS.API.CONSUMER.CREATE.", Stream/binary>>, iolist_to_binary(json:encode(Cfg))) of
        {ok, #{<<"name">> := N}} -> {ok, N};
        {ok, E} -> {error, iolist_to_binary(json:encode(E))};
        {error, E} -> {error, E}
    end.

%% Один факт: {ok, {StreamSeq, Subject, AckSubject, Payload}} или {error, <<"empty">>}.
fetch({S, Inbox} = _Conn, Stream, Consumer) ->
    Reply = <<Inbox/binary, ".f">>,
    ok = pub(S, <<"$JS.API.CONSUMER.MSG.NEXT.", Stream/binary, ".", Consumer/binary>>,
             Reply, <<"{\"batch\":1,\"expires\":1000000000}">>),
    case read_msg(S, 3000) of
        {ok, {Subj, <<"$JS.ACK.", _/binary>> = Ack, _, P}} ->
            Tokens = binary:split(Ack, <<".">>, [global]),
            %% $JS.ACK.<stream>.<consumer>.<delivered>.<sseq>.<cseq>.<ts>.<pending>
            Seq = binary_to_integer(lists:nth(6, Tokens)),
            {ok, {Seq, Subj, Ack, P}};
        {ok, {_, _, _Status, _}} -> {error, <<"empty">>};
        timeout -> {error, <<"empty">>};
        {error, E} -> {error, E}
    end.

ack({S, _}, AckSubject) ->
    ok = pub(S, AckSubject, <<>>, <<"+ACK">>),
    nil.

-compile({nowarn_unused_function, [pub_headers/4]}).
