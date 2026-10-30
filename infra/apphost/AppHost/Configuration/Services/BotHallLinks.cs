using Microsoft.Extensions.Configuration;

namespace AppHost.Configuration.Services;

/// <summary>
/// Экран зала и стрим (PER-825, дополнение ADR-040 от 2026-10-29): боты ставят
/// «Экран зала ↗» под карточкой лота, а бот хаба ещё и в «Расширения» сходки;
/// «Стрим ↗» — рядом, если стрим будет. Адрес экрана зала — база страницы, к ней
/// бот дописывает идентификатор аукциона; публичный вход в экран — ADR-071.
///
/// Оба адреса необязательны: без экрана зала нет первой кнопки, без стрима —
/// второй, и боты стартуют как прежде. Форму значения (HTTPS без credentials)
/// проверяет сам бот на старте: AppHost передаёт его как есть. Локально адреса —
/// настройки, как имя бота поддержки (<see cref="SupportBotLink"/>), а не параметры
/// Aspire: пустой параметр дашборд спросил бы, и бот ждал бы ввода. В чарте
/// каждый адрес — параметр без значения, общий для двух ботов: значения кладёт
/// среда, а пустое бот читает как отсутствие.
/// </summary>
internal sealed class BotHallLinks
{
    /// <summary>Задаётся user-secrets AppHost или переменной <c>HallLinks__ScreenUrl</c>.</summary>
    internal const string ScreenUrlKey = "HallLinks:ScreenUrl";

    /// <summary>Задаётся user-secrets AppHost или переменной <c>HallLinks__StreamUrl</c>.</summary>
    internal const string StreamUrlKey = "HallLinks:StreamUrl";

    internal const string ScreenUrlParameter = "bot-hall-screen-url";

    internal const string StreamUrlParameter = "bot-stream-url";

    internal const string ScreenUrlVariable = "BOT_HALL_SCREEN_URL";

    internal const string StreamUrlVariable = "BOT_STREAM_URL";

    private readonly string? screenUrl;
    private readonly string? streamUrl;
    private readonly IResourceBuilder<ParameterResource>? screenUrlParameter;
    private readonly IResourceBuilder<ParameterResource>? streamUrlParameter;

    private BotHallLinks(
        string? screenUrl,
        string? streamUrl,
        IResourceBuilder<ParameterResource>? screenUrlParameter,
        IResourceBuilder<ParameterResource>? streamUrlParameter)
    {
        this.screenUrl = screenUrl;
        this.streamUrl = streamUrl;
        this.screenUrlParameter = screenUrlParameter;
        this.streamUrlParameter = streamUrlParameter;
    }

    /// <summary>Локальный запуск: адреса из настройки, без неё переменной нет.</summary>
    public static BotHallLinks Local(IConfiguration configuration) =>
        new(
            NullIfEmpty(configuration[ScreenUrlKey]),
            NullIfEmpty(configuration[StreamUrlKey]),
            null,
            null);

    /// <summary>
    /// Чарт: по параметру на адрес, общему для двух ботов. Второй бот берёт
    /// параметры, которые объявил первый, — повторное объявление того же имени
    /// Aspire отвергает.
    /// </summary>
    public static BotHallLinks Published(IDistributedApplicationBuilder builder) =>
        new(null, null, Parameter(builder, ScreenUrlParameter), Parameter(builder, StreamUrlParameter));

    public IResourceBuilder<T> Urls<T>(IResourceBuilder<T> bot)
        where T : IResourceWithEnvironment
    {
        if (screenUrlParameter is not null && streamUrlParameter is not null)
        {
            return bot
                .WithEnvironment(ScreenUrlVariable, screenUrlParameter)
                .WithEnvironment(StreamUrlVariable, streamUrlParameter);
        }

        if (screenUrl is not null)
        {
            bot.WithEnvironment(ScreenUrlVariable, screenUrl);
        }

        if (streamUrl is not null)
        {
            bot.WithEnvironment(StreamUrlVariable, streamUrl);
        }

        return bot;
    }

    private static string? NullIfEmpty(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    private static IResourceBuilder<ParameterResource> Parameter(IDistributedApplicationBuilder builder, string name)
    {
        var existing = builder.Resources
            .OfType<ParameterResource>()
            .SingleOrDefault(resource => resource.Name == name);

        return existing is null ? builder.AddParameter(name) : builder.CreateResourceBuilder(existing);
    }
}
