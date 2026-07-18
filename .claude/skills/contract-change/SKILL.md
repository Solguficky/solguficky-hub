---
name: contract-change
description: Чеклист изменения Protobuf-контрактов (NATS/gRPC) — обновление всех потребителей и документации. Использовать при любом изменении файлов в contracts/proto/.
---

# Изменение контракта (Protobuf)

Контракты в `contracts/proto/` — единственный источник правды (ADR-014, Protobuf-in-Git). Кодогенерация в каждом сервисе на этапе сборки, поэтому изменение `.proto` затрагивает всех потребителей сразу.

## Шаги

1. **Измени `.proto`** в `contracts/proto/{nats/commands|nats/events|grpc|common}/`.
   - Совместимость: не меняй номера полей; не переиспользуй удалённые номера; новые поля — optional/с дефолтом.
   - Именование тем NATS: `<commands|events>.<домен>.<действие>` в snake_case.

2. **Найди всех потребителей** сообщения/темы:
   ```bash
   grep -rn "<ИмяСообщения>\|<тема.в.nats>" services/ tools/ --include="*.rs" --include="*.cs" --include="*.py" -l
   ```
   Карта потребителей по стекам:
   - `telegram-gateway` — prost, регенерация при `cargo build` (см. `build.rs`);
   - `auction-service`, `notifications-service`, `websocket-gateway` — Grpc.Tools/Google.Protobuf, регенерация при `dotnet build`; темы — в `Constants/NatsSubjects.cs` (auction) или конфиге (notifications);
   - `tools/nats-tester` — запусти `python generate_proto.py`, добавь тип в `EVENT_TYPES`/`COMMAND_TYPES` в `cli.py`.

3. **Пересобери и прогони тесты всех затронутых сервисов** — кодогенерация сломает компиляцию там, где контракт разошёлся с кодом. Это фича, а не баг.

4. **Обнови документацию**: `docs/03_CONTRACTS/nats_subjects.md` (новая тема/поля, отправитель, получатели).

5. **Проверка сериализации**: в NATS и gRPC только Protobuf. Если видишь `serde_json`/`JsonSerializer` на пути NATS-сообщения — это баг, чини на Protobuf.

## Анти-паттерны

- Изменить `.proto` и обновить только один сервис («потом дойдут руки») — не дойдут.
- Захардкодить тему строкой в обход констант.
- Добавить breaking change без явного упоминания в описании коммита.
