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
      "ch.qos.logback" % "logback-classic" % logbackVersion,
      "net.logstash.logback" % "logstash-logback-encoder" % logstashEncoderVersion,
      "com.thesamet.scalapb" %% "scalapb-runtime" % scalapb.compiler.Version.scalapbVersion,
      "org.apache.pekko" %% "pekko-actor-testkit-typed" % pekkoVersion % Test,
      "org.apache.pekko" %% "pekko-http-testkit" % pekkoHttpVersion % Test,
      "org.scalatest" %% "scalatest" % scalaTestVersion % Test,
      "org.scalatestplus" %% "scalacheck-1-18" % scalaCheckBridgeVersion % Test
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
    // Из identity берётся только файл значений: его импортирует схема сервиса
    // аукциона. Весь каталог дал бы ещё и серверный трейт IdentityService —
    // сервиса, которого аукцион не обслуживает.
    Compile / PB.generate / includeFilter := new SimpleFileFilter(schema => {
      val path = schema.getPath.replace('\\', '/')
      schema.isFile &&
      schema.getName.endsWith(".proto") &&
      (path.contains("/proto/auction/") || path.endsWith("/proto/identity/v1/roles.proto"))
    }),
    // Только серверная сторона: аукцион обслуживает AuctionService и ни одного
    // чужого RPC не вызывает. Клиент появится вместе с первым исходящим
    // вызовом — тот же явный выбор, что GrpcServices у элементов Protobuf в
    // контрактном проекте Meetups. Цели ScalaPB задаёт сам плагин pekko-grpc.
    pekkoGrpcGeneratedLanguages := Seq(PekkoGrpc.Scala),
    pekkoGrpcGeneratedSources := Seq(PekkoGrpc.Server),
    // Плагин по умолчанию включает flat_package, и identity/v1/roles.proto
    // переезжает из identity.v1.roles в identity.v1. Без флага Scala-пакет
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
    run / fork := true
  )
