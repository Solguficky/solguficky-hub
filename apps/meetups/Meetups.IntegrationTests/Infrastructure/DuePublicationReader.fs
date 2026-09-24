/// Прогон продуктового тика отложенной публикации против настоящей базы.
///
/// Зависимости собираются тем же `Composition.buildDeps`, что и в хосте, а не
/// повторяются здесь руками: иначе сценарий проверял бы сборку, написанную ради
/// теста, и разошёлся бы с продуктом молча — вместе с SQL выборки, отображением
/// строки и размером пачки.
module Meetups.IntegrationTests.Infrastructure.DuePublicationReader

open System
open System.Threading
open Meetups.Slices.PublishDueMeetups
open Microsoft.Extensions.Configuration
open Microsoft.Extensions.DependencyInjection
open Npgsql

let private provider (source: NpgsqlDataSource) (batchSize: int) =
    let configuration =
        ConfigurationBuilder()
            .AddInMemoryCollection(
                dict
                    [
                        Composition.BatchSizeVariable, string batchSize
                    ]
            )
            .Build()

    ServiceCollection()
        .AddSingleton<NpgsqlDataSource>(source)
        .AddSingleton<IConfiguration>(configuration)
        .BuildServiceProvider()

/// Часы подменяются одним полем поверх продуктовой сборки, а всё остальное остаётся
/// продуктовым. Только это и делает критерий «момент наступил» проверяемым без сна:
/// `now` доходит и до параметра выборки, и до решения домена, поэтому тесту не нужны
/// ни реальный таймер, ни ожидание.
let private depsAt (services: IServiceProvider) (now: DateTimeOffset) =
    { Composition.buildDeps services with
        Now = fun () -> now
    }

/// Один тик против настоящей базы с явно заданным «сейчас».
let runTickAt (source: NpgsqlDataSource) (now: DateTimeOffset) (batchSize: int) =
    use services = provider source batchSize

    execute (depsAt services now) CancellationToken.None
    |> Async.AwaitTask
    |> Async.RunSynchronously

/// Тот же тик со швом между выборкой и попыткой записи.
///
/// Шов нужен ровно одному классу утверждений — гонке за строку. Соперник исполняется
/// в колбэке, то есть тем же потоком и в порядке, написанном в тесте: удача
/// планировщика в проверку не входит, и замигать она не может. Продуктовым остаётся
/// всё, включая саму выборку — колбэк зовётся после неё, а не вместо.
let runTickInterleaved (source: NpgsqlDataSource) (now: DateTimeOffset) (batchSize: int) (rival: unit -> unit) =
    use services = provider source batchSize
    let deps = depsAt services now
    let scan = deps.ReadDue

    let interleaved =
        { deps with
            ReadDue =
                fun at limit ->
                    task {
                        let! scanned = scan at limit

                        rival ()

                        return scanned
                    }
        }

    execute interleaved CancellationToken.None
    |> Async.AwaitTask
    |> Async.RunSynchronously
