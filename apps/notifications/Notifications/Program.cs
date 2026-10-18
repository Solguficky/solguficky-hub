using System.Net;
using Notifications;
using Notifications.Reminders;
using Notifications.Transport;

var databaseUrl = Environment.GetEnvironmentVariable(Migrations.DatabaseUrlVariable);

if (string.IsNullOrEmpty(databaseUrl))
{
    Console.Error.WriteLine($"{Migrations.DatabaseUrlVariable} is not set");
    return 1;
}

// Шина обязательна так же, как база: без неё реплика чужих фактов не
// наполняется, и сервис решал бы «кому положено» по пустой реплике, ничего об
// этом не сказав.
var natsUrl = Environment.GetEnvironmentVariable(NotificationsHost.NatsUrlVariable);

if (string.IsNullOrEmpty(natsUrl))
{
    Console.Error.WriteLine($"{NotificationsHost.NatsUrlVariable} is not set");
    return 1;
}

// Пояс сообщества обязателен: в нём реплика хранит расписание, и без него
// момент напоминания не посчитать. Неизвестное имя — тот же отказ старта, а не
// UTC молча.
try
{
    CommunityTime.Parse(Environment.GetEnvironmentVariable(CommunityTime.TimeZoneVariable));
}
catch (InvalidOperationException ex)
{
    Console.Error.WriteLine(ex.Message);
    return 1;
}

// Таблица вызывающих и свой токен (ADR-056). Хост проверяет то же при сборке;
// здесь раньше, до миграций, ради одной строки вместо stack trace.
try
{
    var callers = CallerTable.FromConfiguration(Environment.GetEnvironmentVariable, MethodAccess.Declared);
    ServiceToken.FromConfiguration(Environment.GetEnvironmentVariable, callers);
}
catch (InvalidOperationException ex)
{
    Console.Error.WriteLine(ex.Message);
    return 1;
}

// Под без адреса или идентификаторов среды не стартует с локальными
// умолчаниями: силос объявил бы в membership петлю, а в сменившем его поде
// она указывала бы на другой процесс, и среды делили бы локальный ClusterId.
// Разбор идёт до миграций, чтобы неверно настроенный под не трогал базу.
SiloPlacement placement;

try
{
    placement = SiloPlacement.FromEnvironment(Environment.GetEnvironmentVariable, Dns.GetHostAddresses);
}
catch (InvalidOperationException ex)
{
    Console.Error.WriteLine(ex.Message);
    return 1;
}

// Отказ схемы — рабочий исход старта, а не баг рантайма: оператор должен
// прочитать одну строку про базу, а не stack trace из недр DbUp. Миграции идут
// до силоса намеренно: таблицы membership Orleans заводит этот же DbUp, и без
// них силос не поднимется.
try
{
    Migrations.Apply(databaseUrl);
}
catch (Exception ex)
{
    Console.Error.WriteLine($"{Migrations.DatabaseUrlVariable}: schema migration failed: {ex.Message}");
    return 1;
}

var app = NotificationsHost.Build(args, databaseUrl, natsUrl, placement: placement);
await app.RunAsync();
return 0;
