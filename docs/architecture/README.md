# Architecture

Раздел описывает устройство системы. Нормы реализации находятся в [standards/](../standards/), причины решений — в [decisions/](../decisions/).

- [overview.md](overview.md) — Current / MVP / Future / Legacy и общие границы;
- [first-slice.md](first-slice.md) — состав первого вертикального среза и его явные границы;
- [integration.md](integration.md) — transports, subjects, contract governance и delivery semantics;
- [infrastructure.md](infrastructure.md) — local, production-like и production hosting;
- [technology-selection.md](technology-selection.md) — критерии выбора языков и метод эксперимента;
- [decision-matrix.html](decision-matrix.html) — матрица технических решений по сервисам: множества вариантов, занятые и свободные клетки, обоснования.

Фактическое состояние подтверждается кодом и конфигурацией. Нетривиальные принятые решения закрепляются отдельными ADR.
