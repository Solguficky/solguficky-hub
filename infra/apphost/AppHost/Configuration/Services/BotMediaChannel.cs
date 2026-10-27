using Microsoft.Extensions.Configuration;

namespace AppHost.Configuration.Services;

/// <summary>
/// Закрытый канал медиа ботов (дополнение ADR-057 от 2026-10-27, временное до
/// PER-711): своё фото объявления, промо-видео аукциона и другие медиа лежат
/// там постами, а бот показывает пост человеку <c>copyMessage</c>. Канал один
/// на оба бота: <c>file_id</c> привязан к боту, а объявление, загруженное в
/// хабе, гостю доставляет бот аукциона, — поэтому оба бота в нём
/// администраторы и копируют один и тот же пост.
///
/// Без id нет и переменной: медиа выключены, а боты работают без них. Локально
/// id — настройка, как имя бота поддержки (<see cref="SupportBotLink"/>), а не
/// параметр Aspire: пустой параметр дашборд спросил бы, и бот ждал бы ввода. В
/// чарте id — параметр без значения: его кладут values среды, у каждой среды
/// свой канал, а пустое значение бот читает как отсутствие.
/// </summary>
internal sealed class BotMediaChannel
{
    /// <summary>Задаётся user-secrets AppHost или переменной <c>BotMedia__ChannelId</c>.</summary>
    internal const string ChannelIdKey = "BotMedia:ChannelId";

    internal const string ChannelIdParameter = "bot-media-channel-id";

    internal const string Variable = "BOT_MEDIA_CHANNEL_ID";

    private readonly string? channelId;
    private readonly IResourceBuilder<ParameterResource>? parameter;

    private BotMediaChannel(string? channelId, IResourceBuilder<ParameterResource>? parameter)
    {
        this.channelId = channelId;
        this.parameter = parameter;
    }

    /// <summary>
    /// Локальный запуск: id из настройки, без неё медиа выключены. Форму id
    /// проверяет сам бот на старте: AppHost передаёт значение как есть. Канал —
    /// той среды Telegram, в которую ходит запуск: канала одной среды в другой нет.
    /// </summary>
    public static BotMediaChannel? Local(IConfiguration configuration)
    {
        var channelId = configuration[ChannelIdKey]?.Trim();
        return string.IsNullOrEmpty(channelId) ? null : new BotMediaChannel(channelId, null);
    }

    /// <summary>
    /// Чарт: один параметр на оба бота. Второй бот берёт параметр, который
    /// объявил первый, — повторное объявление того же имени Aspire отвергает.
    /// </summary>
    public static BotMediaChannel Published(IDistributedApplicationBuilder builder)
    {
        var existing = builder.Resources
            .OfType<ParameterResource>()
            .SingleOrDefault(resource => resource.Name == ChannelIdParameter);

        return new BotMediaChannel(
            null,
            existing is null ? builder.AddParameter(ChannelIdParameter) : builder.CreateResourceBuilder(existing));
    }

    public IResourceBuilder<T> ChannelId<T>(IResourceBuilder<T> bot)
        where T : IResourceWithEnvironment =>
        parameter is null
            ? bot.WithEnvironment(Variable, channelId!)
            : bot.WithEnvironment(Variable, parameter);
}
