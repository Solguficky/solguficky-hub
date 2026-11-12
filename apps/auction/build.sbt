// Сборка Auction Service.
//
// Единственное место, где закреплены версии Scala и библиотек сервиса: у Go это
// go.mod, у TypeScript package.json, у .NET PackageReference. Версии buf и
// golangci-lint в корневом justfile к Scala не относятся — buf в этой сборке
// не участвует (ADR-048).

ThisBuild / scalaVersion := "3.3.7"
ThisBuild / organization := "com.solguficky"
ThisBuild / version := "0.1.0-SNAPSHOT"

val pekkoVersion = "1.6.0"
val pekkoHttpVersion = "1.3.0"
val scalaTestVersion = "3.2.19"
val scalaCheckBridgeVersion = "3.2.19.0"
val logbackVersion = "1.5.18"
val logstashEncoderVersion = "8.1"
val pekkoPersistenceJdbcVersion = "1.3.0"
val pekkoProjectionVersion = "1.1.0"
val openTelemetryVersion = "1.66.0"
// Версия, с которой собран pekko-persistence-jdbc выше; меняется вместе с ним.
val slickVersion = "3.5.1"
val postgresqlVersion = "42.7.13"
val flywayVersion = "13.8.0"
val testcontainersScalaVersion = "0.44.1"
val jnatsVersion = "2.26.3"
// Та же версия, что у @playwright/test сайта сообщества: браузер одной сборки
// Chromium лежит в общем кэше ms-playwright и скачивается один раз.
val playwrightVersion = "1.63.0"

// Интеграционный уровень (L1) поднимает PostgreSQL в Docker и в `just verify`
// не входит (testing-strategy.md). Отбор идёт по имени сьюта, а не по тегу
// ScalaTest: тег исключает тесты, но сьют всё равно создаётся, и контейнер
// или ActorTestKit в его конструкторе стартуют и требуют Docker от гейта (beforeAll
// при этом пропускается — проверено прогоном). PostgresFixture стартует базу
// лениво, и с ним тег бы справился; отбор по имени не зависит от того, как
// следующий L1-сьют её поднимает.
lazy val integrationTests = sys.env.get("AUCTION_INTEGRATION_TESTS").contains("1")

// Браузерный уровень — страница экрана зала в Chromium против настоящего узла
// (PER-485). Ему нужны и Docker, и скачанный браузер, поэтому он отбирается
// своей переменной и не входит ни в L0, ни в L1: `AUCTION_BROWSER_TESTS=1`
// оставляет только сьюты `*BrowserSpec`.
lazy val browserTests = sys.env.get("AUCTION_BROWSER_TESTS").contains("1")

// Корень buf-модуля потребитель не переносит: пути в import считаются от
// contracts/proto. Вход сужается каталогом домена — тем же фильтром, что
// paths в buf.gen.yaml у Go и TypeScript и поимённый список Protobuf у .NET.
//
// Путь приводится к каноническому виду намеренно: относительный `..` доезжает
// до обходчика файлов sbt как есть, и каждый прогон печатает предупреждение
// про relative glob, которое в логе CI неотличимо от настоящего.
lazy val contractsRoot = Def.setting {
  ((ThisBuild / baseDirectory).value / ".." / ".." / "contracts" / "proto").getCanonicalFile
}

