# Telegram Mini App

> **Слой:** MVP, scope Open. **Стек:** TypeScript-клиент вероятен; framework и backend boundary не выбраны.

Mini App вводится только для сценариев, которые неудобно или невозможно качественно реализовать в интерфейсе бота.

До выбора framework необходимо определить:

- пользователя и задачу каждого экрана;
- какие действия действительно неудобны в боте;
- состояния загрузки, ошибки и отсутствия данных;
- операции с elevated permissions;
- данные, доступные браузеру;
- backend boundary;
- server-side проверку Telegram `initData`.

TypeScript является естественным языком клиента. Из этого не следует автоматический выбор React, Vue или Svelte и не следует прямой доступ браузера к внутренним сервисам.

С новым Telegram Gateway допустим общий presentation package, описанный в [service brief Gateway](telegram-gateway.md). Домен Meetups и авторизация не должны переезжать в этот package.

## Следующая работа

1. Утвердить сценарии и первые макеты.
2. Определить необходимость Mini App в MVP.
3. Выбрать browser/backend transport.
4. Только затем принять решение о framework и структуре workspace.

## Связанные материалы

- [Текущая дизайн-заготовка](../design/mini-app/README.md)
- [Telegram Mini Apps](https://core.telegram.org/bots/webapps)
- [gRPC-Web](https://grpc.io/docs/platforms/web/basics/)
- [Connect](https://connectrpc.com/)
