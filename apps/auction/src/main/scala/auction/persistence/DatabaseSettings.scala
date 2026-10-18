package auction.persistence

import com.typesafe.config.Config

/**
 * Подключение к базе Auction в форме Pekko Persistence JDBC: JDBC URL без учётных данных и отдельно пользователь с
 * паролем.
 *
 * Те же значения читает и плагин журнала — через `auction.database` в `application.conf`, — поэтому миграция и журнал
 * не могут разойтись базой.
 */
final case class DatabaseSettings(url: String, user: String, password: String) {

  // Case class печатает все поля, а настройки попадают в сообщения об отказе
  // и отладочный вывод: пароль туда уходить не должен.
  override def toString: String = s"DatabaseSettings($url, $user, ***)"
}

object DatabaseSettings {

  private val section = "auction.database"

  // Ключ конфигурации и переменная окружения, из которой он приходит: отказ
  // называет переменную, потому что задаёт её оператор, а не конфигурацию.
  private val sources = List(
    "url" -> "AUCTION_DATABASE_JDBC_URL",
    "user" -> "AUCTION_DATABASE_USER",
    "password" -> "AUCTION_DATABASE_PASSWORD"
  )

  def fromConfig(config: Config): Either[String, DatabaseSettings] = {
    def value(key: String): Option[String] = {
      val path = s"$section.$key"
      Option.when(config.hasPath(path))(config.getString(path)).filter(_.trim.nonEmpty)
    }

    val missing = sources.collect { case (key, variable) if value(key).isEmpty => variable }
    (value("url"), value("user"), value("password")) match {
      case (Some(url), Some(user), Some(password)) => Right(DatabaseSettings(url, user, password))
      case _ => Left(s"auction database is not configured: set ${missing.mkString(", ")}")
    }
  }
}
