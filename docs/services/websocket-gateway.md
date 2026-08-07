# WebSocket Gateway

> **Слой:** Legacy / Frozen. **Stack:** C# + SignalR. **MVP:** не требуется.

Сервис подписан на аукционный namespace, содержательно преобразует `bid_placed` и публикует его в `auction:live` через SignalR.

Пока он остаётся в active tree:

- код должен собираться в CI;
- новые продуктовые сценарии в него не добавляются без отдельного решения;
- текущая topology не считается обязательной для auction v2;
- удаление координируется с Auction Service, proto и consumers.

Исключить оставленный код из CI означает превратить заморозку в незаметное разрушение. Решение о дальнейшей судьбе принимается вместе с выводом аукционной ветки.

## Свидетельства

- Current implementation: `services/websocket-gateway/src/WebSocketGateway/Services/`
- Current integration catalog: [integration.md](../architecture/integration.md)
- Historical design: [websocket-gateway-auction-design.md](../archive/services/websocket-gateway-auction-design.md)
