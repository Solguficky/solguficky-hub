# Инфраструктурные контуры и hosting

> **Статус:** Canonical для границы local / production-like / production hosting. Выбор production-площадки остаётся Open.

## Daily local development

.NET Aspire является принятой точкой локальной оркестрации:

- запуск инфраструктуры и нужных сервисов;
- service discovery и конфигурация;
- единый dashboard;
- логи, health и traces;
- возможность отключить компонент и запустить его из IDE.

Локальные профили `infra` и `full` подтверждены живым прогоном на Aspire 13.5.3: инфраструктурный профиль поднимает PostgreSQL и NATS, полный дополнительно запускает Identity из исходников и проверяет его стандартный gRPC health. Повторяемый gate описан в [руководстве по локальной разработке](../development/local-development.md). Следующие сервисы добавляют свои Aspire-ресурсы в собственных задачах. Публичный адрес и туннель локальному запуску не нужны: вход апдейтов — long polling ([ADR-030](../decisions/ADR-030-telegram-bot.md)).

## Production-like integration

k3s предназначен для практики контейнерной оркестрации и проверки production-like deployment. Он не заменяет быстрый inner loop Aspire.

## Production hosting

Приоритетом является собственно управляемая инфраструктура, но площадка остаётся открытым решением:

- домашний мини-ПК;
- VPS;
- Railway как fallback или быстрый временный deployment.

Выбор площадки и deployability — разные решения. Даже без мини-ПК сервис должен иметь воспроизводимый build, configuration model, migrations, secrets boundary, health checks, backup/restore и deployment artifact.

Production deployment не обязан быть первым milestone; порядок хранится в Linear. Эксплуатационные требования при этом формулируются вместе с сервисами, а не в последнюю неделю перед сходкой.

ADR-006 с безусловным Railway больше не выражает целевую позицию. Заменяющее решение должно отдельно описать:

- требования к hosting;
- критерии выбора площадки;
- deployment model;
- learning goals;
- fallback strategy.

## Current-ограничения

- AppHost поднимает PostgreSQL и NATS, а профили `core` и `full` также запускают Identity из исходников;
- Identity применяет свои миграции при старте и получает PostgreSQL URI и динамический gRPC-порт от AppHost;
- рукописных compose-файлов больше нет, fallback-пути к ним не существует;
- локальные профили `infra` и `full` подтверждены, но `aspire publish` и production-топология не проверены;
- NATS image закреплён на ветке 2.10, поэтому возможности новых версий нельзя предполагать без upgrade decision.

## Связанные решения

- [ADR-006: Railway hosting](../decisions/ADR-006-railway-hosting.md) — Needs review
- [ADR-021: Aspire local orchestration](../decisions/ADR-021-aspire-local-orchestration.md)
- [Aspire 13: JavaScript hosting](https://aspire.dev/whats-new/aspire-13/)
