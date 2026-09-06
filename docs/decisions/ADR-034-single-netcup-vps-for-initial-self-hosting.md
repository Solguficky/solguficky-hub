# ADR-034: Один netcup VPS для начального self-hosting

> **Дата:** 2026-09-06<br>
> **Статус:** Accepted

## Контекст

PER-80 должен перенести удалённую разработку, фоновых coding agents, test и production Solguficky с ноутбука на постоянно работающую площадку. Локальные модели не запускаются, но на хосте одновременно живут удалённая IDE, language servers, контейнеры, сборки Go, TypeScript и .NET/F#, test stack и runtime приложения. Для такого состава 8 GB остаются нижней рабочей границей: один тяжёлый build или второй агент способен вытеснить production в swap или OOM.

Среда разработки исполняет изменяемый код и сторонние package scripts, а production хранит bot token и пользовательские данные. Разные rootless users и контейнеры уменьшают вероятность случайного доступа, но сохраняют общий kernel, operator plane, диск и пределы ресурсов. Отдельный production VPS дал бы более сильную границу, однако увеличил бы стоимость и объём эксплуатации до появления измеренной необходимости.

Предыдущее решение [ADR-006](ADR-006-railway-hosting.md) безусловно выбирало Railway. Оно больше не соответствует цели владельца получить переносимый self-hosting и практику эксплуатации Linux-хоста.

## Варианты

**Один VPS Lite 3 G12s для всех сред.** 16 GB дают запас для одного-двух агентов и MVP runtime; цена — общий failure domain и отсутствие жёсткой границы между недоверенной разработкой и production.

**Отдельные VPS для dev/test и production с первого дня.** Снижает blast radius и конкуренцию за ресурсы, но сразу удваивает host lifecycle и требует второго тарифа до появления нагрузки, подтверждающей необходимость.

**RS с dedicated CPU.** Даёт более стабильную скорость продолжительных сборок и больший SLA, но при сопоставимой памяти стоит дороже; один RS всё равно сохраняет общий kernel и failure domain.

**Railway для production, VPS для разработки.** Уменьшает host operations приложения, но вводит второй deployment и backup contract и возвращает зависимость от PaaS.

**Оставить всё на ноутбуке.** Не обеспечивает работу 24/7, фоновых агентов и независимый production.

## Решение

Начальный self-hosting размещается на одном **netcup VPS Lite 3 G12s**: x86 KVM, 8 shared vCore, 16 GB RAM и 320 GB SSD. Dev, agents, test и production используют один хост, но получают разные Unix accounts, rootless Podman storage, container networks, volumes, bot tokens, databases, age identities и backup credentials. Agent accounts не получают `sudo`, production secrets, deploy credential, host network или container socket. Общие cgroup limits оставляют отдельный запас памяти и CPU production и хосту. Block и inode quotas ограничивают dev/agent/test homes и container storage, а production state получает отдельный bounded filesystem/volume, который эти accounts не могут заполнить.

Общий kernel, operator account, диск и сетевой контур принимаются как остаточный риск начального этапа. Off-provider backup и проверяемое восстановление обязательны с первого production-запуска: snapshot этого VPS не считается независимой копией.

Переезд production на отдельный VPS не является обязательным календарным этапом. Он выполняется по необходимости, если срабатывает сигнал пересмотра. Host baseline, runtime units, secrets policy и restore procedure поэтому с первого дня описываются переносимо и не зависят от netcup-specific deployment API.

Learning goal начального этапа — получить практику безопасного Linux-hosting, воспроизводимого Ansible bootstrap, rootless OCI runtime под systemd, supply-chain verification и восстановления PostgreSQL на чистом хосте. Kubernetes, multi-region failover и собственный PaaS в этот этап не входят.

Fallback при непригодности тарифа или netcup — новый стандартный Linux VPS, восстановленный теми же Ansible, OCI и backup artifacts. Если непригоден сам self-hosting, приложение временно переносится на Railway с сохранением immutable image, secret inventory и проверяемого backup/restore contract; удалённая agent-среда остаётся на VPS либо выключается.

## Обоснование

При отсутствии локальных моделей agent harnesses в основном ждут внешние API; память расходуют language servers, build processes и одновременно запущенные сервисы. 16 GB дают полезный запас по сравнению с выбранным ранее 8 GB VPS и позволяют проверить реальную конкурентность до покупки второй машины. Восемь shared vCore подходят для пиковых сборок, а их нестабильность измеряется через CPU steal и длительность полного gate.

Один хост минимизирует стоимость и число неизвестных в первом эксплуатационном срезе. Переносимая декларация и независимые backups сохраняют путь к двум хостам без преждевременного выполнения миграции. Логическая изоляция не объявляется эквивалентом отдельной VM: это осознанно принятая цена решения.

## Последствия

### Что становится проще

- один host bootstrap, firewall, monitoring и patch/reboot lifecycle;
- 16 GB доступны там, где они нужны в конкретный момент, без раннего разделения capacity;
- dev, test и production можно поднять одним переносимым набором деклараций;
- второй VPS оплачивается и вводится после измеримого сигнала.

### Что становится сложнее

- компрометация kernel или `ops` затрагивает и agents, и production;
- build, test и production конкурируют за CPU, RAM и disk I/O, а block/inode quotas требуют отдельного sizing и наблюдения;
- maintenance или отказ одного VPS одновременно останавливает все контуры;
- изоляцию accounts, secrets, volumes и cgroups нужно проверять отрицательными тестами;
- off-provider backup и recovery escrow критичны уже на первом этапе.

## Предсказание и пересмотр

Ожидается, что 16 GB хватит для MVP runtime, test stack и одного активного тяжёлого agent/build workload без постоянного swap. Первые недели записываются peak RSS, `MemAvailable`, memory pressure, swap activity, OOM events, CPU steal, disk latency и влияние agent jobs на production health.

Production переносится на отдельный VPS, если выполняется хотя бы один из сигналов:

- agent/build workload вызывает OOM, длительный swap, заполнение диска или нарушение production health;
- требуется больше одного одновременно работающего тяжёлого агента, а лимиты делают такую работу неприемлемо медленной;
- объём или чувствительность production-данных делает общий kernel неприемлемым риском для владельца;
- инцидент, уязвимость runtime/kernel или необходимый инструмент требует расширить права агента;
- production требует независимого maintenance window, availability target или capacity;
- стоимость следующего all-in-one тарифа становится невыгоднее отдельного production VPS.

До такого сигнала решение пересматривается после первого restore drill и после двух недель наблюдаемой одновременной нагрузки. Отсутствие сигнала означает, что production остаётся на том же VPS.

## Связанные документы

- RFC: [RFC-007](../rfcs/RFC-007-remote-development-and-self-hosting-platform.md)
- Architecture: [infrastructure.md](../architecture/infrastructure.md)
- Standards: новые нормативы этим ADR не создаются
- Другие ADR: [ADR-006](ADR-006-railway-hosting.md) — заменён этим решением; [ADR-021](ADR-021-aspire-local-orchestration.md) — Aspire остаётся local inner loop
- Linear: [PER-80](https://linear.app/anticnvm/issue/PER-80)
