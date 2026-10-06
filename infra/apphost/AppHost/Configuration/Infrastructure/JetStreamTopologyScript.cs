using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using NATS.Client.JetStream.Models;
using NATS.Client.KeyValueStore;

namespace AppHost.Configuration.Infrastructure;

/// <summary>
/// Та же таблица <see cref="JetStreamTopology"/>, переложенная для кластера:
/// JSON-конфиги streams и durables в форме API JetStream и shell-скрипт для
/// <c>nats</c> CLI, который их применяет. Локально топологию применяет хук
/// AppHost, в чарте — Job из этих файлов (<see cref="NatsSetup.Publish"/>), и
/// второго описания топологии нет.
/// </summary>
/// <remarks>
/// <c>nats stream add</c> и <c>nats consumer add</c> с тем же конфигом
/// проходят, с изменённым — отказывают кодом 10058, и тогда конфиг применяет
/// <c>edit</c>: вместе это <c>CreateOrUpdate</c> хука. Правку, которую JetStream
/// на живом объекте не принимает, отвергает и <c>edit</c>, и Job падает — как
/// падает хук AppHost.
/// </remarks>
internal static class JetStreamTopologyScript
{
    public const string ScriptKey = "apply.sh";

    private const long NanosecondsPerTick = 100;

    private static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = false,
        // `>` в subjects — wildcard, а не HTML: экранирование только мешало бы читать конфиг.
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>Ключ ConfigMap — содержимое файла. Ключи годятся в имена файлов тома.</summary>
    public static IReadOnlyDictionary<string, string> Files()
    {
        var files = new SortedDictionary<string, string>(StringComparer.Ordinal)
        {
            [ScriptKey] = Script(),
        };

        foreach (var stream in JetStreamTopology.Streams)
        {
            files[StreamFile(stream.Name)] = StreamConfig(stream);
        }

        foreach (var durable in JetStreamTopology.Durables)
        {
            files[ConsumerFile(durable.Durable)] = ConsumerConfig(durable);
        }

        return files;
    }

    public static string StreamFile(string stream) => $"stream-{stream}.json";

    public static string ConsumerFile(string durable) => $"consumer-{durable}.json";

    public static string StreamConfig(StreamSpec spec)
    {
        var config = JetStreamTopology.ToConfig(spec);
        return JsonSerializer.Serialize(
            new Dictionary<string, object>
            {
                ["name"] = config.Name!,
                ["subjects"] = config.Subjects!,
                ["retention"] = Api(config.Retention),
                ["storage"] = Api(config.Storage),
                ["discard"] = Api(config.Discard),
                ["max_age"] = Nanoseconds(config.MaxAge),
                ["duplicate_window"] = Nanoseconds(config.DuplicateWindow),
                ["num_replicas"] = config.NumReplicas,
            },
            Json);
    }

    public static string ConsumerConfig(ConsumerSpec spec)
    {
        var config = JetStreamTopology.ToConfig(spec);
        return JsonSerializer.Serialize(
            new Dictionary<string, object>
            {
                ["durable_name"] = config.DurableName!,
                ["filter_subject"] = config.FilterSubject!,
                ["ack_policy"] = Api(config.AckPolicy),
                ["deliver_policy"] = Api(config.DeliverPolicy),
            },
            Json);
    }