lazy val auction = (project in file("."))
  .enablePlugins(PekkoGrpcPlugin)
  .settings(
    name := "auction",
    // Версия JDK читается из того же .java-version, что и в CI, а не
    // дублируется числом: -release роняет сборку на несовпадающем локальном
    // JDK, вместо того чтобы молча собрать её под другую платформу.
    scalacOptions ++= Seq(
      "-deprecation",
      "-feature",
      "-unchecked",
      "-Wunused:imports",
      s"-release:${IO.read(baseDirectory.value / ".java-version").trim}"
    ),
    libraryDependencies ++= Seq(
      "org.apache.pekko" %% "pekko-actor-typed" % pekkoVersion,
      "org.apache.pekko" %% "pekko-stream" % pekkoVersion,
      "org.apache.pekko" %% "pekko-slf4j" % pekkoVersion,
      "org.apache.pekko" %% "pekko-http" % pekkoHttpVersion,
      // pekko-grpc-runtime тянет pekko-discovery своей, более старой версии, а
      // Pekko на старте ActorSystem отказывается работать со смешанными
      // версиями своих модулей. Модуль поднимается до общей версии явно.
      "org.apache.pekko" %% "pekko-discovery" % pekkoVersion,
      "org.apache.pekko" %% "pekko-cluster-typed" % pekkoVersion,
      "org.apache.pekko" %% "pekko-cluster-sharding-typed" % pekkoVersion,
      "org.apache.pekko" %% "pekko-persistence-typed" % pekkoVersion,
      // Плагин JDBC собран против более ранней Pekko и тянет её модули своей
      // версии; query поднимается до общей явно по той же причине, что и
      // discovery выше.
      "org.apache.pekko" %% "pekko-persistence-query" % pekkoVersion,
      "org.apache.pekko" %% "pekko-persistence-jdbc" % pekkoPersistenceJdbcVersion,
      // Проекция журнала в read model: offset и read model одной JDBC-транзакцией
      // (ADR-045). Модули проекции собраны против более ранней Pekko, и её модули
      // поднимаются до общей версии строками выше.
      "org.apache.pekko" %% "pekko-projection-jdbc" % pekkoProjectionVersion,
      "org.apache.pekko" %% "pekko-projection-eventsourced" % pekkoProjectionVersion,
      // Метрики уходят по OTLP без SDK конкретного вендора (ADR-053); адрес и имя
      // сервиса — из переменных OTEL_*, которые подставляет окружение.
      "io.opentelemetry" % "opentelemetry-api" % openTelemetryVersion,
      "io.opentelemetry" % "opentelemetry-sdk" % openTelemetryVersion,
      "io.opentelemetry" % "opentelemetry-sdk-extension-autoconfigure" % openTelemetryVersion,
      "io.opentelemetry" % "opentelemetry-exporter-otlp" % openTelemetryVersion,
      // Строка журнала и snapshot лота — JSON через отдельную модель хранения
      // (ADR о формате журнала): Protobuf остаётся межсервисным форматом.
      "org.apache.pekko" %% "pekko-serialization-jackson" % pekkoVersion,
      // Slick приходит с плагином JDBC, но каталог лота импортирует его сам —
      // пул плагина и plain SQL. Транзитивную зависимость обновление плагина
      // сменило бы молча, поэтому она объявлена той же версией, что у плагина.
      "com.typesafe.slick" %% "slick" % slickVersion,
      "org.postgresql" % "postgresql" % postgresqlVersion,
      "org.flywaydb" % "flyway-core" % flywayVersion,
      "org.flywaydb" % "flyway-database-postgresql" % flywayVersion,
      "ch.qos.logback" % "logback-classic" % logbackVersion,
      "net.logstash.logback" % "logstash-logback-encoder" % logstashEncoderVersion,
      "com.thesamet.scalapb" %% "scalapb-runtime" % scalapb.compiler.Version.scalapbVersion,
      // Публикация фактов лота в JetStream (ADR-003): официальный Java-клиент
      // NATS, тот же, что ведёт команда NATS для Go и .NET у соседних сервисов.
      "io.nats" % "jnats" % jnatsVersion,
      "org.apache.pekko" %% "pekko-actor-testkit-typed" % pekkoVersion % Test,
      "org.apache.pekko" %% "pekko-persistence-testkit" % pekkoVersion % Test,
      "org.apache.pekko" %% "pekko-http-testkit" % pekkoHttpVersion % Test,
      "io.opentelemetry" % "opentelemetry-sdk-testing" % openTelemetryVersion % Test,
      "org.scalatest" %% "scalatest" % scalaTestVersion % Test,
      "org.scalatestplus" %% "scalacheck-1-18" % scalaCheckBridgeVersion % Test,
      "com.dimafeng" %% "testcontainers-scala-postgresql" % testcontainersScalaVersion % Test,
      "com.dimafeng" %% "testcontainers-scala-scalatest" % testcontainersScalaVersion % Test,
      "com.microsoft.playwright" % "playwright" % playwrightVersion % Test
    ),
    Compile / PB.protoSources := Seq(contractsRoot.value),
    // sbt-protoc кладёт protoSources ещё и в каталоги ресурсов, и без этой
    // строки весь contracts/proto — включая meetups, notifications и buf.yaml —
    // уезжает в артефакт сервиса рядом с application.conf. Фильтр генерации
    // это не ловит: он сужает вход protoc, а не состав ресурсов.
    Compile / unmanagedResourceDirectories :=
      (Compile / unmanagedResourceDirectories).value.filterNot(_ == contractsRoot.value),
    // Корнем остаётся весь модуль, иначе import-ы между схемами не резолвятся,
    // а генерируется только потребляемый домен. Сузить сам protoSources нельзя:
    // sbt-protoc кладёт его ещё и на include path, и одна и та же схема
    // становится видна по двум относительным путям — protoc считает это
    // повторным определением и падает.
    // Проверка isFile обязательна: обход отдаёт фильтру и каталоги, а каталог,
    // принятый за вход, доезжает до protoc и валит его сообщением
    // «Input file is a directory».
    //
    // Из identity — файл значений, его импортирует схема сервиса аукциона, и
    // сервис: при закрытии регистрации в розыгрыше аукцион спрашивает право
    // CheckAccessRight (ADR-066, PER-499). Схема событий Identity ему не нужна.
    // Из meetups — сервис и его
    // сообщения: аукцион спрашивает право администратора CheckMeetupAuthority
    // (ADR-047, ADR-051), — и схема событий: аукцион наследует отмену сходки из
    // events.meetups.meetup_cancelled (ADR-047, дополнение 2026-10-12).
    Compile / PB.generate / includeFilter := new SimpleFileFilter(schema => {
      val path = schema.getPath.replace('\\', '/')
      schema.isFile &&
      schema.getName.endsWith(".proto") &&
      (path.contains("/proto/auction/") ||
        path.endsWith("/proto/identity/v1/access.proto") ||
        path.endsWith("/proto/identity/v1/identity_service.proto") ||
        path.endsWith("/proto/meetups/v1/meetups_service.proto") ||
        path.endsWith("/proto/meetups/v1/meetups_events.proto") ||
        path.endsWith("/proto/meetups/v1/meetups.proto"))
    }),
    // Сервер AuctionService и клиенты MeetupsService и IdentityService. Выбор
    // сторон у плагина общий на все схемы, поэтому рядом рождаются и
    // неиспользуемые половины — трейты серверов Meetups и Identity и клиент
    // самого аукциона; второй нужен L1-тестам
    // gRPC-границы, которые ходят в сервер так же, как бот. Цели ScalaPB задаёт
    // сам плагин pekko-grpc.
    pekkoGrpcGeneratedLanguages := Seq(PekkoGrpc.Scala),
    pekkoGrpcGeneratedSources := Seq(PekkoGrpc.Server, PekkoGrpc.Client),
    // Плагин по умолчанию включает flat_package, и identity/v1/access.proto
    // переезжает из identity.v1.access в identity.v1. Без флага Scala-пакет
    // выводится из файла так же, как до стабов и как записано в protobuf.md.
    pekkoGrpcCodeGeneratorSettings -= "flat_package",
    // Prefix в имени процесса не нужен: `just auction-run` запускает ровно
    // один main, и sbt не должен спрашивать, какой именно.
    Compile / mainClass := Some("auction.Main"),
    // Каждый сьют с ScalatestRouteTest поднимает свою ActorSystem, и при
    // параллельном запуске их потоки соревнуются за инициализацию SLF4J и за
    // процессор. Последовательный прогон делает порядок воспроизводимым: иначе
    // один и тот же код зелёный отдельным вызовом и красный в полном гейте.
    Test / parallelExecution := false,
    // L1-сьют называется `*IntegrationSpec`; `AUCTION_INTEGRATION_TESTS=1`
    // оставляет только их, без переменной — только остальные. Браузерные
    // сьюты `*BrowserSpec` идут только под своей переменной.
    Test / testOptions += Tests.Filter(suite =>
      if (browserTests) suite.endsWith("BrowserSpec")
      else !suite.endsWith("BrowserSpec") && suite.endsWith("IntegrationSpec") == integrationTests
    ),
    // Пропуск не равен прохождению (testing-strategy.md), а готового флага у
    // ScalaTest нет: `ignore`, отменённый `assume` и `pending` sbt считает
    // прохождением. Итог прогона переводится в провал здесь, а не в рецепте:
    // CI зовёт `sbt test` напрямую, и проверка в justfile его бы не застала.
    // Сьюты, которые отсёк фильтр уровня выше, не запускаются и пропуском не
    // считаются. `testOnly` и `testQuick` идут мимо `executeTests` и правило
    // не исполняют: рецепты и CI зовут только `test`.
    Test / executeTests := {
      val output = (Test / executeTests).value
      val suites = output.events.values
      val skipped =
        suites.map(s => s.ignoredCount + s.canceledCount + s.pendingCount + s.skippedCount).sum
      // Отбор по суффиксу молча пуст, если сьют уровня переименовали: шаг CI
      // такого уровня был бы зелёным, не запустив ни одного теста.
      val emptyLevel = (integrationTests || browserTests) && suites.isEmpty
      if (skipped == 0 && !emptyLevel) output
      else {
        if (skipped > 0)
          streams.value.log.error(
            s"пропущено тестов: $skipped — пропуск не равен прохождению, прогон считается упавшим"
          )
        if (emptyLevel)
          streams.value.log.error("уровень выбран переменной, но ни один сьют под него не попал")
        output.copy(overall = TestResult.Failed)
      }
    },
    // L1 рестарта под залпом (PER-332) запускает сервис голой JVM `java auction.Main`, как узел Aspire, и убивает
    // процесс. Тест не форкается, и его собственный classpath — загрузчики sbt по слоям, а не путь, который можно
    // отдать дочерней JVM. Поэтому runtime classpath уходит тесту файлом ресурса, тем же выражением, что у рецепта
    // `auction-classpath`.
    Test / resourceGenerators += Def.task {
      val file = (Test / resourceManaged).value / "auction-runtime-classpath"
      IO.write(file, (Runtime / fullClasspath).value.files.mkString(java.io.File.pathSeparator))
      Seq(file)
    }.taskValue,
    run / fork := true,
    // Прогон экрана зала (PER-486, `just auction-screen-load`) — `Test/runMain` в своей JVM: он поднимает Chromium и
    // процесс Auction и завершается `sys.exit`, которому не место в JVM самого sbt.
    Test / runMain / fork := true
  )
