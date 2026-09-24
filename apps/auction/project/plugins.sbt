// Кодогенерация Protobuf живёт внутри sbt: ScalaPB вызывается задачей compile,
// как Grpc.Tools вызывается внутри dotnet build у Meetups. Отдельного frontend
// вроде buf у Scala нет — обоснование в ADR-048.
addSbtPlugin("com.thesamet" % "sbt-protoc" % "1.0.6")
// Та же версия, что тянет pekko-grpc-codegen: ниже её закрепление вытесняется
// молча, и строка перестаёт закреплять то, что реально генерирует код.
libraryDependencies += "com.thesamet.scalapb" %% "compilerplugin" % "0.11.20"

// Стабы gRPC под Pekko: генератор pekko-grpc работает поверх того же ScalaPB и
// вызывается той же задачей compile, поэтому второго пути кодогенерации нет
// (ADR-048).
addSbtPlugin("org.apache.pekko" % "pekko-grpc-sbt-plugin" % "1.2.0")

// Форматирование: `just auction-lint` — это scalafmtCheckAll, отдельный
// бинарник в PATH не нужен.
addSbtPlugin("org.scalameta" % "sbt-scalafmt" % "2.5.4")
