/// Composition root сервиса. Вынесен из Program.fs отдельной функцией, чтобы
/// интеграционный тест поднимал ровно тот же хост, что и запуск: иначе критерий
/// "сервис отвечает на gRPC" навсегда остаётся ручным grpcurl.
module Meetups.Host

open System
open Meetups.Observability
open Meetups.Slices
open Meetups.Transport
open Microsoft.AspNetCore.Builder
open Microsoft.AspNetCore.Hosting
open Microsoft.AspNetCore.Server.Kestrel.Core
open Microsoft.Extensions.Configuration
open Microsoft.Extensions.DependencyInjection
open Microsoft.Extensions.Hosting
open Npgsql
open OpenTelemetry.Metrics

/// `configure` дописывает регистрации последними и потому перекрывает их. Шов нужен
/// одному: интеграционный тест подставляет порт Identity, не поднимая Identity, и
/// проверяет остальной composition root как есть. Запуск его не использует.
let buildWith (configure: IServiceCollection -> unit) (args: string array) : WebApplication =
    let builder = WebApplication.CreateBuilder(args)

    builder.AddServiceDefaults() |> ignore

    // h2c: gRPC без TLS требует HTTP/2, а plaintext-endpoint без ALPN не умеет
    // договариваться о версии. Протокол задан кодом, а не appsettings.json,
    // потому что без него транспорт не работает вовсе.
    builder.WebHost.ConfigureKestrel(fun options ->
        options.ConfigureEndpointDefaults(fun endpoint -> endpoint.Protocols <- HttpProtocols.Http2)
    )
    |> ignore

    builder.Services.AddGrpc(fun options ->
        options.Interceptors.Add<BoundaryLogInterceptor>()
        |> ignore
    )
    |> ignore

    // Источник соединений собирается лениво, при первом обращении потребителя.
    // Это несущее свойство, а не деталь: хост обязан подниматься без базы, иначе
    // gRPC-тесты каркаса начнут требовать PostgreSQL ради проверки, которая его не
    // касается, а проба готовности перестанет отвечать раньше, чем скажет причину.
    builder.Services.AddSingleton<NpgsqlDataSource>(fun services ->
        let configuration = services.GetRequiredService<IConfiguration>()

        match configuration[Meetups.Migrations.DatabaseUrlVariable] with
        | null
        | "" -> failwith $"{Meetups.Migrations.DatabaseUrlVariable} is not set"
        | url -> Meetups.Infrastructure.Db.source url
    )
    |> ignore

    // Часовой пояс сообщества разрешается здесь и падает при отсутствии значения
    // сразу: по нему считается календарный день, отделяющий актуальные сходки от
    // архива, и момент назначения отложенной публикации (ADR-022). Подставлять UTC
    // молча значило бы сдвигать обе границы на часы, пока оператор считает настройку
    // заданной. Ленивое разрешение прятало бы отказ до первого продуктового чтения —
    // тем же свойством источник соединений обязан обладать по другой причине (хост
    // поднимается без базы), но часовой пояс базой не является и ни одного теста
    // каркаса не ломает.
    let communityZone =
        match builder.Configuration[Meetups.Infrastructure.CommunityTime.TimeZoneVariable] with
        | null
        | "" -> failwith $"{Meetups.Infrastructure.CommunityTime.TimeZoneVariable} is not set"
        | value -> Meetups.Infrastructure.CommunityTime.zone value

    builder.Services.AddSingleton<TimeZoneInfo> communityZone
    |> ignore

    // Мост из health checks, зарегистрированных ServiceDefaults, в grpc.health.v1.
    // Источником состояния остаётся ServiceDefaults, gRPC — только его витрина.
    builder.Services.AddGrpcHealthChecks() |> ignore

    // Reflection включён безусловно, как в Identity: иначе каждая ручная проверка
    // grpcurl требует -import-path и -proto.
    builder.Services.AddGrpcReflection() |> ignore

    // Фоновая публикация из журнала. Порт рабочий, когда задан адрес NATS, и
    // ненастроенный без него: тогда цикл не стартует и в базу не ходит, и хост
    // поднимается без брокера ровно так же, как без базы. Ветка по конфигурации, а
    // не по доступности: недоступный NATS при заданном адресе — отказ каждого тика,
    // а не повод молча выключить публикацию.
    match builder.Configuration[NatsEventPublisher.UrlVariable] with
    | null
    | "" ->
        builder.Services.AddSingleton<DispatchMeetupEvents.Port>(DispatchMeetupEvents.Port.Unconfigured)
        |> ignore
    | url ->
        // Клиент Aspire, а не свой NatsConnection: логи клиента, трассировка и
        // переподключение приходят той же интеграцией, что у остальных ресурсов.
        // Health check выключен намеренно: недоступный NATS перевёл бы
        // grpc.health.v1 в NOT_SERVING, хотя команды и чтение работают без шины, а
        // публикация догонит журнал после его возвращения.
        builder.AddNatsClient(
            "nats",
            fun (settings: Aspire.NATS.Net.NatsClientSettings) ->
                settings.ConnectionString <- url
                settings.DisableHealthChecks <- true
        )

        builder.AddNatsJetStream()

        builder.Services.AddSingleton<DispatchMeetupEvents.Port>(fun services ->
            let send =
                NatsEventPublisher.ofContext (services.GetRequiredService<NATS.Client.JetStream.INatsJSContext>())

            DispatchMeetupEvents.Port.Publish(NatsEventPublisher.publish send NatsEventPublisher.defaultAckTimeout)
        )
        |> ignore

    // Источник права для CheckMeetupAuthority (ADR-051). Ветка по конфигурации, как
    // у шины: без адреса хост поднимается, а метод отвечает UNAVAILABLE — профиль
    // `meetups` Identity не поднимает намеренно. Недоступный Identity при заданном
    // адресе — тот же UNAVAILABLE, но уже ответом на вызов, а не молчаливым отключением.
    match builder.Configuration[IdentityRoleClient.UrlVariable] with
    | null
    | "" ->
        builder.Services.AddSingleton<CheckMeetupAuthority.Port>(CheckMeetupAuthority.Port.Unconfigured)
        |> ignore
    | url ->
        let send = IdentityRoleClient.connect url

        builder.Services.AddSingleton<CheckMeetupAuthority.Port>(
            CheckMeetupAuthority.Port.Connected(IdentityRoleClient.ask send IdentityRoleClient.defaultDeadline)
        )
        |> ignore

    builder.Services.AddHostedService<OutboxDispatchWorker>()
    |> ignore

    // Вторая фоновая граница: наступивший момент отложенной публикации (ADR-024, 4a).
    // Варианта «не настроена» у неё нет — всё, что нужно тику, это та же база, в
    // которую сервис уже пишет команды, поэтому цикл стартует безусловно. Хост при
    // недоступной базе от этого не падает: тик глотает свой отказ и пишет о нём.
    builder.Services.AddHostedService<DuePublicationWorker>()
    |> ignore

    // Метр публикации экспортируется отсюда, а не из ServiceDefaults: там живёт
    // межсервисный `solguficky.failures` из норматива, а бэклог journal-outbox
    // принадлежит одному Meetups, и в общем проекте он раздал бы остальным сервисам
    // метр, который они никогда не наполнят. Метр отложенной публикации — по той же
    // причине и рядом.
    builder.Services.ConfigureOpenTelemetryMeterProvider(fun metrics ->
        metrics.AddMeter DispatchTelemetry.MeterName
        |> ignore

        metrics.AddMeter PublisherTelemetry.MeterName
        |> ignore

        metrics.AddMeter DuePublicationTelemetry.MeterName
        |> ignore
    )
    |> ignore

    configure builder.Services

    let app = builder.Build()

    // MapDefaultEndpoints намеренно не вызывается: /health и /alive недостижимы
    // на Http2-only endpoint, а готовность сервис отдаёт по grpc.health.v1.
    app.MapGrpcService<MeetupsGrpcService>() |> ignore
    app.MapGrpcHealthChecksService() |> ignore
    app.MapGrpcReflectionService() |> ignore

    app

let build (args: string array) : WebApplication = buildWith ignore args
