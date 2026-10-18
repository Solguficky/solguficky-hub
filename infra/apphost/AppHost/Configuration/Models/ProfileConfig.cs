namespace AppHost.Configuration.Models;

/// <summary>
/// Профиль — данные, а не код: он перечисляет узлы, которыми AppHost владеет
/// в этом запуске. Чего нет в списке, граф не материализует, и компонент
/// остаётся владельцу: он запускает его сам и читает собственный конфиг.
/// </summary>
internal sealed class ProfileConfig
{
    public string Name { get; set; } = string.Empty;
    public List<string> Services { get; set; } = [];
    public List<string> Infrastructure { get; set; } = [];

    public bool OwnsService(string name) =>
        Services.Contains(name, StringComparer.OrdinalIgnoreCase);

    public bool OwnsInfrastructure(string name) =>
        Infrastructure.Contains(name, StringComparer.OrdinalIgnoreCase);
}
