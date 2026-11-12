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
    public void Durables_AuctionDomain_NotificationsAndTesterReadItsStream()
    {
        JetStreamTopology.Streams.Single(stream => stream.Name == "AUCTION_EVENTS").Subject.ShouldBe("events.auction.>");
        JetStreamTopology.Durables.Where(durable => durable.Stream == "AUCTION_EVENTS")
            .Select(durable => durable.Durable).ShouldBe(["notifications-auction-events", "nats-tester-auction-events"], ignoreOrder: true);
    }

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
    public void Durables_EveryDeclaredPair_HasExactlyOneDurable()
    {
        var durables = JetStreamTopology.Durables.ToList();

        durables.Count.ShouldBe(JetStreamTopology.Consumers.Sum(consumer => consumer.Streams.Count));
        durables.Select(durable => durable.Durable).ShouldBeUnique();
    }

    /// <summary>
    /// Пара потребителя со стримом, которого нет в таблице, иначе упала бы
    /// только на старте AppHost, а не здесь.
    /// </summary>
    [Fact]
    public void Consumers_AnyDeclaredStream_ExistsInTopology()
    {
        var streams = JetStreamTopology.Streams.Select(stream => stream.Name).ToHashSet();

        foreach (var consumer in JetStreamTopology.Consumers)
        {
            consumer.Streams.ShouldAllBe(stream => streams.Contains(stream), consumer.Consumer);
        }
    }

    /// <summary>
    /// Сервис не читает собственный выход: такой durable копил бы сообщения,
    /// которые никто не подтверждает.
    /// </summary>
    [Fact]
    public void Durables_Notifications_DoesNotReadItsOwnFacts() =>
        JetStreamTopology.Durables
            .Select(durable => durable.Durable)
            .ShouldNotContain("notifications-notifications-events");

    /// <summary>
    /// Канал доставки читает только адресные факты: события Meetups и Identity
    /// ему не адресованы, и durable на них копил бы неподтверждаемое.
    /// </summary>
    [Fact]
    public void Durables_HubBot_ReadsOnlyNotificationFacts() =>
        JetStreamTopology.Durables
            .Single(durable => durable.Durable == "hub-bot-notifications-events")
            .FilterSubject.ShouldBe("events.notifications.notification_created.hub");

    /// <summary>
    /// Бот аукциона — второй канал доставки (PER-328): свой durable на тех же
    /// адресных фактах, а не общий с хабом, иначе каналы стали бы конкурентами
    /// за одно сообщение.
    /// </summary>
    [Fact]
    public void Durables_AuctionBot_ReadsNotificationFactsOnItsOwnDurable() =>
        JetStreamTopology.Durables
            .Single(durable => durable.Durable == "auction-bot-notifications-events")
            .FilterSubject.ShouldBe("events.notifications.notification_created.auction");

    /// <summary>
    /// Запись журнала обязана пережить последнюю повторную выдачу своего
    /// сообщения: истеки она раньше стрима, повтор ушёл бы человеку второй раз.
    /// </summary>
    [Theory]
    [InlineData("hub-bot-deliveries")]
    [InlineData("auction-bot-deliveries")]
    public void KeyValueBuckets_DeliveryJournal_OutlivesStreamRetention(string bucketName)
    {
        var journal = JetStreamTopology.KeyValueBuckets.Single(bucket => bucket.Bucket == bucketName);
        var deliveries = JetStreamTopology.Streams.Single(stream => stream.Name == "NOTIFICATIONS_EVENTS");

        journal.MaxAge.ShouldBeGreaterThan(JetStreamTopology.ToConfig(deliveries).MaxAge);
    }

    /// <summary>
    /// Журнал доставки идёт за окном стрима, который боты читают, а не за самым
    /// длинным в шине: свой срок <c>AUCTION_EVENTS</c> (PER-758) держал бы
    /// записи доставки три месяца без повода.
    /// </summary>
    [Theory]
    [InlineData("hub-bot-deliveries")]
    [InlineData("auction-bot-deliveries")]
    public void KeyValueBuckets_DeliveryJournal_LivesEightDays(string bucketName) =>
        JetStreamTopology.KeyValueBuckets.Single(bucket => bucket.Bucket == bucketName)
            .MaxAge.ShouldBe(TimeSpan.FromDays(8));

    /// <summary>
    /// Пара «человек ↔ тема» бота поддержки живёт 180 дней с последнего
    /// сообщения (ADR-068, п. 8): срок — свой, а не окно стрима журналов.
    /// </summary>
    [Fact]
    public void KeyValueBuckets_SupportTopics_LiveHalfAYear()
    {
        var topics = JetStreamTopology.KeyValueBuckets.Single(bucket => bucket.Bucket == "support-bot-topics");

        topics.MaxAge.ShouldBe(TimeSpan.FromDays(180));
    }

    /// <summary>
    /// Открытые живые экраны бота хаба (PER-815) живут двое суток с последней
    /// записи: запись старого пульта не копится, а второй рестарт подряд её
    /// не теряет.
    /// </summary>
    [Fact]
    public void KeyValueBuckets_HubBotLiveScreens_LiveTwoDays()
    {
        var screens = JetStreamTopology.KeyValueBuckets.Single(bucket => bucket.Bucket == "hub-bot-live-screens");

        screens.MaxAge.ShouldBe(TimeSpan.FromDays(2));
    }

    /// <summary>
    /// Состав зала помощника (ADR-070, дополнение 2026-10-29) нужен на время
    /// одного события: двое суток с последней правки, а не окно стрима.
    /// </summary>
    [Fact]
    public void KeyValueBuckets_FloorRoom_LivesTwoDays()
    {
        var room = JetStreamTopology.KeyValueBuckets.Single(bucket => bucket.Bucket == "hub-bot-floor-room");

        room.MaxAge.ShouldBe(TimeSpan.FromDays(2));
    }

    [Fact]
    public void KeyValueBuckets_AuctionBotLiveScreens_LiveTwoDays()
    {
        var screens = JetStreamTopology.KeyValueBuckets.Single(bucket => bucket.Bucket == "auction-bot-live-screens");

        screens.MaxAge.ShouldBe(TimeSpan.FromDays(2));
    }

    [Fact]
    public void ToConfig_Bucket_KeepsLatestStateOnDisk()
    {
        var config = JetStreamTopology.ToConfig(JetStreamTopology.KeyValueBuckets[0]);

        config.History.ShouldBe(1);
        config.Storage.ShouldBe(NATS.Client.KeyValueStore.NatsKVStorageType.File);
    }

    [Fact]
    public void Durables_NatsTester_ReadsEveryStream() =>
        JetStreamTopology.Durables
            .Where(durable => durable.Durable.StartsWith("nats-tester-", StringComparison.Ordinal))
            .Select(durable => durable.Stream)
            .ShouldBe(JetStreamTopology.Streams.Select(stream => stream.Name), ignoreOrder: true);

    [Fact]
    public void Durables_AnyDurable_FiltersItsStreamSubject()
    {
        var subjects = JetStreamTopology.Streams.ToDictionary(stream => stream.Name, stream => stream.Subject);
        // Узкий фильтр пара объявляет явно; он обязан лежать внутри subjects своего стрима.
        var narrowed = JetStreamTopology.Consumers
            .SelectMany(consumer => (consumer.FilterSubjects ?? new Dictionary<string, string>())
                .Select(filter => JetStreamTopology.DurableName(consumer.Consumer, filter.Key)))
            .ToHashSet();

        foreach (var durable in JetStreamTopology.Durables)
        {
            if (narrowed.Contains(durable.Durable))
            {
                durable.FilterSubject.ShouldStartWith(subjects[durable.Stream].TrimEnd('>'));
            }
            else
            {
                durable.FilterSubject.ShouldBe(subjects[durable.Stream]);
            }
        }
    }

    /// <summary>
    /// Auction читает из стрима Meetups только отмену сходки (ADR-047,
    /// дополнение 2026-10-12): остальные поводы ему не адресованы, и durable на
    /// весь стрим копил бы неподтверждаемое.
    /// </summary>
    [Fact]
    public void Durables_Auction_ReadsOnlyMeetupCancellations() =>
        JetStreamTopology.Durables
            .Single(durable => durable.Durable == "auction-meetups-events")
            .ShouldBe(new ConsumerSpec("auction-meetups-events", "MEETUPS_EVENTS", "events.meetups.meetup_cancelled"));

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
    /// Факты аукциона ждут правил ачивок (ADR-077, PER-758) девяносто дней;
    /// остальные стримы держат общее окно простоя потребителя.
    /// </summary>
    [Theory]
    [InlineData("MEETUPS_EVENTS", 7)]
    [InlineData("IDENTITY_EVENTS", 7)]
    [InlineData("AUCTION_EVENTS", 90)]
    [InlineData("NOTIFICATIONS_EVENTS", 7)]
    [InlineData("ACHIEVEMENTS_EVENTS", 7)]
    public void ToConfig_Stream_KeepsMessagesForItsRetention(string streamName, int days)
    {
        var stream = JetStreamTopology.Streams.Single(candidate => candidate.Name == streamName);

        JetStreamTopology.ToConfig(stream).MaxAge.ShouldBe(TimeSpan.FromDays(days));
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
