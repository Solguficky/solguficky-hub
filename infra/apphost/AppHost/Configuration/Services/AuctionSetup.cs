using AppHost.Configuration.Extensions;
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Services;

internal static class AuctionSetup
{
    public static IResourceBuilder<ExecutableResource> Configure(ServiceGraphContext context)
    {
        var repositoryRoot = RepositoryPaths.Root(context.Builder);
        var auctionPath = RepositoryPaths.App(context.Builder, "auction");
        var classpathFile = Path.Combine(auctionPath, "target", "aspire-classpath");

        // Auction запускается голой JVM, а не `sbt run`: при `run / fork := true`
        // DCP останавливает sbt, а форкнутая JVM его переживает с занятым портом —
        // та же ловушка, что `go run` у Identity. Поэтому sbt только компилирует
        // и записывает runtime classpath в target/, а сервис стартует отдельным
        // процессом `java`, которому и приходит сигнал остановки.
        //
        // sbt зовётся через рецепт, а не напрямую: на Windows это sbt.bat, и
        // cmd.exe ломает выражение `set` — проверено живым прогоном. Classpath
        // пишется голым списком путей и уходит сервису переменной CLASSPATH,
        // поэтому ни кавычек, ни экранирования путей с пробелами не требуется.
        var build = context.Builder
            .AddExecutable("auction-build", "just", repositoryRoot, "auction-classpath");

        var auction = context.Builder
            .AddExecutable(AppHostNames.Resources.Auction, "java", auctionPath, "auction.Main")
            .WithHttpEndpoint(name: AppHostNames.Endpoints.Http, env: "AUCTION_HTTP_PORT")
            .WaitForCompletion(build)
            // Callback вычисляется при старте ресурса, то есть уже после сборки:
            // файл classpath к этому моменту записан текущим вызовом sbt.
            .WithEnvironment(environment =>
                environment.EnvironmentVariables["CLASSPATH"] = ReadClasspath(classpathFile))
            .WithHttpHealthCheck("/health", endpointName: AppHostNames.Endpoints.Http);

        // Pekko Persistence JDBC настраивается как Slick: URL без учётных данных,
        // пользователь и пароль отдельно. Поэтому ключей три, и формат URL — JDBC,
        // а не URI, как у Identity. Читать их сервис начнёт в PER-302; до тех пор
        // они приходят заранее и ничего не меняют.
        auction
            .BindConnection<ExecutableResource, PostgresDatabaseResource>(
                context,
                AppHostNames.Resources.AuctionDb,
                "AUCTION_DATABASE_JDBC_URL",
                database => ReferenceExpression.Create($"{database.Resource.JdbcConnectionString}"))
            .BindConnection<ExecutableResource, PostgresDatabaseResource>(
                context,
                AppHostNames.Resources.AuctionDb,
                "AUCTION_DATABASE_USER",
                database => ReferenceExpression.Create($"{database.Resource.Parent.UserNameReference}"))
            .BindConnection<ExecutableResource, PostgresDatabaseResource>(
                context,
                AppHostNames.Resources.AuctionDb,
                "AUCTION_DATABASE_PASSWORD",
                database => ReferenceExpression.Create($"{database.Resource.Parent.PasswordParameter}"));

        build.WithParentRelationship(auction);

        return auction;
    }

    // Рестарт одного `auction` узел сборки не повторяет: после `sbt clean` файла
    // уже нет, и голый FileNotFoundException из недр AppHost не говорит, что
    // делать. Текст по-английски: он уходит в лог через Aspire CLI.
    private static string ReadClasspath(string classpathFile) =>
        File.Exists(classpathFile)
            ? File.ReadAllText(classpathFile).Trim()
            : throw new InvalidOperationException(
                $"Auction classpath file '{classpathFile}' is missing. Restart 'auction-build' before 'auction', "
                    + "or run 'just auction-classpath'.");
}
