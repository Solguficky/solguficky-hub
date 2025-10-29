namespace NotificationsService.Application.Templates;

public static class NotificationTemplates
{
    public static string OutbidNotification(string lotTitle, double yourBid, double newBid)
    {
        return $"❗ Ваша ставка в {yourBid} рублей на лот '{lotTitle}' была перебита. " +
               $"Текущая максимальная ставка теперь составляет {newBid} рублей.";
    }
}

