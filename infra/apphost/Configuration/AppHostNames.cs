namespace AppHost.Configuration;

/// <summary>
/// Одно логическое имя на узел: константа, имя ресурса Aspire, ключ профиля,
/// аргумент `aspire wait` и имя в документации — одна и та же строка.
/// </summary>
public static class AppHostNames
{
    public static class Resources
    {
        public const string Postgres = "postgres";
        public const string SolgufickyDb = "solguficky";
        public const string Nats = "nats";

        public const string Identity = "identity";
        public const string TelegramBot = "telegram-bot";
    }
}
