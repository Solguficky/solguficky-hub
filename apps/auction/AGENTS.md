# Auction

Scala 3 + Apache Pekko. Стек и хранение — [ADR-045](../../docs/decisions/ADR-045-auction-scala-pekko-persistence-jdbc.md), сборка и кодогенерация — [ADR-048](../../docs/decisions/ADR-048-auction-sbt-and-scalapb-build.md), словарь домена торгов — [ADR-047](../../docs/decisions/ADR-047-auction-trading-domain-vocabulary-and-event-form.md), ответственность — [бриф](../../docs/services/auction.md). Состав полей лога — [standard](../../docs/standards/observability/logging.md), тестовый стек и уровни — [standard](../../docs/standards/testing/testing-strategy.md), имена тестов — [standard](../../docs/standards/testing/naming.md).

Сейчас это языковой контур, а не сервис: HTTP-граница с health, кодогенерация и тесты. Доменной логики торгов, persistence Pekko, схемы журнала и узла в графе Aspire здесь нет — они приходят отдельными задачами.

- `Main.scala` — composition root: конфигурация, actor system, привязка HTTP. Доменная логика туда не переезжает.
- `boundary/` владеет HTTP-границей. Каркас лога заполняет `BoundaryLogging`, и маршруты о логе ничего не знают: заполнение каркаса — работа границы, а не вызываемого кода.
- Привязывается всегда `BoundaryLogging.boundary`, а не `logOperation` напрямую. Незапечатанный маршрут на неизвестном пути отклоняется, отклонение превращается в 404 выше директивы, и запрос, на который сервис ответил, не попадает в журнал вообще. `boundary` запечатывает маршрут внутри себя, чтобы об этом нельзя было забыть.
- `OperationFrame` — чистое отображение «что вернула граница» в поля записи, и проверяется оно на L0 без поднятого сервера. Категорию `visibility` транспорт сам не выставляет: её выбирает доменный обработчик, потому что снаружи такой отказ маскируется под «не найдено».
- Неожиданный отказ перехватывает обработчик внутри `seal` и кладёт причину рядом с запросом, чтобы запись операции получила `error` и `stack`. Сам он не логирует: у записи об отказе ровно один автор. Наружу уходит пустой 500.
- **Долг:** текст в поле `error` сейчас несёт сообщение исключения как есть. Пользовательского ввода в сервис не приходит, поэтому попасть туда ему неоткуда, но первый обработчик, который такой ввод примет, обязан принести санитизацию в `OperationFrame.errorText` — иначе запись нарушит privacy-запреты [стандарта](../../docs/standards/observability/logging.md).
- Сгенерированный ScalaPB код лежит в `target/`, отдельного каталога `gen/` у Scala нет. Руками он не редактируется, изменение контракта идёт через `proj-change-contract`.
- Вход кодогенерации сужается фильтром `Compile / PB.generate / includeFilter` в `build.sbt`, а `PB.protoSources` остаётся корнем модуля `contracts/proto`. Почему именно так и чем это ломается — раздел «Кодогенерация Scala» в [protobuf.md](../../docs/standards/contracts/protobuf.md).
- Версии Scala и библиотек закреплены в `build.sbt`, версия sbt — в `project/build.properties`, версия JDK — в `.java-version`, и её же читает CI. Локальный JDK должен совпадать с этим файлом, иначе гейт и CI проверяют разные рантаймы.
- Форматирование — scalafmt по `.scalafmt.conf`; гейт `just auction-lint`, правка `just auction-format`.
- Команды — `just auction-*`. Переменные окружения и ручной запуск — [README](README.md).
