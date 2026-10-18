namespace AppHost.Configuration.Publish;

/// <summary>
/// Адрес OTLP сервиса в чарте (ADR-053, PER-378). Локально переменные
/// <c>OTEL_*</c> подставляет дашборд, а в чарте его нет (<see cref="ClusterEnvironment"/>),
/// и без этого расширения сервис в поде не получает ни адреса, ни имени и
/// экспорт молча выключает.
/// </summary>
internal static class ClusterTelemetry
{
    /// <summary>
    /// Одинаковый у всех сред: <c>otel-collector</c> — Service типа ExternalName в
    /// namespace среды, который ops-репозиторий направляет на порт приёма этой
    /// среды у шлюза Collector. Среду записи Collector определяет по порту, а не
    /// по атрибуту отправителя, поэтому в values ключа нет и пустым его оставить
    /// нельзя: пустой адрес включил бы экспорт Auction без цели.
    /// </summary>
    public const string Endpoint = "http://otel-collector:4317";

    // Identity и бот хаба умеют только gRPC, а autoconfigure Java у Auction без
    // явного протокола выбрал бы http/protobuf на gRPC-порт.
    public const string Protocol = "grpc";

    /// <summary>
    /// Сервис шлёт телеметрию в Collector своей среды. Имя сервиса — имя ресурса,
    /// как локально в дашборде. Бот аукциона расширение не получает: OTLP-экспорта
    /// у него нет, и его логи Collector читает из файлов подов по белому списку
    /// ops-репозитория. Экспорт у бота появится — белый список правится тем же
    /// изменением, иначе логи уйдут дважды.
    /// </summary>
    public static IResourceBuilder<T> ExportsTelemetryToCollector<T>(this IResourceBuilder<T> resource)
        where T : IResourceWithEnvironment =>
        resource
            .WithEnvironment("OTEL_EXPORTER_OTLP_ENDPOINT", Endpoint)
            .WithEnvironment("OTEL_EXPORTER_OTLP_PROTOCOL", Protocol)
            .WithEnvironment("OTEL_SERVICE_NAME", resource.Resource.Name);
}
