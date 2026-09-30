using Xunit;

namespace AppHost.UnitTests.TestUtilities;

/// <summary>
/// Наборы, которые строят модель настоящего AppHost, идут по очереди. Две такие
/// модели, собранные в одном процессе параллельно, делят состояние пакета
/// JavaScript: узел <c>telegram-bot-installer</c> в снимке <c>hub</c> тогда
/// получает то <c>node</c>, то <c>npm install</c>, и снимок краснеет без
/// изменения графа. Воспроизводилось на снимке, публикации и токенах вызывающих
/// вместе и пропадало при последовательном запуске.
/// </summary>
[CollectionDefinition(Name)]
public sealed class RealAppHostCollection
{
    public const string Name = "real AppHost model";
}
