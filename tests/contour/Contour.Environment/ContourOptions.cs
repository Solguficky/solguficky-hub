namespace Contour.Environment;

/// <summary>
/// Состав контура сверх Identity и Meetups. Аукцион — расширение хаба, а не
/// его часть, поэтому в основной контур он не входит: дымовой набор и провод
/// бота хаба идут без него, и CI не платит за JDK и sbt на каждом прогоне.
/// Auction поднимает только тот, кому он нужен, — пульт провода с ботом
/// аукциона (PER-468), флагом <c>--with-auction</c> у <c>Contour.Host</c>.
/// </summary>
/// <param name="WithAuction">
/// Поднять Auction со своей базой: узел сборки <c>auction-build</c> зовёт
/// <c>just auction-classpath</c>, сервис стартует голой JVM. Нужны JDK версии
/// из <c>apps/auction/.java-version</c> и sbt.
/// </param>
public sealed record ContourOptions(bool WithAuction)
{
    public static ContourOptions Default { get; } = new(WithAuction: false);
}
