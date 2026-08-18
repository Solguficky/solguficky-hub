# Инфраструктурные контуры и hosting

> **Статус:** Canonical для границы local / production-like / production hosting. Выбор production-площадки остаётся Open.

## Daily local development

Aspire с TypeScript AppHost является принятой точкой локальной оркестрации:

- запуск инфраструктуры и нужных сервисов;
- service discovery и конфигурация;
- единый dashboard;
- логи, health и traces;
- возможность отключить компонент и запустить его из IDE.

TypeScript AppHost существует рядом с временным C# fallback, но полный живой запуск ещё не подтверждён. Поэтому следующий инфраструктурный gate — выполнить smoke test, описанный в [руководстве по локальной разработке](../development/local-development.md), и только затем удалить fallback и адаптировать topology под новый TypeScript Gateway и MVP-сервисы.

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

- профиль Aspire `core` пока поднимает Legacy Auction и Rust Gateway;
- Gateway запускается через Cargo;
- прежний C# AppHost временно остаётся рядом с каноническим TypeScript AppHost до миграционного gate;
- рукописные compose-файлы остаются fallback до подтверждения Aspire;
- NATS image закреплён на ветке 2.10, поэтому возможности новых версий нельзя предполагать без upgrade decision.

## Связанные решения

- [ADR-006: Railway hosting](../decisions/ADR-006-railway-hosting.md) — Needs review
- [ADR-021: Aspire local orchestration](../decisions/ADR-021-aspire-local-orchestration.md)
- [ADR-024: TypeScript для Aspire AppHost](../decisions/ADR-024-typescript-aspire-apphost.md)
- [Aspire 13: JavaScript hosting](https://aspire.dev/whats-new/aspire-13/)
