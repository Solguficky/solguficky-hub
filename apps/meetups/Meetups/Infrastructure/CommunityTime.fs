/// Часовой пояс сообщества. Нужен продуктовому чтению: по нему считается
/// календарный день, отделяющий актуальные сходки от архива (PER-229).
/// Правило «прошедшей» живёт в домене и получает день значением, поэтому здесь
/// только перевод момента в день сообщества и разбор настройки.
module Meetups.Infrastructure.CommunityTime

open System

[<Literal>]
let TimeZoneVariable = "MEETUPS_COMMUNITY_TIME_ZONE"

/// Идентификатор пояса — IANA: `Europe/Moscow`. Неизвестное имя роняет старт, а не
/// подменяется UTC молча: сдвиг архивной границы на часы пользователь видит, а
/// оператор — нет, и тихая подстановка врала бы обеим сторонам.
let zone (value: string) : TimeZoneInfo =
    try
        TimeZoneInfo.FindSystemTimeZoneById value
    with
    | :? TimeZoneNotFoundException
    | :? InvalidTimeZoneException -> failwith $"{TimeZoneVariable} names an unknown time zone: {value}"

/// Календарный день сообщества в момент времени. Дата без времени: расписание
/// хранит локальные календарные даты, и «прошедшая» сравнивается с датой, а не с
/// моментом — время из расписания не выдумывается (ADR-022).
let today (zone: TimeZoneInfo) (now: DateTimeOffset) : DateOnly =
    TimeZoneInfo.ConvertTime(now, zone).DateTime
    |> DateOnly.FromDateTime
