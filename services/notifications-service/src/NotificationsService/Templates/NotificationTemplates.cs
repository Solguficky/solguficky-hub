namespace NotificationsService.Templates;

public static class NotificationTemplates
{
    public const string DefaultParseMode = "";

    public static string OutbidNotification(string lotTitle, double yourBid, double newBid)
    {
        return $"❗ Ваша ставка в {yourBid} рублей на лот '{lotTitle}' была перебита. " +
               $"Текущая максимальная ставка теперь составляет {newBid} рублей.";
    }
}

