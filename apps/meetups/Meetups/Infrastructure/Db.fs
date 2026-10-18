/// Источник соединений сервиса. Тонкий по построению: он знает про Npgsql и про
/// перевод DSN в keyword-строку, и больше ни про что. Пул держит сам
/// NpgsqlDataSource, поэтому отдельного кэша соединений здесь нет.
module Meetups.Infrastructure.Db

open System
open Dapper
open Npgsql

/// Dapper не знает DateOnly и TimeOnly: `LookupDbType` для них падает с
/// «cannot be used as a parameter value», хотя Npgsql оба типа поддерживает
/// нативно и пишет их в `date` и `time` без преобразования. Handler закрывает
/// именно этот разрыв и ничего больше не меняет.
///
/// Это регистрация в статике Dapper, то есть состояние процесса. Она осознанно
/// узкая: расширяет набор известных типов, а не переопределяет правила отображения
/// имён. `DefaultTypeMap.MatchNamesWithUnderscores` здесь как раз не ставится —
/// сопоставление колонок задано алиасами в самих запросах.
type private DateOnlyHandler() =
    inherit SqlMapper.TypeHandler<DateOnly>()

    override _.SetValue(parameter, value) = parameter.Value <- value

    override _.Parse(value: obj) =
        match value with
        | :? DateOnly as date -> date
        | :? DateTime as moment -> DateOnly.FromDateTime moment
        | other -> failwith $"cannot read {other.GetType().Name} as a date"

type private TimeOnlyHandler() =
    inherit SqlMapper.TypeHandler<TimeOnly>()

    override _.SetValue(parameter, value) = parameter.Value <- value

    override _.Parse(value: obj) =
        match value with
        | :? TimeOnly as time -> time
        | :? TimeSpan as span -> TimeOnly.FromTimeSpan span
        | other -> failwith $"cannot read {other.GetType().Name} as a time"

/// Регистрация выполняется один раз на процесс и до первого запроса. Ленивое
/// значение выбрано вместо вызова из composition root потому, что запросы идут и
/// мимо него — из интеграционных тестов, собирающих зависимости самостоятельно.
let private handlers =
    lazy
        (SqlMapper.AddTypeHandler(DateOnlyHandler())
         SqlMapper.AddTypeHandler(TimeOnlyHandler()))

let ensureTypeHandlers () = handlers.Force()

/// Предел установления соединения, если DSN не задал свой `Timeout`. Умолчание
/// Npgsql — 15 секунд, и недоступная база держала вызов дольше трёх секунд
/// дедлайна бота: клиент видел свой DeadlineExceeded вместо Unavailable
/// (ADR-054). Npgsql принимает только целые секунды.
[<Literal>]
let ConnectTimeoutSeconds = 2

/// Явный `Timeout` в строке подключения выигрывает: развёртывание вправе задать
/// свой предел. Проверка по исходной строке, а не по построителю Npgsql: тот
/// всегда отвечает значением, умолчание или явное.
let withConnectTimeout (connectionString: string) =
    let explicitKeys =
        Data.Common.DbConnectionStringBuilder(ConnectionString = connectionString)

    if explicitKeys.ContainsKey "Timeout" then
        connectionString
    else
        let builder = NpgsqlConnectionStringBuilder(connectionString)
        builder.Timeout <- ConnectTimeoutSeconds
        builder.ConnectionString

/// Создание источника отложено до первого обращения потребителя: хост обязан
/// подниматься без базы, иначе gRPC-тесты каркаса начнут требовать PostgreSQL
/// ради проверки, которая его не касается.
let source (databaseUrl: string) : NpgsqlDataSource =
    ensureTypeHandlers ()

    databaseUrl
    |> Meetups.Migrations.connectionString
    |> withConnectTimeout
    |> NpgsqlDataSource.Create

/// Отказало ли хранилище на уровне соединения, а не запроса: соединение не
/// установилось, оборвалось или сервер его закрыл. `PostgresException` — ответ
/// живого сервера, и недоступностью он считается только с SQLSTATE класса 08 или
/// 57P01–57P03; последний PostgreSQL отдаёт первые секунды после старта. Прочий
/// `NpgsqlException` рождается на стороне клиента — отказ подключения, обрыв
/// потока, исчерпание пула. `IsTransient` не годится: он причисляет к временным и
/// конфликт сериализации, который недоступностью не является.
let unavailable (error: exn) =
    match error with
    | :? PostgresException as refused ->
        refused.SqlState.StartsWith("08", StringComparison.Ordinal)
        || refused.SqlState = "57P01"
        || refused.SqlState = "57P02"
        || refused.SqlState = "57P03"
    | :? NpgsqlException -> true
    | _ -> false
