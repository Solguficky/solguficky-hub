using Notifications;

var databaseUrl = Environment.GetEnvironmentVariable(Migrations.DatabaseUrlVariable);

if (string.IsNullOrEmpty(databaseUrl))
{
    Console.Error.WriteLine($"{Migrations.DatabaseUrlVariable} is not set");
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

var app = NotificationsHost.Build(args, databaseUrl);
await app.RunAsync();
return 0;
