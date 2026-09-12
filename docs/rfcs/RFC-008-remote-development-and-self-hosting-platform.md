# RFC-008: Удалённая среда разработки и self-hosting Solguficky

> **Статус:** In Review; hosting model принят в ADR-035  
> **Автор:** Dmitriy Panfilyonok  
> **Дата:** 2026-09-06

## Кратко

PER-80 должен дать две постоянно работающие возможности: удалённую среду разработки с coding agents и воспроизводимый запуск Solguficky в test и production без зависимости от ноутбука. Эти нагрузки имеют противоположный профиль доверия. Среда разработки исполняет изменяемый код, package scripts, плагины и агентские команды; production хранит токен бота и пользовательские данные. Rootless-контейнеры разделяют пользователей и процессы, но используют ядро одного хоста, поэтому не образуют жёсткую границу между недоверенной разработкой и production ([Podman rootless](https://docs.podman.io/en/stable/markdown/podman.1.html), [границы namespaces](https://docs.kernel.org/admin-guide/namespaces/resource-control.html)).

Начальный этап принят в [ADR-035](../decisions/ADR-035-single-vps-for-initial-self-hosting.md):

- один Linux VPS размещает remote development, project-scoped coding agents, test и production;
- хост — x86-64 KVM с Debian stable, user namespaces, cgroup v2 и rootless Podman; полный одновременный срез рассчитан на 16 GB RAM, 8 GB — нижняя рабочая граница с ужатыми agent/build limits;
- dev/agents, test и production получают разные Unix-аккаунты, rootless container storage, сети, базы, bot tokens, age recipients, backup credentials и resource limits;
- хосты восстанавливаются Ansible-сценарием, приложения запускаются rootless Podman Quadlet, версии приложений поставляются из CI по digest;
- PostgreSQL получает off-host pgBackRest repository с continuous WAL archiving и проверяемым PITR, остальные незаменимые файлы — отдельный restic repository;
- штатный и ручной redeploy используют один узкий deploy-контракт: `environment + OCI digest`, обязательную проверку подписи и один и тот же health gate.

Один VPS сознательно принят для старта. Отдельные Unix-пользователи и rootless Podman ограничивают обычные ошибки, но компрометация ядра, `ops` или конфигурации хоста открывает и dev, и production. Это остаточный риск, а не обещание жёсткой изоляции. Переезд production на отдельный хост выполняется только по сигналам ADR-035, а не как обязательный пятый этап.

## Проблема и границы

### Что вынуждает решать сейчас

Результат PER-80 сформулирован проверяемо:

- бот работает на арендованном сервере при выключенном ноутбуке;
- релиз собирается и доставляется из CI;
- test отделён от production по данным, секретам и экземпляру бота;
- база восстанавливается из off-host backup;
- известный исправный релиз можно вручную развернуть с локальной машины;
- удалённая dev-среда и фоновые coding agents работают 24/7, не получают production-секретов и не конфликтуют зависимостями разных проектов.

Сейчас репозиторий этого не обеспечивает. [Aspire-граф](../development/local-development.md) предназначен для local orchestration, утверждённых Dockerfile/Containerfile нет, production deployment не проверен. Текущий успешный local run не доказывает deployability; это уже отмечено в [infrastructure.md](../architecture/infrastructure.md).

Выбор регистратора и тарифа нельзя смешивать с устройством deployment. Хост должен удовлетворять техническим требованиям ниже; Ansible, Quadlet и backup не зависят от API провайдера. Конкретный биллинг, KYC и ассортимент тарифов в этот RFC не входят.

### В границах

- технические требования к хосту: CPU, RAM, диск, виртуализация, console/rescue, сеть и переносимость;
- воспроизводимый host baseline: ОС, SSH, firewall, обновления, пользователи, аудит и resource limits;
- удалённая разработка и фоновые агенты без локальных моделей;
- изоляция зависимостей и credentials разных проектов;
- разделение test и production;
- OCI build, supply-chain controls, CI release и ручной redeploy;
- управление секретами;
- резервное копирование, проверка восстановления и перенос на другой хостинг;
- целевые RPO/RTO и runbooks.

### Вне границ

- k3s и обучение Kubernetes. Генерация deployment-артефактов из Aspire остаётся направлением после MVP: Quadlet и k3s потребляют одни и те же OCI images, поэтому первый срез на Quadlet этот путь не закрывает, а точка пересмотра — после запуска боевого poller;
- публичный домен, TLS и reverse proxy: Telegram-бот использует long polling, публичный ingress не нужен;
- перенос local orchestration с Aspire: Aspire остаётся единственным local inner loop;
- Auction и другие компоненты вне MVP;
- замена будущего домашнего mini-PC: описанные артефакты должны одинаково развернуть VPS, другой хостинг или локальную Linux-машину;
- выбор конкретного AI-провайдера, агента, harness или IDE;
- полноценная observability-платформа и disaster recovery между регионами.

PER-99 уже исследует площадку для long-lived agent process, PER-133 — декларацию agent environment, PER-138 — Codex Cloud. PER-97 задаёт полномочия оркестратора и не блокирует инфраструктурную границу. Перед созданием новых задач их нужно сверить с этим RFC: PER-80 владеет host/security/deploy/backup-контуром, а существующие задачи должны поставлять ему требования или реализацию своей узкой части.

## Сценарии и требования

### Сценарии

1. Владелец подключается по SSH из Windows/Linux, открывает репозиторий в привычном редакторе и запускает проект в описанном репозиторием dev container.
2. Фоновый агент продолжает разрешённую задачу после разрыва SSH, но ограничен проектом, CPU/RAM/PIDs и набором credentials.
3. Package manager или `postinstall` одного проекта оказывается вредоносным. Он не читает данные другого проекта и production, не управляет контейнерами другого пользователя и не получает операторский SSH-ключ.
4. Merge в `develop` собирает immutable OCI images, создаёт SBOM/provenance, подписывает digest и разворачивает test.
5. Production deploy требует отдельного GitHub Environment approval и разворачивает тот же проверенный digest, без повторной сборки.
6. CI недоступен, но GHCR доступен. Владелец с ноутбука повторно разворачивает известный подписанный digest той же командой и с тем же gate.
7. VPS потерян. На чистом сервере host baseline применяется из Git, база восстанавливается до выбранной точки, файлы — из restic, после чего запускается ровно один production bot.
8. При плановой миграции новый сервер готовится параллельно, получает base backup и WAL, а запись останавливается только на финальное переключение.

### SLO восстановления

Это цели, которые становятся обещанием только после измеренного restore drill:

| Состояние | Целевой RPO | Целевой RTO | Механизм |
|---|---:|---:|---|
| PostgreSQL, авария хоста | не более 5 минут | не более 2 часов | pgBackRest base backups + continuous WAL archive |
| PostgreSQL, плановая миграция | 0 подтверждённых транзакций | не более 15 минут остановки записи | финальный WAL switch и ожидание архива перед запуском цели |
| Файлы приложений | не более 1 часа | не более 2 часов | restic по systemd timer |
| Dev/agent workspace | не более 1 часа для незакоммиченного | не более 4 часов | Git checkpoints + restic; caches восстанавливаются сборкой |
| Host и deploy-конфигурация | 0 для закоммиченного | входит в RTO хоста | Ansible, Quadlet и SOPS ciphertext в Git |

`archive_timeout` заставляет PostgreSQL переключить неполный WAL segment, но не гарантирует его успешную запись вне хоста; слишком малое значение также раздувает архив. PostgreSQL рекомендует выбирать его осознанно ([Continuous Archiving](https://www.postgresql.org/docs/current/continuous-archiving.html)). RPO 5 минут считается от последнего успешно принятого repository WAL. `archive_timeout` оставляется меньше этого окна, чтобы оставался бюджет на доставку в repository. `archive-async` не включается, пока нет alert по этой метрике.

### Критерии хоста

Хост проверяется по этим требованиям, а не по имени провайдера:

| Критерий | Минимум для PER-80 |
|---|---|
| CPU/RAM | x86-64; полный срез рассчитан на 16 GB RAM; 8 GB допустимы только с ужатыми agent/build ceilings, чтобы reservation production и хоста сохранилась; конкурентность подтверждается замером steal, latency и OOM |
| Disk | SSD или NVMe; места хватает на две рабочие копии, image cache и backup staging; alert до 80% |
| Virtualization | разрешены user namespaces, cgroup v2 и rootless Podman |
| Console | независимая от SSH console или rescue, достаточная чтобы восстановить доступ при сломанном `sshd` |
| Network | стабильный public IPv4, исходящий доступ к GitHub, GHCR, AI APIs и backup storage; входящий контур кроме SSH закрыт |
| Portability | стандартный Debian stable; source of truth — Ansible/Quadlet в Git, а не панель или API провайдера |
| Backup | S3-compatible repository вне этого хоста и с отдельными credentials; snapshot провайдера не считается единственной копией |
| Disk layout | раскладка задаётся при установке ОС, а не переразбивается на живом хосте; весь выделенный диск используется; production state — отдельный bounded volume; для dev/agent/test включены block и inode quotas |
| Provisioning | панель умеет переустановку ОС с выбранной раскладкой и LVM: хост после spike пересоздаётся начисто, а не дочищается |

## Модель угроз

| Актив или граница | Угроза | Контроль | Остаточный риск |
|---|---|---|---|
| Production data и bot token | агент, dependency script или украденный dev token читает production | отдельные Unix accounts, rootless storage, credentials и age identity; production не монтирует source tree; agent не получает deploy access | общий kernel и `ops` сохраняют путь к production при host compromise |
| Host | подбор SSH, украденный пароль, открытый сервис | key-only SSH, `PermitRootLogin no`, provider + nftables firewall, только SSH ingress | кража разрешённого private key, уязвимость OpenSSH |
| Проекты на общем host | package script читает соседние проекты | отдельный Unix user на проект/доверительную группу, rootless Podman storage, отдельные tokens | общий kernel и operator account |
| Container boundary | container escape или доступ к container socket | rootless mode, no socket mount, drop capabilities, no-new-privileges, read-only rootfs где возможно | kernel/user-namespace vulnerability |
| CI | вредоносный action/PR крадёт deploy secret | GitHub-hosted runners, full-SHA actions, least-privilege token, no secrets for fork PR, protected environments | компрометация GitHub account/action SHA owner |
| Artifact | подмена tag/image в registry | deploy only by digest, verify Cosign identity and provenance, retain SBOM | подписанный, но уязвимый код всё ещё возможен |
| Secrets in Git/backup/logs | случайная публикация или вывод | SOPS+age ciphertext, secret scanning, stdin/files instead of CLI arguments, log redaction | агент может отправить секрет, который ему разрешили читать |
| Backup | ransomware удаляет primary и repository | off-provider encrypted repo, append-only writer, separate prune credential, object versioning/lock if available | потеря recovery key или compromise maintenance credential |
| Restore | backup есть, но несовместим или повреждён | monthly isolated restore, quarterly migration drill, recorded duration/checks | неиспытанный новый schema/version gap |
| AI provider | source/context покидает VPS через разрешённый API | data classification, approved providers, project-scoped workspace, no production data/secrets | сама удалённая модель по определению получает отправленный контекст |

Последнюю строку нельзя закрыть firewall. Для hosted coding agents обещание «данные никогда не покидают сервер» ложно: инструмент отправляет выбранный контекст модели. До эксплуатации владелец должен утвердить допустимых провайдеров, репозитории и классы данных. Production data и production secrets агентам не выдаются ни при каком провайдере.

## Варианты

### Вариант A: один Linux VPS для dev, agents, test и production

Плюсы: один host lifecycle, общая ёмкость без преждевременного разделения, простое начало. Минусы: общий kernel и operator plane; вредоносная dependency или агент увеличивает blast radius до production; сборка конкурирует с PostgreSQL и ботом; host maintenance одновременно останавливает всё. Отдельные rootless users полезны, но не исправляют общую доверительную границу.

**Вывод:** выбран для начального self-hosting в ADR-035 с явным остаточным риском и измеримыми сигналами выноса production.

### Вариант B: dev/test и production на отдельных VPS

Плюсы: production не делит kernel, filesystem, Podman daemon и operator tokens с недоверенными build/agent workloads; test остаётся близким к dev; отказ dev host не останавливает бота. Минусы: второй хост, два host lifecycle, раздельное наблюдение и backup.

**Вывод:** следующий вариант при срабатывании сигнала ADR-035, но не обязательный календарный этап.

### Вариант C: отдельные dev, test и production hosts

Плюсы: test лучше моделирует production и не зависит от agent load; самая ясная сеть и capacity. Минусы: три host lifecycle и операционная нагрузка преждевременны для текущего состояния продукта.

**Вывод:** путь масштабирования после измерений, а не старт PER-80.

### Вариант D: managed PaaS для приложения, VPS только для agents

Плюсы: меньше host operations для production. Минусы: иные secret/deploy/backup contracts, возможный vendor lock-in и необходимость отдельно проверить PostgreSQL PITR и ручной redeploy. [ADR-006](../decisions/ADR-006-railway-hosting.md) заменён ADR-035 и больше не подтверждает этот вариант.

**Вывод:** сохраняется как альтернатива при пересмотре hosting ADR.

### Ничего не менять

Бот и агенты зависят от ноутбука, restore path отсутствует, а production deployment остаётся недоказанным. Критерии PER-80 не выполняются.

## Предложение

### Целевая схема

```mermaid
flowchart LR
    Laptop[Ноутбук владельца] -->|SSH key only| Host[Linux VPS<br/>x86-64, 8–16 GB]
    Host --> Dev[Dev projects<br/>rootless containers]
    Host --> Agents[Project-scoped agents<br/>systemd user services]
    Host --> Test[Test account<br/>own data and bot token]
    Host --> Prod[Production account<br/>runtime only]

    CI[GitHub-hosted Actions] -->|OCI by digest<br/>SBOM + provenance + signature| Registry[GHCR]
    Registry -->|verified pull| Test
    Registry -->|verified pull| Prod
    CI -->|restricted deploy command| Test
    CI -->|protected environment<br/>restricted deploy command| Prod
    Laptop -->|same deploy contract| Prod

    Test -->|pgBackRest + restic| TestBackup[Off-host test repository]
    Prod -->|pgBackRest + restic| ProdBackup[Off-provider production repository]
    Prod -->|long polling, outbound only| Telegram[Telegram Bot API]
```

Публичный ingress приложения отсутствует. PostgreSQL, Identity gRPC, NATS при его появлении и любые dashboard ports слушают только loopback или внутреннюю container network. Для временного доступа используется SSH port forwarding. Из входящих сервисов снаружи открыт только SSH. Host firewall — default deny. Если у провайдера есть отдельный firewall, он закрывает всё, кроме SSH, ICMP/ICMPv6 и ответов необходимых UDP-endpoint (DNS, NTP): stateful tracking часто покрывает только TCP. До применения внешнего правила сохраняется console/rescue access; IPv4 и IPv6 проверяются отдельно.

### Доверительные зоны и аккаунты

| Account/zone | Где | Имеет | Не имеет |
|---|---|---|---|
| `ops` | общий хост | SSH, ограниченный sudo, host maintenance | agent/provider tokens, ежедневная разработка |
| `dev-<project>` | общий хост | свой home, rootless Podman, repo-scoped source/token | соседние homes, sudo, production secrets |
| `agent-<project>` | общий хост | только нужный workspace, harness и provider token | SSH login, production/test deploy credential, host Podman socket |
| `solguficky-test` | общий хост | test images, network, volumes, test bot token | production database/token/repository |
| `solguficky-prod` | общий хост | только runtime images, production network/volumes/secrets | compilers, source tree, dev tokens, interactive SSH |
| `deploy-test` / `deploy-prod` | общий хост | forced command с environment и digest | shell, arbitrary image/tag, чтение secrets |

Rootless Podman хранит containers и images раздельно для каждого пользователя и использует user namespace; контейнеры одного непривилегированного пользователя не видны другому через его Podman ([Podman](https://docs.podman.io/en/stable/markdown/podman.1.html)). Socket не монтируется в agent containers: доступ к нему равен управлению всеми контейнерами и mounts данного project account.

### Host baseline

Host source of truth — отдельный private operations repository: Ansible playbook и inventory, Quadlet units, deploy/backup scripts и SOPS policy. В публичный репозиторий приложения это не кладётся. Inventory не хранит plaintext secrets. Ansible использует идемпотентные modules и check mode, поэтому тот же сценарий применим к любому Linux VPS и локальной Linux-машине ([Ansible playbooks](https://docs.ansible.com/projects/ansible-core/devel/playbook_guide/playbooks_intro.html)). Пока хост один, декларация — один playbook и файлы `tasks/`; roles и Galaxy-зависимости не вводятся.

Control node — Linux или WSL2 на машине владельца, не Windows и не сам управляемый хост: Ansible не поддерживает Windows в роли control node, а control node на целевой машине лишает `--check` смысла и делает bootstrap зависимым от того, что на хосте уже установлено. Тем же ограничением связан любой заменитель Ansible: WSL здесь плата за POSIX-инструментарий, а не за конкретный инструмент. Изменение host state вручную допустимо только для восстановления доступа и в том же срезе переносится в декларацию.

Порядок важнее набора пакетов. Следующий этап не начинается, пока не зелёный gate текущего. Первая реализация сознательно проще целевой схемы: цель — не потерять доступ и не положить незаменимые данные на хост, который ещё нельзя восстановить.

**До создания сервера.** Защитить аккаунт провайдера и GitHub отдельными passphrase и MFA. Сгенерировать SSH-ключ только для этого хоста: не ключ GitHub и не forwarded agent. Записать console/rescue procedure вне VPS. Выбрать object storage в другом provider/account, чем VPS: объектное хранилище того же регистратора не разделяет failure domain и не считается off-provider копией. Выбрать место escrow для age/restic до появления первого секрета.

**Не потерять доступ.** Установить минимальный Debian stable — хост, на котором уже выполнялся spike, переустанавливается начисто и с целевой раскладкой диска: spike по определению оставляет на машине то, чего нет в декларации. Debian 13 — текущая stable ветка ([stable release](https://www.debian.org/releases/stable/), [security information](https://www.debian.org/security/)). Создать `ops`, поставить его public key, открыть вторую SSH-сессию и войти в provider console/rescue на этом же хосте — не по документации, а фактом входа. Только после обоих входов отключить root и password login. Проверить `sshd -t` и reload без обрыва текущей сессии. Базовый policy на этом шаге пускает только `ops`:

```text
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers ops
```

`dev-*` и `deploy-*` добавляются в `AllowUsers`, когда эти пользователи уже созданы и их ключ проверен второй сессией. Dedicated `agent-*` в список не входят. Если агент живёт user service того же `dev-<project>`, SSH принадлежит developer-аккаунту; какой вариант выбран — открытый вопрос 3. Семантика директив — [sshd_config](https://man.openbsd.org/sshd_config). Deploy keys позже получают `restrict` и root-owned forced command. Высокоценный локальный SSH agent на VPS не пересылается ([ForwardAgent](https://man.openbsd.org/ssh_config#ForwardAgent)).

Провайдерский firewall, который режет всё кроме SSH, применяется только при уже проверенном console/rescue. Host firewall первого среза — `ufw`: он пишет те же nftables-правила, по умолчанию даёт deny incoming и allow outgoing, сам обрабатывает established/related и ICMP и покрывает IPv6 одной настройкой. Ручной nftables ruleset остаётся целью для более сложной топологии; на первом хосте его выигрыш не окупает риск отрезать себе доступ опечаткой. Открыт только SSH; IPv4 и IPv6 проверяются отдельно, включая ответы DNS/NTP, если у панели провайдера нет UDP state tracking. Порты PostgreSQL, gRPC, NATS и dashboard не публикуются.

**Сделать хост воспроизводимым.** Ручные шаги доступа переносятся в Ansible до production-данных. Разметка диска в этот перенос не входит: переразметка корневого диска playbook так же фатальна, как интерактивным `fdisk`, — модуль делает операцию не безопасной, а воспроизводимо фатальной. Раскладка выбирается при установке или переустановке ОС из панели: LVM с отдельными logical volumes под `/home` и под production state, headroom системному разделу. Playbook раскладку не создаёт, а проверяет assertions — ожидаемый volume смонтирован, размер не меньше расчётного, нужные опции в mount options — и форматирует только новые volumes, если диск добавят позже. Отдельный LV под production state задаёт свою границу размером, поэтому block/inode quotas остаются нужны для dev/agent/test homes и rootless container storage. Ни один непривилегированный project account не может исчерпать место для PostgreSQL WAL. Второй Ansible apply не меняет хост. Пока нет успешного backup, `unattended-upgrade` ставит security updates, но не выполняет автоматический reboot ([Debian manpage](https://manpages.debian.org/stable/unattended-upgrades/unattended-upgrade.8.en.html)).

**Не класть незаменимые данные.** Rootless Podman, `uidmap`, subuid/subgid, systemd user services, cgroup v2. Linger только у service users ([loginctl](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)). Первая реализация включает zram (2 GB на 16 GB host, 1 GB на 8 GB host) и не включает disk swap: страницы tmpfs с секретами не должны попасть на диск. Encrypted swap — отдельное решение после работающего backup, не старт. Agent/build processes входят в `dev-agents.slice`. Journald retention, синхронизация времени и отправка disk/inode/quota alerts вне VPS. Исчерпание quota disposable project user не трогает production WAL и root.

**Секреты и backup до production poller.** age identities появляются в escrow и проверяются расшифровкой тестового файла, до первого bot token. Test PostgreSQL получает off-provider pgBackRest. WAL сначала архивируется синхронно (`archive-async=n`); `archive-async` включается только после alert по возрасту WAL в repository. Production bot token и poller запускаются после успешного restore drill тестового контура, не после первого `podman run`.

Перед закрытием bootstrap задача обязана доказать: новый SSH login под `ops`, вход в console/rescue, reboot, отсутствие лишних listening ports, rootless container после reboot и повторный Ansible run без неожиданных изменений.

### Dev environments и coding agents

Каждый репозиторий описывает среду через `.devcontainer/devcontainer.json` и Dockerfile/Containerfile. Dev Container Specification переносит metadata среды между поддерживающими инструментами; reference CLI открыт отдельно ([containers.dev](https://containers.dev/), [Dockerfile guide](https://containers.dev/guide/dockerfile)). Podman-provider и конкретный редактор проверяются acceptance test для PER-133, потому что наличие спецификации не доказывает совместимость любой IDE.

Правила среды:

- версии SDK и base image закрепляются; base image — по digest, application dependencies — lockfiles (`go.sum`, `package-lock.json`, NuGet lock при появлении);
- compilers, package managers, harnesses и agent CLIs находятся внутри project image, не устанавливаются глобально на host;
- package install выполняется при сборке dev image, а не при каждом входе; floating `latest`, `curl | sh` и непроверенные Dev Container Features запрещены;
- source mount ограничен одним project workspace; соседние homes, `/etc`, runtime sockets и backup paths не монтируются;
- credentials отдельны по проекту и назначению, имеют минимальный scope и срок; production token/key недоступен dev/agent accounts;
- агент запускается как непривилегированный user, не получает `--privileged`, host network, device mounts или Podman socket;
- долгие процессы оформляются как versioned systemd user units с `Restart=on-failure`, `MemoryHigh` перед `MemoryMax`, `CPUQuota`, `TasksMax` и timeout, а не как бесконтрольные `tmux`-сессии. Порог `MemoryHigh` ставится ниже `MemoryMax`: без disk swap один `MemoryMax` убивает сборку сразу, а `MemoryHigh` сначала притормаживает её и оставляет шанс закончиться. Все project users входят в один host-level `dev-agents.slice` с aggregate limits: независимые user units иначе могут вместе исчерпать хост. Quadlet преобразует declarative container units в systemd services и поддерживает rootless search paths ([Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html));
- незакоммиченная работа агента попадает в hourly restic backup, но нормальный переносимый checkpoint — commit/push в отдельную ветку или worktree;
- sessions, prompts и tool configs сохраняются только если не содержат credentials; OAuth/token caches исключаются из backup и восстанавливаются повторной авторизацией.

Начальный бюджет памяти подтверждается метриками. На 8 GB потолки Dev + agents и Test сжимаются; reservation production и хоста сохраняется, а операционный запас RAM снимается:

| Slice | 16 GB host | 8 GB host | CPU ceiling | Примечание |
|---|---:|---:|---:|---|
| Host + filesystem cache | 2 GB | 2 GB | — | reservation хоста не сжимается |
| Dev + agents вместе | 8 GB | 3 GB | 500% / 200% | один тяжёлый build/test job; конкурентность повышается только после замера |
| Test stack | 2 GB | 1 GB | 100% | disposable data, scale-to-zero допустим |
| Production | 2 GB | 2 GB | 100% | приоритет над agent jobs; отдельный account и volumes |
| Операционный запас | 2 GB RAM + 2 GB zram | 0 GB RAM + 1 GB zram | — | на 8 GB запас RAM отсутствует; zram страхует краткий пик и не заменяет RAM |

Лимиты — максимумы, а не гарантированные резервации; их сумма оставляет headroom, но shared vCore не обещают постоянной CPU performance. PER-80 не должен обещать количество одновременных агентов до недельного замера peak RSS, memory pressure, swap activity, CPU steal, disk latency и OOM events. При конкуренции сначала ограничиваются agent/build workloads; перенос production выполняется по сигналам ADR-035.

### Runtime test/production

Каждая среда запускает отдельные pinned OCI images через versioned rootless Quadlet units. Production account не содержит checkout, build toolchain или general-purpose CI runner. Unit включает:

- image reference только `registry/repository@sha256:...`;
- отдельную internal network на environment;
- `DropCapability=all`, no-new-privileges и read-only root filesystem, когда приложению не нужна запись;
- явные writable volumes/tmpfs;
- health check, graceful stop timeout и systemd restart policy;
- `MemoryMax`, `CPUQuota`, `TasksMax`;
- logging без token, DSN и персональных payloads;
- pinned PostgreSQL major/minor policy, отдельное migration gate и явно проверяемая совместимость image со схемой до и после миграции.

Test и production не используют один Telegram token: два процесса с одним long-polling token будут конкурировать за updates. Production promotion сначала останавливает старый экземпляр, затем запускает новый; rolling overlap для одного token запрещён. Это также упрощает миграцию без DNS: переключается единственный poller, а не endpoint.

Meetups применяет миграции при старте сервиса, и deploy-инструмент этого различить не может: запрет отката на предыдущий digest после применённой миграции удерживается runbook, а не автоматикой. Вынос миграций в отдельный oneshot-unit перед стартом остаётся целью; для единственного экземпляра poller миграция при старте допустима, пока запрет отката записан явно, а восстановление идёт через PITR.

Aspire в эту схему не публикуется. Он продолжает собирать local graph, а production topology описывается OCI/Quadlet artifacts. Соответствие двух путей проверяется одинаковыми environment contracts и smoke tests. Генерация production-артефактов из Aspire — направление после MVP и отдельный spike: Quadlet и k3s потребляют одни и те же OCI images, поэтому первый срез при таком переходе не выбрасывается.

### CI, registry и supply chain

Pipeline строится на GitHub-hosted runners. GitHub предупреждает, что self-hosted runners могут быть постоянно скомпрометированы недоверенным workflow; hosted runners дают ephemeral clean VM. Actions закрепляются полным commit SHA, `GITHUB_TOKEN` получает минимальные permissions, workflow changes защищаются CODEOWNERS, а production — GitHub Environment approval ([GitHub secure use](https://docs.github.com/en/actions/reference/security/secure-use)). Постоянный self-hosted runner на dev или production VPS в PER-80 не вводится.

Release pipeline:

1. Проверить lockfiles, tests, lint, generated contracts и container build definitions.
2. Собрать отдельный OCI image для каждого deployable component на GitHub-hosted runner.
3. Просканировать dependencies/image, сформировать SPDX или CycloneDX SBOM. В первом срезе скан и SBOM report-only: находка не останавливает сборку. Гейт по уязвимостям вводится после того, как появится практика их разбирать, иначе привычка продавливать красный build появляется раньше самого гейта.
4. Push в GHCR, получить registry digest и больше не использовать tag как deploy identity. GHCR поддерживает OCI images и pull по digest ([GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)).
5. Выпустить GitHub artifact attestation/provenance и SBOM attestation. Attestation позволяет проверить происхождение, но сама по себе не доказывает безопасность artifact ([Artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)).
6. Ограничиться одним механизмом подписи. Первый срез использует artifact attestation из шага 5 и проверку `gh attestation verify` на хосте: Cosign keyless решает ту же задачу и добавляет вторую инфраструктуру доверия до того, как заработает первая. Подпись digest Cosign keyless identity GitHub Actions с сохранением verification bundle остаётся целевой схемой; keyless verification связывает signature с OIDC identity и issuer ([Cosign quickstart](https://docs.sigstore.dev/quickstart/quickstart-cosign/)).
7. Автоматически передать test forced command только digest. Хост проверяет repository, digest, workflow identity/issuer, signature и attestation до pull/restart.
8. После test smoke gate тот же digest допускается в production через protected environment/manual approval. Production build повторно не выполняется.

Deploy account принимает только строгий формат, например:

```text
deploy-solguficky --digest sha256:<64 hex>
```

В первом срезе forced command принадлежит SSH-ключу самого service account: `deploy-prod` — это запись в `authorized_keys` production-аккаунта с `restrict` и `command=`, поэтому ключ ведёт только к его собственным unit, а среда следует из identity структурно, а не из проверки внутри helper. `deploy-test` не может развернуть production, потому что его ключ физически не открывает чужой user manager. Script валидирует repository и digest, проверяет attestation, атомарно меняет desired digest и перезапускает свои unit через `systemctl --user`. Root-owned helper через `sudo -n` и переход в чужой user manager через `systemctl --machine=<service-user>@.host --user` остаются целевой схемой на случай, когда deploy-аккаунтов станет больше, чем сред: правка sudoers — типовой способ потерять доступ, а `--machine` добавляет зависимость от `systemd-container` и D-Bus там, где отладка дороже всего. Произвольные unit, path и environment variables из SSH-команды не принимаются; переход проверяется реальным test deploy после reboot. Автоматический rollback на предыдущий digest разрешён только до изменения схемы либо при доказанной backward compatibility через expand/contract migration. После необратимой миграции failed health gate останавливает deploy: восстановление БД или forward fix выполняется по отдельному runbook. Произвольный shell, tag, path и compose arguments через SSH не принимаются.

Ручной emergency redeploy с ноутбука вызывает этот же script и разворачивает уже существующий подписанный digest. Он не собирает source на production и не обходит verification. Отдельный offline сценарий на случай недоступности GHCR может переносить `podman save` archive вместе с digest и Cosign bundle; его необходимость — открытое решение, потому что повышает объём PER-80.

### Secrets

Версионируемые secret manifests шифруются SOPS для нативных age recipients. SOPS поддерживает age recipients и policy через `.sops.yaml`; age рекомендует отдельные native keys, а не повторное использование долгоживущего SSH private key ([SOPS](https://github.com/getsops/sops), [age](https://github.com/FiloSottile/age)).

Правила:

- test и production имеют разные age identities; обе лежат в off-host recovery escrow;
- в первом срезе age identity среды принадлежит её service user с mode `0600`, а расшифровка выполняется `ExecStartPre` того же unit в его `RuntimeDirectory=`: `/run` уже tmpfs, каталог создаётся с `RuntimeDirectoryMode=0700` и удаляется systemd при остановке unit. Отдельный root-owned materialization unit остаётся целевой схемой — он дополнительно закрывает ciphertext остальных секретов от скомпрометированного service user, — но эту разницу стоит покупать после того, как секретов станет больше одного набора на среду;
- Default Podman `file` secret driver запрещён: plaintext не попадает в persistent container storage. Runtime-каталог получает `noswap`, где это поддерживает kernel; отсутствие disk swap и zram не оставляют его страницы на обычном диске ([Podman secret drivers](https://docs.podman.io/en/latest/markdown/podman-secret-create.1.html));
- SOPS ciphertext можно хранить в private Git, но ciphertext не заменяет backup recovery key;
- bot tokens, AI provider tokens, GitHub deploy keys и backup credentials различны по environment и роли;
- backup writer не имеет prune/delete права на данные repository; maintenance credential используется только из operator context. Как именно это выражается в политике bucket — в разделе backup policy;
- восстановление age identity проверяется отдельно. Потеря identity при наличии ciphertext означает потерю secrets;
- после host compromise все доступные этому хосту tokens/keys считаются украденными и ротируются.

Не все runtime credentials обязаны жить в одном SOPS-файле. Если GitHub Environment или password manager является первичным issuer, в SOPS хранится bootstrap/reference, а runbook требует повторной выдачи. Источник истины для каждого секрета фиксируется в secret inventory без самого значения.

### Backup policy

Backup отделяется от переносимой конфигурации:

| Класс | Primary | Backup/restore |
|---|---|---|
| Source, Ansible, Quadlet, scripts | GitHub/private Git | clone конкретного commit; дополнительный repository mirror |
| OCI artifacts | GHCR | digest allowlist; при необходимости second registry/export |
| PostgreSQL | local production volume | pgBackRest off-provider repository: weekly full, daily differential, continuous WAL |
| Незаменимые application files | named volumes | restic hourly/daily по RPO |
| Dev/agent workspaces | Git branches/worktrees | hourly restic, исключая caches/build outputs/token caches |
| SOPS ciphertext | private Git | repository mirror |
| age recovery identities | root-owned storage общего хоста | password manager/offline encrypted escrow, отдельно от ciphertext |
| Recovery manifest | signed metadata рядом с off-provider backup | Ansible commit, OS, PostgreSQL major, pgBackRest version/config, application digest, schema version и связанные restic snapshots |
| Metrics/logs | local bounded retention | не блокируют restore; нужная incident retention решается отдельно |

PostgreSQL continuous archiving вместе с base backup позволяет PITR до выбранной точки; без `archive-async` `archive_command` должен вернуть успех только после надёжной записи WAL, и PostgreSQL повторяет неуспешную архивацию ([PostgreSQL PITR](https://www.postgresql.org/docs/current/continuous-archiving.html)). С `archive-async` этот успех относится к локальному spool: надёжная копия — только подтверждение repository. pgBackRest предоставляет full/differential/incremental backups, repository encryption, restore/PITR и S3-compatible repositories ([pgBackRest User Guide](https://pgbackrest.org/user-guide.html)). Для начального режима:

- первая реализация использует `archive-async=n`, чтобы `archive_command` подтверждал запись в repository. Цена этого выбора — доступность: при недоступном repository `archive_command` возвращает ошибку, PostgreSQL удерживает неархивированные сегменты, `pg_wal` растёт и при заполнении файловой системы кластер останавливается. Поэтому alert по размеру `pg_wal` и по `pg_stat_archiver.failed_count` обязателен с первого дня, а runbook отвечает на вопрос, что делать при многочасовой недоступности хранилища: переключить архив на второй endpoint или осознанно перейти в `archive-async=y`. `archive-async=y` — ускорение после работающего alert по возрасту WAL в repository: тогда `archive_command` подтверждает только локальный spool, PostgreSQL сегмент больше не повторяет, а RPO/promote считаются по archive-push в object storage, не по `pg_stat_archiver`. Spool живёт на durable local disk; при недоступном repository запись на хосте останавливается до исчерпания RPO, а не после потери spool;
- weekly full, daily differential;
- минимум четыре успешных full chains; retention проверяется расчётом реального объёма и WAL, а не только количеством;
- `archive_timeout=1min` как начальный интервал переключения неполного WAL segment: окно RPO 5 минут должно включать доставку в repository, а не только switch на хосте; фактический RPO считается от последней успешной записи в repository. Принудительно переключённый segment сохраняет полный размер, а PostgreSQL пропускает переключение только при отсутствии записи с прошлого раза: поэтому offset поллера и другие heartbeat-записи в PostgreSQL не хранятся, иначе простаивающий бот порождает полный segment каждую минуту. Реальный объём и bandwidth замеряются до ужимания интервала;
- encrypted repository в другом provider/account/credential domain;
- недельный логический дамп `pg_dump -Fc` рядом с PITR. Он не улучшает RPO и не заменяет WAL, но закрывает другой класс отказа: неверно настроенный pgBackRest, несовместимость мажорных версий при восстановлении и ошибку в самой процедуре. Для первого PITR-контура вероятность такой ошибки выше вероятности отказа хоста;
- непрерывная метрика последнего WAL, принятого off-host repository, с alert до 5 минут, ежедневная проверка backup chain и ежемесячный restore в изолированную базу.

restic шифрует repository, поддерживает S3-compatible backends и требует сохранить пароль: без него данные не восстановить ([Preparing a repository](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)). `restic check` проверяет структуру, а `--read-data` читает pack data; prune переписывает и удаляет данные, поэтому для backup jobs используется append-only credential, а забывание/prune — отдельный изолированный maintenance context. Append-only здесь свойство bucket policy, а не самого restic: запрет `DeleteObject` на весь bucket ломает снятие собственных lock-объектов repository и копит stale locks, поэтому delete запрещается на префиксах данных и остаётся разрешён на `locks/`. Object Lock берётся в governance mode: compliance mode делает prune невозможным до истечения retention. Maintenance не доверяет только свежим snapshot: retention использует `--keep-within`, проверяет ожидаемые historical snapshots и не запускается автоматически после подозрительного backup burst ([Checking integrity](https://restic.readthedocs.io/en/stable/045_working_with_repos.html), [append-only pattern](https://restic.readthedocs.io/en/stable/060_forget.html)).

Файлы, на которые ссылается транзакционное состояние PostgreSQL, либо immutable/content-addressed и восстанавливаются независимо, либо получают согласованную с БД recovery point. Независимый hourly restic snapshot нельзя считать консистентным с произвольной точкой PITR без доказанного application invariant.

Снимок диска у того же VPS-провайдера полезен перед опасным host upgrade или для offline migration, но не является единственным backup: он не разделяет provider/account failure domain и не заменяет PostgreSQL-consistent PITR. NFS/storage у того же provider также не считается off-provider копией.

### Restore runbook

Ежемесячный drill выполняется без production credentials и без доступа к Telegram:

1. Создать disposable VM или изолированный namespace с достаточным диском.
2. Получить одноразовые read-only backup credentials и recovery identity, проверить подпись recovery manifest и выбрать совместимые Ansible commit, PostgreSQL major, pgBackRest config/version и application digest.
3. Применить выбранный Ansible commit на чистую ОС и зафиксировать длительность.
4. Выполнить pgBackRest `info`/`check`, восстановить последнюю consistency point или заданное время в новый volume.
5. Восстановить указанный manifest restic snapshot в пустой path, не поверх существующих файлов; для связанных с БД файлов выбрать согласованную recovery point и проверить application invariant.
6. Запустить database integrity/application smoke checks на закреплённом digest; внешние side effects и bot polling отключить.
7. Сверить ожидаемые backup timestamps, schema/migration version, row-count invariants и выбранные контрольные данные.
8. Удалить disposable credentials/VM и записать фактические RPO, RTO, объём и найденные gaps.

Аварийное восстановление production:

1. Изолировать старый хост, отозвать его deploy/backup writer access и считать все доступные ему credentials скомпрометированными. Production bot token отозвать сразу: остановка poller на скомпрометированном хосте не гарантирует, что процесс не будет перезапущен. Новый poller стартует только с новым token.
2. Одноразовым read-only recovery credential проверить signed recovery manifest и до provisioning выбрать совместимые Ansible commit, PostgreSQL major, pgBackRest config/version, application digest и snapshots.
3. Создать чистый host у текущего или другого provider, применить выбранный Ansible commit и создать новую production age identity, новые deploy/backup credentials и новый bot token.
4. Старую recovery identity использовать только в изолированном operator context для чтения существующего ciphertext. Каждый credential или secret, материализованный на старом хосте, перевыпустить; прежнее значение нельзя просто зашифровать новому recipient. Неротируемый ключ старого backup repository использовать только read-only для recovery. Старую age identity и неротируемые recovery keys не устанавливать на новый работающий хост. Новые backups пишутся в repository с новым encryption material только после успешного full из шага 7.
5. Восстановить PostgreSQL pgBackRest до последней безопасной точки совместимым runtime; не запускать приложение и не применять его миграции до окончания recovery, сверки timeline и шага 7.
6. Восстановить согласованные незаменимые volumes из restic. Source, images и caches получить из Git/GHCR.
7. Восстановленный кластер ещё без приложения: выполнить успешный full backup в новый encrypted repository и убедиться, что WAL archive туда принимается. Для этого full используются recovery-credentials восстановленного кластера, не новые runtime secrets. Пока full не подтверждён, второй отказ хоста оставляет восстановленные данные без независимой копии.
8. Внутри восстановленного кластера сменить пароли/роли так, чтобы они совпали с перевыпущенными runtime secrets, затем материализовать только эти secrets в tmpfs. Миграции схемы — запись поверх уже защищённого full и выполняются только после него.
9. Проверить подписи OCI, внутренние health endpoints без внешних side effects, запустить ровно один production poller с новым token, выполнить Telegram smoke test и включить backup jobs/alerts с новыми credentials. Остаточные credentials старого хоста отозвать до завершения инцидента.

### Плановая миграция с минимальным простоем

1. Поднять целевой host параллельно из Ansible и проверить rootless runtime/reboot без production token.
2. Перенести полный backup chain и непрерывно доставлять WAL в repository, доступный цели.
3. Восстановить staging copy на цели, проверить версии PostgreSQL/pgBackRest, images и capacity.
4. Назначить окно, остановить старый bot и другие writers.
5. Выполнить `pg_switch_wal()` и дождаться, пока последний segment появится в off-host pgBackRest repository; записать target LSN/timestamp. Успех `archive_command` при `archive-async` для этого недостаточен. Принудительное переключение WAL предусмотрено PostgreSQL для архивации текущего неполного segment ([PostgreSQL PITR](https://www.postgresql.org/docs/current/continuous-archiving.html)).
6. Довести recovery цели до зафиксированной точки, проверить отсутствие ошибок и promote.
7. Восстановить финальные file snapshots, запустить приложения по прежнему подписанному digest и выполнить smoke gate.
8. Оставить старый host остановленным и без poller на согласованное rollback window. Rollback после новых записей требует отдельного reverse migration; простое включение старой базы запрещено.

При long polling DNS или load balancer не переключается. Нижняя граница downtime определяется временем финального WAL restore, health checks и запуска единственного bot process. Цель 15 минут подтверждается только репетицией на сопоставимом объёме.

### Проверки готовности

PER-80 нельзя закрыть по наличию файлов. Нужен живой evidence:

- clean host provisioned из versioned declaration, второй run идемпотентен;
- после reboot доступны только ожидаемые SSH и user services;
- scan извне не видит PostgreSQL/gRPC/NATS/dashboard ports;
- два проекта не читают homes/Podman storage друг друга;
- исчерпание block/inode quota disposable agent account не лишает PostgreSQL места для WAL и не блокирует root operations;
- agent не получает production secrets и не может вызвать production deploy;
- plaintext production secret существует только в runtime tmpfs, отсутствует в persistent Podman storage и очищается после reboot/stop;
- CI строит, подписывает и публикует image; test deploy принимает digest, tag отклоняет;
- подменённая/неподписанная image отклоняется до остановки текущей версии;
- forced deploy command после reboot управляет только сопоставленным service account и не принимает произвольный user/unit/path;
- production promotion использует test-tested digest и approval;
- manual command с ноутбука повторно разворачивает известный digest;
- test и production используют разные bot tokens, DB, secrets и repositories;
- restore drill выбирает совместимый runtime из signed recovery manifest и восстанавливает базу и файлы на чистом host в пределах измеренных RPO/RTO;
- disaster restore не открывает запись, пока новый encrypted repository не принял успешный full backup;
- planned migration drill доказывает единственный poller и отсутствие потерянных подтверждённых записей;
- остановка archive-push даёт alert по возрасту WAL и по размеру `pg_wal` задолго до заполнения файловой системы;
- логический дамп восстанавливается в пустую базу независимо от pgBackRest;
- внешний dead-man's switch знает о хосте: выключенный хост даёт alert вне VPS, а не тишину, неотличимую от исправной работы;
- потеря общего хоста не уничтожает off-provider backup, recovery keys и возможность восстановить production на новом VPS.

### Learning goals и fallback

PER-80 должен дать владельцу практику безопасного Linux-hosting, воспроизводимого bootstrap, rootless OCI runtime под systemd, проверки software supply chain и восстановления PostgreSQL на чистом хосте. k3s, multi-region failover и построение собственного PaaS в учебные цели этого среза не входят. Разборы технологий этого RFC пишутся по мере реализации и живут в [learning/](../learning/README.md); словарь, нужный до первого среза, — [self-hosting/vocabulary.md](../learning/self-hosting/vocabulary.md).

Основной fallback при непригодности текущего хоста — новый Linux VPS, удовлетворяющий тем же техническим требованиям и восстановленный тем же Ansible-сценарием из off-provider backup. Managed PaaS остаётся временным fallback для приложения. При недоступном CI владелец повторяет известный подписанный digest с локальной машины, а необходимость offline OCI archive при недоступном GHCR решается отдельно.

## Что станет сложнее

- Один хост оставляет общий kernel и failure domain, поэтому логическая изоляция не может обещать защиту от host compromise.
- Resource limits уменьшают capacity, доступную dev/agents, потому что production и операционный запас защищаются первыми.
- Rootless networking, Quadlet и secret materialization сложнее одного rootful compose-файла; это цена уменьшения blast radius и systemd-managed lifecycle.
- Deployment по digest требует явного promotion record; нельзя «быстро поправить файл на сервере».
- Separate test/prod tokens означают отдельную регистрацию/настройку бота и запрет запуска production token в локальном Aspire.
- PITR требует совместимых PostgreSQL/pgBackRest versions, контроля WAL backlog и регулярных drills; один `pg_dump` проще, но не выдерживает целевой RPO.
- Off-provider object storage, recovery escrow и разные credentials требуют собственного inventory и ротации.
- Dev containers не дают bit-for-bit reproducible build сами по себе. Reproducibility здесь означает восстановимый declaration и immutable deployed artifact; обновление зависимостей остаётся осознанной работой.
- Жёсткая egress allowlist для coding agents практически нестабильна из-за AI/GitHub/package endpoints и не предотвращает утечку через уже разрешённый AI API. Главные контроли — data boundary и credentials minimization.

## Открытые вопросы

### Принято владельцем

- стартовый хост — один Linux VPS; регистратор и тариф выбираются операционно и в платформу не входят;
- полный одновременный срез рассчитан на 16 GB RAM, 8 GB — нижняя рабочая граница с ужатыми agent/build limits;
- dev, agents, test и production на первом этапе размещаются на одном хосте с зафиксированным остаточным риском;
- отдельный production VPS не входит в обязательную последовательность и появляется только по сигналу необходимости из ADR-035;
- production backup остаётся у другого provider/account, чтобы отказ текущего VPS не уничтожил обе копии; объектное хранилище того же регистратора, что VPS, этим условием не является.

### Решения владельца до реализации

1. Какие AI providers, repositories и классы данных разрешено отправлять удалённым моделям? Разрешены ли закрытые product docs и user-derived fixtures?
2. Какой редактор/клиент обязан пройти devcontainer-over-SSH acceptance: Zed, VS Code, CLI или несколько?
3. Агент одного проекта живёт под тем же Unix user, что интерактивный developer, или нужен отдельный user и односторонний workspace handoff?
4. Какой object storage выбран для pgBackRest/restic и поддерживает ли он отдельные append/delete credentials, versioning и object lock?
5. Достаточны ли RPO 5 минут, file RPO 1 час, disaster RTO 2 часа и planned downtime 15 минут?
6. Нужен ли offline OCI export для redeploy при недоступности GHCR, или достаточно предыдущих images в local storage и registry availability?
7. Какой срок хранения dev/agent histories допустим с точки зрения приватности и стоимости?
8. Где хранится recovery escrow для age/restic и кто проверяет его доступность?

### Вопросы, которые закрываются spike/измерением

- хватает ли выбранной ёмкости хоста для одновременных agents, .NET/Go/Node builds, test stack и production без thrashing;
- работает ли выбранная IDE/Dev Container CLI с rootless Podman без privileged workaround;
- какие writable paths реально нужны каждому production image;
- сколько места и bandwidth занимают WAL и restic при реальной частоте изменений;
- достигаются ли заявленные RPO/RTO и 15 минут planned downtime;
- можно ли ограничить deploy SSH source addresses, не ломая GitHub-hosted Actions и доступ владельца;
- срабатывает ли хотя бы один сигнал ADR-035 для переноса production на отдельный VPS.

## Результирующие артефакты

После принятия и реализации решения должны появиться:

- принятый [ADR-035](../decisions/ADR-035-single-vps-for-initial-self-hosting.md), который заменяет ADR-006;
- versioned Ansible inventory schema/roles и bootstrap runbook;
- `.devcontainer/` declarations и documented project credential boundary;
- systemd/Quadlet units для agents, test и production;
- Containerfile/Dockerfile и pinned OCI image policy для deployable components;
- CI workflows build/attest/sign/deploy и GitHub Environment protection;
- root-owned narrow deploy script и локальная manual redeploy recipe;
- SOPS policy, secret inventory без значений и recovery/rotation runbook;
- pgBackRest/restic configuration, timers, alerts и retention policy;
- restore и migration runbooks с журналом ежемесячных/квартальных drills;
- measured capacity, RPO/RTO и cost record;
- обновлённые architecture, local-development, CI и operations docs после появления фактической реализации.
