namespace NotificationsService.Attributes;

[AttributeUsage(AttributeTargets.Class)]
public class HandlesSubjectAttribute(string subject) : Attribute
{
    public string Subject { get; } = subject;
}

