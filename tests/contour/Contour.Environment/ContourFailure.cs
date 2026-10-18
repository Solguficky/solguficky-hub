namespace Contour.Environment;

/// <summary>
/// Классы отказа с разными типами. Разделение не косметическое: по типу
/// исключения в логе CI видно, упало из-за среды, из-за узла топологии или
/// из-за самого контракта, и только последнее — дефект изменения.
///
/// Пропуска здесь нет ни в одном виде. Набор запускается отдельным рецептом,
/// то есть запуск уже является согласием, и «тихо пропустить» неправ и локально
/// тоже: зелёный прогон на непройденных тестах выглядит как доказательство.
/// </summary>
public abstract class ContourFailure(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>Нет инструмента или демона: Docker, go, buf. Не дефект изменения.</summary>
public sealed class ContourEnvironmentUnavailable(string message, Exception? inner = null)
    : ContourFailure(message, inner);

/// <summary>
/// Узел топологии упал: `buf generate` или `go build` вернули ненулевой код,
/// сервис не поднялся. Отличается от <see cref="ContourNotReady"/> намеренно:
/// упавший узел и неуспевший узел требуют разных действий, и сваливать первое
/// во второе значит каждый раз искать несуществующую причину в таймаутах.
/// </summary>
public sealed class ContourResourceFailed(string message, Exception? inner = null)
    : ContourFailure(message, inner);

/// <summary>Узел не пришёл в готовность за отведённое время, но и не упал.</summary>
public sealed class ContourNotReady(string message, Exception? inner = null)
    : ContourFailure(message, inner);
