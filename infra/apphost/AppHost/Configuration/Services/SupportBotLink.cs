using Microsoft.Extensions.Configuration;

namespace AppHost.Configuration.Services;

/// <summary>
/// Адрес бота поддержки у двух других ботов (ADR-068, п. 2): имя без «@», по
/// которому хаб собирает «Написать в поддержку ↗» на <c>?start=hub</c>, и
/// готовая «Задать вопрос ↗» FAQ аукциона на <c>?start=auction</c> — её код
/// FAQ уже читает, и правки кода она не требует. Бот хаба не знает имени сам:
/// getMe по чужому токену дал бы ему чужой секрет.
///
/// Без имени нет ни одной переменной: без адреса бота поддержки ни ряда в
/// «Помощи», ни кнопки в ожидании нет. Локально имя — настройка, как имя бота
/// аукциона (<see cref="HubBotSetup.AuctionBotUsernameKey"/>), а не параметр
/// Aspire: пустой параметр дашборд спросил бы и у тех, кому бот поддержки не
/// нужен. В чарте имя — параметр без значения: его кладут values среды, у
/// каждой среды свой бот.
/// </summary>
internal sealed class SupportBotLink
{
    /// <summary>Задаётся user-secrets AppHost или переменной <c>SupportBot__Username</c>.</summary>
    internal const string UsernameKey = "SupportBot:Username";

    internal const string UsernameParameter = "support-bot-username";

    private readonly string? username;
    private readonly IResourceBuilder<ParameterResource>? parameter;

    private SupportBotLink(string? username, IResourceBuilder<ParameterResource>? parameter)
    {
        this.username = username;
        this.parameter = parameter;
    }

    /// <summary>Локальный запуск: имя из настройки, без неё адреса нет.</summary>
    public static SupportBotLink? Local(IConfiguration configuration)
    {
        // AppHost передаёт значение как есть. Форму имени бот пока не проверяет:
        // переменную имени он начнёт читать с PER-625, а FAQ аукциона проверяет
        // только, что адрес — HTTPS. Поэтому значение — ник без «@».
        var username = configuration[UsernameKey]?.Trim();
        return string.IsNullOrEmpty(username) ? null : new SupportBotLink(username, null);
    }

    /// <summary>
    /// Чарт: один параметр на оба бота. Второй бот берёт параметр, который
    /// объявил первый, — повторное объявление того же имени Aspire отвергает.
    /// </summary>
    public static SupportBotLink Published(IDistributedApplicationBuilder builder)
    {
        var existing = builder.Resources
            .OfType<ParameterResource>()
            .SingleOrDefault(resource => resource.Name == UsernameParameter);

        return new SupportBotLink(
            null,
            existing is null ? builder.AddParameter(UsernameParameter) : builder.CreateResourceBuilder(existing));
    }

    /// <summary>Имя для входа из хаба; ссылку с меткой бот собирает сам.</summary>
    public IResourceBuilder<T> Username<T>(IResourceBuilder<T> bot)
        where T : IResourceWithEnvironment =>
        parameter is null
            ? bot.WithEnvironment("BOT_SUPPORT_BOT_USERNAME", username!)
            : bot.WithEnvironment("BOT_SUPPORT_BOT_USERNAME", parameter);

    /// <summary>
    /// Имя и «Задать вопрос ↗» бота аукциона: FAQ принимает только готовый
    /// HTTPS-адрес, поэтому метку <c>?start=auction</c> ставит AppHost.
    /// </summary>
    public IResourceBuilder<T> UsernameAndQuestionUrl<T>(IResourceBuilder<T> bot)
        where T : IResourceWithEnvironment
    {
        if (parameter is not null)
        {
            return Username(bot).WithEnvironment(
                "AUCTION_FAQ_QUESTION_URL",
                ReferenceExpression.Create($"https://t.me/{parameter}?start=auction"));
        }

        // Строка готова до вызова: интерполяция прямо в аргументе выбрала бы
        // перегрузку с ReferenceExpression, и переменная перестала бы быть строкой.
        string url = $"https://t.me/{username}?start=auction";
        return Username(bot).WithEnvironment("AUCTION_FAQ_QUESTION_URL", url);
    }
}
