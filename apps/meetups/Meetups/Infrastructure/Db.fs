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

/// Создание источника отложено до первого обращения потребителя: хост обязан
/// подниматься без базы, иначе gRPC-тесты каркаса начнут требовать PostgreSQL
/// ради проверки, которая его не касается.
let source (databaseUrl: string) : NpgsqlDataSource =
    ensureTypeHandlers ()
    NpgsqlDataSource.Create(Meetups.Migrations.connectionString databaseUrl)
