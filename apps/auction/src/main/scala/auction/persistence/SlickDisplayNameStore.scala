package auction.persistence

import auction.lot.AuctionId
import auction.lot.ParticipantId
import auction.naming.Alias
import auction.naming.ChooseResult
import auction.naming.ChosenName
import auction.naming.DisplayNameStore
import auction.naming.TelegramUsername
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import org.postgresql.util.PSQLException
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Имена участников в таблице `auction_display_name` через пул плагина журнала — по той же причине, что каталог лота.
 *
 * Уникальность псевдонима держит частичный уникальный индекс, а не чтение перед записью: два участника, одновременно
 * взявшие один псевдоним, сериализуются базой, и второй получает нарушение индекса. Заморозку держит условие `WHERE`
 * той же записи, а не отдельная проверка.
 */
final class SlickDisplayNameStore(database: Database)(using ExecutionContext) extends DisplayNameStore {

  private val AliasIndex = "auction_display_name_alias_key"

  def choose(auction: AuctionId, participant: ParticipantId, name: ChosenName): Future[ChooseResult] = {
    val (username, alias, key) = name match {
      case ChosenName.Telegram(value) => (Some(value.value), None, None)
      case ChosenName.Pseudonym(value) => (None, Some(value.value), Some(value.key))
    }
    database
      .run(
        sqlu"""INSERT INTO auction_display_name (auction_id, participant_id, telegram_username, alias, alias_key)
               VALUES (${auction.value.toString}::uuid, ${participant.value.toString}::uuid, $username, $alias, $key)
               ON CONFLICT (auction_id, participant_id) DO UPDATE
               SET telegram_username = EXCLUDED.telegram_username, alias = EXCLUDED.alias, alias_key = EXCLUDED.alias_key
               WHERE NOT auction_display_name.frozen""".flatMap {
          case 1 => DBIO.successful(ChooseResult.Written)
          // Ноль строк значит, что строка есть и заморожена. Если её уже нет, «заморожено» соврало бы.
          case _ =>
            select(auction, Set(participant)).flatMap { rows =>
              rows.get(participant) match {
                case Some(current) => DBIO.successful(ChooseResult.Frozen(current))
                case None =>
                  DBIO.failed(
                    IllegalStateException(
                      s"auction_display_name row of ${participant.value} in ${auction.value} vanished after a frozen conflict"
                    )
                  )
              }
            }
        }
      )
      .recover {
        case taken: PSQLException if violates(taken, AliasIndex) => ChooseResult.AliasTaken
      }
  }

  def freeze(auction: AuctionId, participant: ParticipantId): Future[Boolean] =
    database
      .run(
        sqlu"""UPDATE auction_display_name SET frozen = true
               WHERE auction_id = ${auction.value.toString}::uuid AND participant_id = ${participant.value.toString}::uuid"""
      )
      .map(_ == 1)

  def find(auction: AuctionId, participants: Set[ParticipantId]): Future[Map[ParticipantId, ChosenName]] =
    if (participants.isEmpty) Future.successful(Map.empty) else database.run(select(auction, participants))

  // UUID приходят типом, а не текстом вызывающего, поэтому литерал массива собирается из их канонической формы.
  private def select(auction: AuctionId, participants: Set[ParticipantId]) = {
    val ids = participants.map(_.value.toString).mkString("{", ",", "}")
    sql"""SELECT participant_id::text, telegram_username, alias, alias_key FROM auction_display_name
          WHERE auction_id = ${auction.value.toString}::uuid AND participant_id = ANY($ids::uuid[])"""
      .as[(String, Option[String], Option[String], Option[String])]
      .map(_.map { (id, username, alias, key) =>
        val participant = ParticipantId(UUID.fromString(id))
        participant -> restored(auction, participant, username, alias, key)
      }.toMap)
  }

  private def violates(error: PSQLException, constraint: String): Boolean =
    error.getSQLState == "23505" && Option(error.getServerErrorMessage).exists(_.getConstraint == constraint)

  // CHECK таблицы слабее типов: NFKC, сжатие пробелов и ключ уникальности он не проверяет. Строка, которую тип не
  // восстанавливает в тот же текст и тот же ключ, записана в обход сервиса, и выдать её за выбор участника нельзя: с чужим
  // ключом индекс пропустил бы второй такой же псевдоним.
  private def restored(
      auction: AuctionId,
      participant: ParticipantId,
      username: Option[String],
      alias: Option[String],
      key: Option[String]
  ): ChosenName = {
    def broken = IllegalStateException(
      s"auction_display_name holds a malformed name of ${participant.value} in ${auction.value}"
    )
    (username, alias) match {
      case (Some(raw), None) if key.isEmpty => ChosenName.Telegram(TelegramUsername.from(raw).getOrElse(throw broken))
      case (None, Some(raw)) =>
        Alias(raw) match {
          case Right(value) if value.value == raw && key.contains(value.key) => ChosenName.Pseudonym(value)
          case _ => throw broken
        }
      case _ => throw broken
    }
  }
}

object SlickDisplayNameStore {

  def apply(system: ActorSystem[?]): SlickDisplayNameStore = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    new SlickDisplayNameStore(database)(using system.executionContext)
  }
}
