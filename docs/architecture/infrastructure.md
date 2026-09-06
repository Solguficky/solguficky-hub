# Инфраструктурные контуры и hosting

> **Статус:** Canonical для границы local / production-like / production hosting. Начальная production-площадка выбрана в ADR-034, реализация не завершена.

## Daily local development

.NET Aspire является принятой точкой локальной оркестрации:

- запуск инфраструктуры и нужных сервисов;
- service discovery и конфигурация;
- единый dashboard;
- логи, health и traces;
- возможность не включать компонент в профиль и запустить его из IDE.

Профили `infra` и `identity` подтверждены живым прогоном на Aspire 13.5.3: первый поднимает PostgreSQL и NATS без компонентов, второй доводит Identity до `Healthy` и отвечает на `ResolveIdentity` через proxy endpoint Aspire. Telegram Bot входит в `core` и `full`, но живой прогон профиля с ботом требует токен и ещё не выполнялся. Повторяемый gate описан в [руководстве по локальной разработке](../development/local-development.md). Публичный адрес и туннель локальному запуску не нужны: вход апдейтов — long polling ([ADR-030](../decisions/ADR-030-telegram-bot.md)).

## Production-like integration

k3s предназначен для практики контейнерной оркестрации и проверки production-like deployment. Он не заменяет быстрый inner loop Aspire.

## Production hosting

Начальная площадка — один netcup VPS Lite 3 G12s с 16 GB RAM для dev, agents, test и production. Среды получают разные Unix accounts, rootless container storage, networks, данные, tokens и backup credentials, но общий kernel и operator plane остаются осознанным риском первого этапа. Отдельный production VPS не является обязательным следующим шагом: он вводится при resource contention, росте чувствительности данных, расширении прав агента или необходимости независимого availability/maintenance.

Railway остаётся fallback, если self-hosting окажется непригоден. Домашний мини-ПК не входит в начальный срез.

Выбор площадки и deployability — разные решения. Даже без мини-ПК сервис должен иметь воспроизводимый build, configuration model, migrations, secrets boundary, health checks, backup/restore и deployment artifact.

Production deployment не обязан быть первым milestone; порядок хранится в Linear. Эксплуатационные требования при этом формулируются вместе с сервисами, а не в последнюю неделю перед сходкой.

[ADR-034](../decisions/ADR-034-single-netcup-vps-for-initial-self-hosting.md) заменяет безусловный выбор Railway из ADR-006 и фиксирует цену общего хоста, сигналы пересмотра и переносимость. Требования к deployment, backup и восстановлению уточняет [RFC-007](../rfcs/RFC-007-remote-development-and-self-hosting-platform.md) до реализации PER-80.

## Current-ограничения

- AppHost поднимает PostgreSQL, NATS, Identity и Telegram Bot: в профиле `infra` компоненты платформы выключены, секрет `telegram-bot-token` не объявляется;
- Identity ждёт базу `solguficky`, применяет миграции при старте и получает PostgreSQL URI и динамический gRPC-порт от AppHost;
- Telegram Bot ждёт здоровый Identity и получает его proxy endpoint через `IDENTITY_GRPC_URL`;
- рукописных compose-файлов больше нет, fallback-пути к ним не существует;
- живой прогон профилей `infra` и `identity` подтверждён, но профиль с Telegram Bot, `aspire publish` и production-топология не проверены;
- NATS image закреплён на ветке 2.10, поэтому возможности новых версий нельзя предполагать без upgrade decision.

## Связанные решения

- [ADR-006: Railway hosting](../decisions/ADR-006-railway-hosting.md) — Superseded by ADR-034
- [ADR-034: один netcup VPS для начального self-hosting](../decisions/ADR-034-single-netcup-vps-for-initial-self-hosting.md)
- [ADR-021: Aspire local orchestration](../decisions/ADR-021-aspire-local-orchestration.md)
- [Aspire 13: JavaScript hosting](https://aspire.dev/whats-new/aspire-13/)
