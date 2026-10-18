using System.Security.Cryptography;
using System.Text;

namespace AppHost.Configuration.Infrastructure;

/// <summary>
/// Имена томов данных — по рабочему дереву, а не константой. Общий том делили
/// бы все деревья: второй PostgreSQL на том же каталоге данных роняет первый
/// (PER-174), а последовательные прогоны из разных веток видят чужую схему
/// и чужую топологию JetStream (PER-7). Том одного дерева переживает рестарт,
/// поэтому повторный запуск оттуда же видит данные прошлого.
/// </summary>
internal static class DataVolumes
{
    private const int TreeNameLength = 32;
    private const int HashLength = 8;

    /// <summary>
    /// <c>solguficky-&lt;каталог дерева&gt;-&lt;хэш пути&gt;-&lt;назначение&gt;</c>.
    /// Имя каталога делает том узнаваемым в <c>docker volume ls</c>, хэш
    /// полного пути различает два клона с одинаковым именем каталога.
    /// </summary>
    public static string Name(IDistributedApplicationBuilder builder, string purpose)
    {
        var root = Path.TrimEndingDirectorySeparator(RepositoryPaths.Root(builder));

        // Регистр пути на Windows не значим: одно дерево, открытое как `C:\...`
        // и как `c:\...`, должно получить тот же том, а не пустой новый.
        var key = OperatingSystem.IsWindows() ? root.ToLowerInvariant() : root;
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..HashLength];

        return $"solguficky-{Slug(Path.GetFileName(root))}-{hash}-{purpose}";
    }

    // Docker принимает в имени тома [a-zA-Z0-9_.-]; всё прочее схлопывается
    // в дефис, чтобы кириллица или пробел в имени каталога не уронили запуск.
    private static string Slug(string treeName)
    {
        var slug = new StringBuilder(treeName.Length);
        foreach (var symbol in treeName.ToLowerInvariant())
        {
            var allowed = char.IsAsciiLetterOrDigit(symbol) || symbol is '_' or '.';
            if (allowed)
            {
                slug.Append(symbol);
            }
            else if (slug.Length > 0 && slug[^1] != '-')
            {
                slug.Append('-');
            }
        }

        var trimmed = slug.ToString().Trim('-', '.', '_');
        trimmed = trimmed.Length > TreeNameLength ? trimmed[..TreeNameLength].TrimEnd('-', '.', '_') : trimmed;
        return trimmed.Length > 0 ? trimmed : "tree";
    }
}
