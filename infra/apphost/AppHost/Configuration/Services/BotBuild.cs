using Aspire.Hosting.JavaScript;

namespace AppHost.Configuration.Services;

/// <summary>
/// Сборка пакета ботов: один пакет <c>apps/hub-bot</c> — два процесса,
/// поверхность хаба и поверхность аукциона (ADR-064, п. 18). Установка
/// зависимостей, кодогенерация и <c>tsc</c> идут одним ресурсом на граф, а оба
/// узла ждут его завершения и стартуют собранным <c>dist</c>. Два
/// <c>npm start</c> в одном каталоге собирали бы одно дерево наперегонки:
/// кодогенерация с <c>clean: true</c> стирала бы <c>gen/</c> под компиляцией
/// соседа.
/// </summary>
internal static class BotBuild
{
    public const string Name = "bot-build";

    /// <summary>
    /// Ресурс сборки графа: первый узел бота заводит его, второй берёт тот же.
    /// Узел без второго бота в профиле получает сборку так же — профиль
    /// <c>auction-bot</c> не требует узла хаба.
    /// </summary>
    public static IResourceBuilder<JavaScriptAppResource> For(IDistributedApplicationBuilder builder)
    {
        var existing = builder.Resources
            .OfType<JavaScriptAppResource>()
            .SingleOrDefault(resource => resource.Name == Name);

        // `prestart` пакета — та же сборка, что и перед ручным `npm start`.
        return existing is null
            ? builder.AddJavaScriptApp(Name, RepositoryPaths.App(builder, "hub-bot"), "prestart")
            : builder.CreateResourceBuilder(existing);
    }

    /// <summary>
    /// Процесс одной поверхности: собранный <c>dist</c> пакета под
    /// <c>node</c>; поверхность ставит узел переменной <c>BOT_SURFACE</c>.
    /// OTLP-переменные исполняемый файл получает только аннотацией
    /// (OtlpExportTests).
    /// </summary>
    public static IResourceBuilder<ExecutableResource> Process(
        IDistributedApplicationBuilder builder,
        string name) =>
        builder
            .AddExecutable(name, "node", RepositoryPaths.App(builder, "hub-bot"), "dist/src/main.js")
            .WithOtlpExporter()
            .WaitForCompletion(For(builder));
}
