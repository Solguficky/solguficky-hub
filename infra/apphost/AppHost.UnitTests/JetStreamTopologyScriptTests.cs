using System.Text.Json;
using AppHost.Configuration.Infrastructure;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Файлы Job топологии в чарте выводятся из той же таблицы, что применяет хук
/// AppHost. Применение их <c>nats</c> CLI к живому серверу подтверждено прогоном
/// при PER-311, а не этим набором: здесь — что ни одна запись таблицы не
/// выпадает и значения доходят до конфига без потерь.
/// </summary>
public class JetStreamTopologyScriptTests
{
    [Fact]
    public void Files_EveryStreamAndDurable_HasItsConfigNextToTheScript()
    {
        var files = JetStreamTopologyScript.Files();

        files.Keys.ShouldBe(
            JetStreamTopology.Streams.Select(stream => JetStreamTopologyScript.StreamFile(stream.Name))
                .Concat(JetStreamTopology.Durables.Select(durable => JetStreamTopologyScript.ConsumerFile(durable.Durable)))
                .Append(JetStreamTopologyScript.ScriptKey),
            ignoreOrder: true);
    }

    /// <summary>
    /// Ключ ConfigMap становится именем файла тома и обязан проходить правило
    /// Kubernetes <c>[-._a-zA-Z0-9]+</c>.
    /// </summary>
    [Fact]
    public void Files_AnyKey_IsAValidConfigMapKey() =>
        JetStreamTopologyScript.Files().Keys.ShouldAllBe(key => System.Text.RegularExpressions.Regex.IsMatch(key, "^[-._a-zA-Z0-9]+$"));

    [Fact]
    public void Script_AnyEntry_IsAppliedOnce()
    {
        var script = JetStreamTopologyScript.Script();

        foreach (var stream in JetStreamTopology.Streams)
        {
            script.ShouldContain($"nats stream add --config \"$dir/{JetStreamTopologyScript.StreamFile(stream.Name)}\"");
        }

        foreach (var durable in JetStreamTopology.Durables)
        {
            script.ShouldContain($"nats consumer add {durable.Stream} --config \"$dir/{JetStreamTopologyScript.ConsumerFile(durable.Durable)}\"");
        }

        foreach (var bucket in JetStreamTopology.KeyValueBuckets)
        {
            script.ShouldContain($"nats kv add {bucket.Bucket} --history 1 --ttl 192h --storage file --replicas 1");
        }
    }

    /// <summary>
    /// Скрипт исполняет sh в Linux-образе: возврат каретки сделал бы каждую
    /// строку чужой командой, а чарт, собранный на Windows, разошёлся бы с CI.
    /// </summary>
    [Fact]
    public void Script_LineEndings_AreLineFeedOnly()
    {
        var script = JetStreamTopologyScript.Script();

        script.ShouldNotContain('\r');
        script.ShouldStartWith("#!/bin/sh\n");
        script.ShouldContain("set -eu\n");
    }

    [Fact]
    public void StreamConfig_Stream_CarriesTableValuesInApiUnits()
    {
        using var json = JsonDocument.Parse(JetStreamTopologyScript.StreamConfig(JetStreamTopology.Streams[0]));
        var config = json.RootElement;

        config.GetProperty("name").GetString().ShouldBe("MEETUPS_EVENTS");
        config.GetProperty("subjects")[0].GetString().ShouldBe("events.meetups.>");
        config.GetProperty("retention").GetString().ShouldBe("limits");
        config.GetProperty("storage").GetString().ShouldBe("file");
        config.GetProperty("discard").GetString().ShouldBe("old");
        config.GetProperty("max_age").GetInt64().ShouldBe((long)TimeSpan.FromDays(7).TotalNanoseconds);
        config.GetProperty("duplicate_window").GetInt64().ShouldBe((long)TimeSpan.FromMinutes(2).TotalNanoseconds);
        config.GetProperty("num_replicas").GetInt32().ShouldBe(1);
    }

    [Fact]
    public void ConsumerConfig_Durable_AcksExplicitlyFromStreamStart()
    {
        var durable = JetStreamTopology.Durables.First();
        using var json = JsonDocument.Parse(JetStreamTopologyScript.ConsumerConfig(durable));
        var config = json.RootElement;

        config.GetProperty("durable_name").GetString().ShouldBe(durable.Durable);
        config.GetProperty("filter_subject").GetString().ShouldBe(durable.FilterSubject);
        config.GetProperty("ack_policy").GetString().ShouldBe("explicit");
        config.GetProperty("deliver_policy").GetString().ShouldBe("all");
    }
}
