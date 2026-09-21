// Кодогенерация Protobuf живёт внутри sbt: ScalaPB вызывается задачей compile,
// как Grpc.Tools вызывается внутри dotnet build у Meetups. Отдельного frontend
// вроде buf у Scala нет — обоснование в ADR-048.
addSbtPlugin("com.thesamet" % "sbt-protoc" % "1.0.6")
libraryDependencies += "com.thesamet.scalapb" %% "compilerplugin" % "0.11.19"

// Форматирование: `just auction-lint` — это scalafmtCheckAll, отдельный
// бинарник в PATH не нужен.
addSbtPlugin("org.scalameta" % "sbt-scalafmt" % "2.5.4")