    /// <summary>
    /// Скрипт читает файлы из каталога, переданного первым аргументом, а адрес
    /// сервера — из <c>NATS_URL</c>, который <c>nats</c> CLI берёт сам.
    /// </summary>
    public static string Script()
    {
        var script = new StringBuilder();
        Line(script, "#!/bin/sh");
        Line(script, "# Generated from JetStreamTopology.cs by the AppHost publish. Do not edit.");
        Line(script, "set -eu");
        Line(script, "dir=\"$1\"");
        Line(script);

        foreach (var stream in JetStreamTopology.Streams)
        {
            var file = $"\"$dir/{StreamFile(stream.Name)}\"";
            Line(script,
                $"nats stream add --config {file} >/dev/null 2>&1 || nats stream edit {stream.Name} --config {file} -f >/dev/null");
            Line(script, $"echo \"stream {stream.Name}\"");
        }

        foreach (var durable in JetStreamTopology.Durables)
        {
            var file = $"\"$dir/{ConsumerFile(durable.Durable)}\"";
            Line(script,
                $"nats consumer add {durable.Stream} --config {file} >/dev/null 2>&1 || nats consumer edit {durable.Stream} {durable.Durable} --config {file} -f >/dev/null");
            Line(script, $"echo \"durable {durable.Durable}\"");
        }

        foreach (var bucket in JetStreamTopology.KeyValueBuckets)
        {
            var config = JetStreamTopology.ToConfig(bucket);
            var ttl = Hours(config.MaxAge);
            Line(script,
                $"nats kv add {bucket.Bucket} --history {config.History} --ttl {ttl} --storage {Api(config.Storage)} --replicas {config.NumberOfReplicas} >/dev/null 2>&1 " +
                $"|| nats kv edit {bucket.Bucket} --history {config.History} --ttl {ttl} >/dev/null");
            Line(script, $"echo \"bucket {bucket.Bucket}\"");
        }

        return script.ToString();
    }

    // Перевод строки явный: AppendLine на Windows дал бы CRLF, sh в образе
    // споткнулся бы о возврат каретки, а чарт зависел бы от ОС публикации.
    private static void Line(StringBuilder script, string line = "") => script.Append(line).Append('\n');

    // Имена значений в API JetStream. Таблица берёт только эти; новое значение
    // роняет публикацию, а не уезжает в кластер конфигом, которого хук AppHost
    // не применял.
    private static string Api(StreamConfigRetention value) => value switch
    {
        StreamConfigRetention.Limits => "limits",
        StreamConfigRetention.Interest => "interest",
        StreamConfigRetention.Workqueue => "workqueue",
        _ => throw Unmapped(value),
    };

    private static string Api(StreamConfigStorage value) => value switch
    {
        StreamConfigStorage.File => "file",
        StreamConfigStorage.Memory => "memory",
        _ => throw Unmapped(value),
    };

    private static string Api(NatsKVStorageType value) => value switch
    {
        NatsKVStorageType.File => "file",
        NatsKVStorageType.Memory => "memory",
        _ => throw Unmapped(value),
    };

    private static string Api(StreamConfigDiscard value) => value switch
    {
        StreamConfigDiscard.Old => "old",
        StreamConfigDiscard.New => "new",
        _ => throw Unmapped(value),
    };

    private static string Api(ConsumerConfigAckPolicy value) => value switch
    {
        ConsumerConfigAckPolicy.Explicit => "explicit",
        ConsumerConfigAckPolicy.All => "all",
        ConsumerConfigAckPolicy.None => "none",
        _ => throw Unmapped(value),
    };

    private static string Api(ConsumerConfigDeliverPolicy value) => value switch
    {
        ConsumerConfigDeliverPolicy.All => "all",
        ConsumerConfigDeliverPolicy.Last => "last",
        ConsumerConfigDeliverPolicy.New => "new",
        _ => throw Unmapped(value),
    };

    private static InvalidOperationException Unmapped<T>(T value) where T : Enum =>
        new($"JetStream {typeof(T).Name}.{value} has no mapping for the cluster topology Job.");

    private static long Nanoseconds(TimeSpan value) => value.Ticks * NanosecondsPerTick;

    // Срок KV у CLI — длительность Go; таблица держит целые часы, и отказ здесь
    // дешевле, чем молча округлённый срок жизни записи доставки.
    private static string Hours(TimeSpan value)
    {
        if (value.Ticks % TimeSpan.TicksPerHour != 0)
        {
            throw new InvalidOperationException($"Key-value max age {value} is not a whole number of hours.");
        }

        return string.Create(CultureInfo.InvariantCulture, $"{(long)value.TotalHours}h");
    }
}
