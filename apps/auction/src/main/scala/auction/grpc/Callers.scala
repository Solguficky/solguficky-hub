package auction.grpc

import com.typesafe.config.Config

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * Вызывающий процесс (ADR-056): имя узла AppHost, по которому AppHost называет его токен. Вызывающий — процесс, а не
 * человек: человек приходит в запросе полем `viewer`.
 */
enum Caller(val node: String) {

  /** Бот хаба. */
  case TelegramBot extends Caller("telegram-bot")

  /** Бот аукциона (ADR-044). */
  case AuctionBot extends Caller("auction-bot")
}

/**
 * Таблица «токен → вызывающий».
 *
 * Хранятся не токены, а их SHA-256: сравнение идёт по дайджестам одинаковой длины через `MessageDigest.isEqual`, и
 * время сравнения не зависит ни от длины присланной строки, ни от того, на каком байте она разошлась с настоящей.
 * Перебираются все строки таблицы без раннего выхода — так же, как maintainer-секрет в Identity.
 */
final class CallerTable private (digests: Seq[(Caller, Array[Byte])]) {

  def identify(token: String): Option[Caller] = {
    val presented = CallerTable.digest(token)
    digests.foldLeft(Option.empty[Caller]) { case (found, (caller, expected)) =>
      if (MessageDigest.isEqual(presented, expected)) Some(caller) else found
    }
  }
}

object CallerTable {

  /**
   * Таблица из `auction.grpc.callers`: ключ — имя узла вызывающего, значение — его токен.
   *
   * Сервис с неполной или неоднозначной таблицей не стартует (ADR-056): у объявленного вызывающего нет значения или оно
   * пустое, у двух вызывающих одно значение. Причина называет вызывающего, но не значение: токен — секрет.
   */
  def fromConfig(config: Config, declared: Set[Caller]): Either[String, CallerTable] = {
    val section = "auction.grpc.callers"
    val tokens = declared.toSeq.sortBy(_.ordinal).map { caller =>
      val path = s"$section.${caller.node}"
      // Обрезка та же, что у присланного токена в CallerGate: секрет, прочитанный
      // из файла с переводом строки, иначе не совпал бы ни с одним вызовом, а
      // значение из одних пробелов прошло бы проверку на пустоту — и сервис с
      // зелёным health отказывал бы каждому вызывающему.
      caller -> (if (config.hasPath(path)) config.getString(path).trim else "")
    }

    tokens.collectFirst { case (caller, token) if token.isEmpty => caller } match {
      case Some(caller) =>
        Left(s"auction caller token for ${caller.node} is not set: ${environmentVariable(caller)}")
      case None =>
        val shared = tokens.groupBy(_._2).values.find(_.size > 1)
        shared match {
          case Some(same) =>
            Left(s"auction caller tokens are equal for ${same.map(_._1.node).sorted.mkString(" and ")}")
          case None => Right(new CallerTable(tokens.map((caller, token) => caller -> digest(token))))
        }
    }
  }

  /** Переменная окружения, из которой AppHost отдаёт токен вызывающего (integration.md, «Service authentication»). */
  def environmentVariable(caller: Caller): String =
    s"AUCTION_CALLER_TOKEN_${caller.node.toUpperCase.replace('-', '_')}"

  private def digest(token: String): Array[Byte] =
    MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8))
}
