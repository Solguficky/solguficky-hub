using AppHost.Configuration.Topology;

namespace AppHost.UnitTests.TestUtilities;

internal static class TestMappings
{
    // Наборы владения проверяют локальный запуск; чем узел станет в чарте, им
    // неважно, а отображение — обязательный аргумент регистрации.
    public static readonly PublishMapping LocalOnly = PublishMapping.NotPublished("local-only test node");
}
