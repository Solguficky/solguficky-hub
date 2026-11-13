using Microsoft.Extensions.Configuration;

namespace AppHost.Configuration.Services;

/// <summary>
/// Чат сообщества бота хаба (ADR-078, п. 2): единственная группа, где бот
/// работает, — из остальных он выходит на первом update. Узел как у группы
/// операторов поддержки (<see cref="SupportBotSetup"/>), но необязательный: без
/// id нет и переменной, и бот, как прежде, групп не обрабатывает и ни из одной
/// не выходит. Поэтому локально id — настройка, как канал медиа ботов
/// (<see cref="BotMediaChannel"/>), а не параметр Aspire: пустой параметр
/// дашборд спросил бы, и бот ждал бы ввода. В чарте id — параметр без значения:
/// его кладут values среды, у каждой среды свой чат, а пустое значение бот
/// читает как отсутствие.
/// </summary>
internal sealed class HubBotCommunityChat
{
    /// <summary>Задаётся user-secrets AppHost или переменной <c>HubBot__CommunityChatId</c>.</summary>
    internal const string ChatIdKey = "HubBot:CommunityChatId";

    internal const string ChatIdParameter = "community-chat-id";

    internal const string Variable = "BOT_COMMUNITY_CHAT_ID";

    private readonly string? chatId;
    private readonly IResourceBuilder<ParameterResource>? parameter;

    private HubBotCommunityChat(string? chatId, IResourceBuilder<ParameterResource>? parameter)
    {
        this.chatId = chatId;
        this.parameter = parameter;
    }

    /// <summary>
    /// Локальный запуск: id из настройки, без неё групп бот не обрабатывает.
    /// Форму id проверяет сам бот на старте: AppHost передаёт значение как
    /// есть. Чат — той среды Telegram, в которую ходит запуск: группы одной
    /// среды в другой нет.
    /// </summary>
    public static HubBotCommunityChat? Local(IConfiguration configuration)
    {
        var chatId = configuration[ChatIdKey]?.Trim();
        return string.IsNullOrEmpty(chatId) ? null : new HubBotCommunityChat(chatId, null);
    }

    /// <summary>Чарт: параметр без значения, его заполняют values среды.</summary>
    public static HubBotCommunityChat Published(IDistributedApplicationBuilder builder) =>
        new(null, builder.AddParameter(ChatIdParameter));

    public IResourceBuilder<T> ChatId<T>(IResourceBuilder<T> bot)
        where T : IResourceWithEnvironment =>
        parameter is null
            ? bot.WithEnvironment(Variable, chatId!)
            : bot.WithEnvironment(Variable, parameter);
}
