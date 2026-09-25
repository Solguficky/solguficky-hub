using AppHost.Configuration.Infrastructure;
using NATS.Client.JetStream.Models;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Таблица топологии и конфиги из неё — чистые данные, поэтому проверяются на
/// L0. Применение к живому серверу подтверждает прогон Aspire, а не этот набор.
/// </summary>
public class JetStreamTopologyTests
{
    [Fact]
    public void DurableName_ConsumerAndStream_JoinsLowercaseHyphenated() =>
        JetStreamTopology.DurableName("notifications", "MEETUPS_EVENTS").ShouldBe("notifications-meetups-events");

    /// <summary>
    /// Пересечение subjects JetStream отвергает на создании второго стрима:
    /// без проверки ошибка всплыла бы только на старте AppHost.
    /// </summary>
    [Fact]
    public void Streams_AllDomains_SubjectsDoNotOverlap() =>
        JetStreamTopology.Streams.Select(stream => stream.Subject).ShouldBeUnique();

    [Fact]
    public void Durables_EveryConsumerAndStream_HaveExactlyOneDurable()
    {
        var durables = JetStreamTopology.Durables.ToList();

        durables.Count.ShouldBe(JetStreamTopology.Consumers.Count * JetStreamTopology.Streams.Count);
        durables.Select(durable => durable.Durable).ShouldBeUnique();
    }

    [Fact]
    public void Durables_AnyDurable_FiltersItsStreamSubject()
    {
        var subjects = JetStreamTopology.Streams.ToDictionary(stream => stream.Name, stream => stream.Subject);

        foreach (var durable in JetStreamTopology.Durables)
        {
            durable.FilterSubject.ShouldBe(subjects[durable.Stream]);
        }
    }

    /// <summary>
    /// Точка, <c>*</c>, <c>&gt;</c> и пробел в имени durable сервер запрещает:
    /// имя становится токеном subject'а API JetStream.
    /// </summary>
    [Fact]
    public void Durables_AnyDurable_NameIsValidJetStreamToken()
    {
        foreach (var durable in JetStreamTopology.Durables)
        {
            durable.Durable.IndexOfAny(['.', '*', '>', ' ']).ShouldBe(-1, durable.Durable);
        }
    }

    [Fact]
    public void ToConfig_Stream_KeepsByLimitsOnDiskForSevenDays()
    {
        var config = JetStreamTopology.ToConfig(JetStreamTopology.Streams[0]);

        config.Retention.ShouldBe(StreamConfigRetention.Limits);
        config.Storage.ShouldBe(StreamConfigStorage.File);
        config.Discard.ShouldBe(StreamConfigDiscard.Old);
        config.MaxAge.ShouldBe(TimeSpan.FromDays(7));
        config.DuplicateWindow.ShouldBe(TimeSpan.FromMinutes(2));
        config.Subjects.ShouldBe(["events.meetups.>"]);
    }

    /// <summary>
    /// Без явного ack позиция двигается на выдаче, и упавший потребитель теряет
    /// сообщение; без DeliverAll durable, созданный раньше потребителя, не отдаст
    /// то, что пришло до его первого старта.
    /// </summary>
    [Fact]
    public void ToConfig_Durable_AcksExplicitlyFromStreamStart()
    {
        var durable = JetStreamTopology.Durables.First();
        var config = JetStreamTopology.ToConfig(durable);

        config.DurableName.ShouldBe(durable.Durable);
        config.FilterSubject.ShouldBe(durable.FilterSubject);
        config.AckPolicy.ShouldBe(ConsumerConfigAckPolicy.Explicit);
        config.DeliverPolicy.ShouldBe(ConsumerConfigDeliverPolicy.All);
    }
}
