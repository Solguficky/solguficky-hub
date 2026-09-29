# Инфраструктурные контуры и hosting

> **Статус:** Canonical для границы local / production-like / production hosting. Начальная production-площадка выбрана в ADR-039, рантайм — в ADR-055; реализация не завершена.

## Daily local development

.NET Aspire является принятой точкой локальной оркестрации:

- запуск инфраструктуры и нужных сервисов;
- service discovery и конфигурация;
- единый dashboard;
- логи, health и traces;
- возможность не включать компонент в профиль и запустить его из IDE.

Состав подтверждённого живым прогоном ведёт [руководство по локальной разработке](../development/local-development.md), там же повторяемый gate; здесь он не дублируется. Telegram Bot входит в профиль `hub`, и живой прогон профиля с ботом требует токен тестовой среды, поэтому ещё не выполнялся. Публичный адрес и туннель локальному запуску не нужны: вход апдейтов — long polling ([ADR-030](../decisions/ADR-030-telegram-bot.md)).

## Production-like integration

Отдельного production-like слоя нет: test и prod — namespace'ы одного k3s на production-хосте ([ADR-055](../decisions/ADR-055-k3s-runtime-from-aspire-chart.md)), и тестовый контур повторяет прод тем же чартом. Кластер не заменяет быстрый inner loop Aspire: публикация чарта добавляется к локальному запуску, а не вытесняет его.

## Production hosting

Начальная площадка — один Linux VPS для dev, agents, test и production. Полный одновременный срез рассчитан на 16 GB RAM; 8 GB остаются нижней рабочей границей с ужатыми agent/build limits. Dev и coding agents остаются Unix-пользователями хоста вне кластера и без kubeconfig; test и production получают разные namespace'ы k3s с NetworkPolicy default-deny, кластеры CloudNativePG, tokens и backup credentials. Общий kernel, operator plane и containerd от root рядом с агентами остаются осознанным риском первого этапа. Отдельный production VPS не является обязательным следующим шагом: он вводится при resource contention, росте чувствительности данных, расширении прав агента или необходимости независимого availability/maintenance.

Railway остаётся fallback, если self-hosting окажется непригоден. Домашний мини-ПК не входит в начальный срез.

Выбор площадки и deployability — разные решения. Регистратор и тариф выбираются операционно и не фиксируются в архитектуре. Даже без мини-ПК сервис должен иметь воспроизводимый build, configuration model, migrations, secrets boundary, health checks, backup/restore и deployment artifact.

Production deployment не обязан быть первым milestone; порядок хранится в Linear. Эксплуатационные требования при этом формулируются вместе с сервисами, а не в последнюю неделю перед сходкой.

[ADR-039](../decisions/ADR-039-single-vps-for-initial-self-hosting.md) заменяет безусловный выбор Railway из ADR-006 и фиксирует цену общего хоста, сигналы пересмотра и переносимость. Рантайм — k3s на том же хосте: чарт генерируется из графа AppHost в режиме публикации, публикуется в GHCR и доставляется Flux из приватного ops-репозитория; каждый сервис — одна реплика со стратегией `Recreate` ([ADR-055](../decisions/ADR-055-k3s-runtime-from-aspire-chart.md)). Требования к deployment, backup и восстановлению уточняет [RFC-010](../rfcs/RFC-010-remote-development-and-self-hosting-platform.md) до реализации PER-80.

## Current-ограничения

- AppHost поднимает PostgreSQL, NATS, Identity, Meetups, Notifications и Telegram Bot: в профиле `infra` компоненты платформы выключены, секрет `telegram-bot-token` не объявляется;
- Identity, Meetups и Notifications ждут свою базу, применяют миграции при старте и получают строку подключения и динамический gRPC-порт от AppHost;
- Telegram Bot ждёт здоровые Identity и Meetups и получает их proxy endpoints через `IDENTITY_GRPC_URL` и `MEETUPS_GRPC_URL`;
- рукописных compose-файлов больше нет, fallback-пути к ним не существует;
- NATS поднимается в профилях `infra` и `hub` на томе своего рабочего дерева ([local-development.md](../development/local-development.md)), и AppHost на старте создаёт стримы и durable consumers ([каталог](integration.md#jetstream)), но потребителя среди компонентов у шины пока нет: зелёный узел означает работающий брокер со стримами, а не работающую интеграцию;
- тестовая среда Telegram, `aspire publish` и production-топология не проверены; что подтверждено живым прогоном — в [руководстве](../development/local-development.md);
- NATS image закреплён на ветке 2.10, поэтому возможности новых версий нельзя предполагать без upgrade decision.

## Связанные решения

- [ADR-006: Railway hosting](../decisions/ADR-006-railway-hosting.md) — Superseded by ADR-039
- [ADR-039: один Linux VPS для начального self-hosting](../decisions/ADR-039-single-vps-for-initial-self-hosting.md) — рантайм заменён ADR-055
- [ADR-055: рантайм прода — k3s, чарт из графа AppHost](../decisions/ADR-055-k3s-runtime-from-aspire-chart.md)
- [ADR-021: Aspire local orchestration](../decisions/ADR-021-aspire-local-orchestration.md)
- [Aspire 13: JavaScript hosting](https://aspire.dev/whats-new/aspire-13/)
