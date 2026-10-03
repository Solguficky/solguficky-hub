using Xunit;

namespace AppHost.UnitTests.TestUtilities;

/// <summary>
/// Наборы, которые исполняют entry point настоящего AppHost через Aspire Testing,
/// идут по очереди. Это не фикс гонки снимка: BuildAsync освобождает entry point,
/// и Program.cs продолжает Run параллельно чтению модели. BeforeStartEvent
/// JavaScript-пакета меняет команду installer с node на npm install; общего
/// static-состояния JavaScript для этого не требуется. Снимки используют общий
/// AppHostTopology и Build без Run, поэтому от этой коллекции больше не зависят.
/// </summary>
[CollectionDefinition(Name)]
public sealed class RealAppHostCollection
{
    public const string Name = "real AppHost model";
}
