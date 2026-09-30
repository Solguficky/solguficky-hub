package auction.naming

import auction.lot.ParticipantId

import java.text.Normalizer
import java.util.Locale
import java.util.UUID

/** Аукцион — область имени участника: выбор в одном аукционе другой не затрагивает. */
final case class AuctionId(value: UUID)

/** Ник Telegram без «@»: латиница, цифры и подчёркивание, не длиннее 32 символов. */
final case class TelegramUsername private (value: String)

object TelegramUsername {

  private val Form = "[A-Za-z0-9_]{1,32}".r

  /**
   * `None` — строка не ник Telegram. Из апдейта Telegram такая прийти не может, поэтому это ошибка формы запроса, и
   * отвечает на неё граница, а не отказ выбора.
   */
  def from(raw: String): Option[TelegramUsername] = Option.when(Form.matches(raw))(new TelegramUsername(raw))
}

/**
 * Псевдоним участника в аукционе. `value` — текст для показа, `key` — по нему псевдоним уникален в аукционе.
 *
 * Текст приводится к NFKC, крайние пробелы срезаются, серии пробелов внутри сжимаются в один: иначе « Вася » и «Вася»
 * были бы разными псевдонимами, неотличимыми на экране. Ключ — тот же текст без учёта регистра.
 */
final case class Alias private (value: String, key: String)

object Alias {

  val MaxLength = 32

  def apply(raw: String): Either[NamingRefusal, Alias] = {
    val text = collapsed(Normalizer.normalize(raw, Normalizer.Form.NFKC))
    val length = text.codePointCount(0, text.length)
    if (length == 0 || length > MaxLength || text.codePoints.anyMatch(forbidden)) Left(NamingRefusal.AliasInvalid)
    else Right(new Alias(text, text.toLowerCase(Locale.ROOT)))
  }

  // Звёздочка — метка псевдонима, «@» — метка ника: внутри псевдонима они подделали бы чужую метку. Проверка идёт после
  // NFKC, поэтому полноширинные «＊» и «＠» не проходят в обход. Управляющие и форматные символы (нулевой ширины,
  // смена направления текста) делают на экране одинаковыми разные строки.
  private def forbidden(codePoint: Int): Boolean =
    codePoint == '*' || codePoint == '@' || Character.isISOControl(codePoint) ||
      Character.getType(codePoint) == Character.FORMAT

  private def collapsed(text: String): String =
    text.map(c => if (blank(c)) ' ' else c).split(' ').filter(_.nonEmpty).mkString(" ")

  // Та же граница пробела, что у названия лота: неразрывные пробелы на экране пусты так же.
  private def blank(c: Char): Boolean = Character.isWhitespace(c) || Character.isSpaceChar(c)
}

/** Что участник выбрал показывать в аукционе. */
enum ChosenName {

  /** Снимок ника на момент выбора: смена ника в Telegram его не обновляет. */
  case Telegram(username: TelegramUsername)

  case Pseudonym(alias: Alias)
}

/** Выбор, как он пришёл от участника, до проверки. */
enum NameChoice {

  /** Ник из апдейта Telegram. `None` — ника у участника нет. */
  case Username(username: Option[TelegramUsername])

  /** Псевдоним, как его набрал участник. */
  case Pseudonym(raw: String)
}

enum DisplayKind {
  case Username
  case Pseudonym
  case Placeholder
}

/** Имя, готовое к показу: метки уже расставлены, вызывающий их не добавляет. */
final case class DisplayName(text: String, kind: DisplayKind)

/** Ожидаемые отказы выбора имени. Транспортного кода они не несут: отображение — работа границы. */
enum NamingRefusal {

  /** Выбран ник, а ника у участника нет. */
  case UsernameMissing

  /** Псевдоним пустой, длиннее `Alias.MaxLength` или содержит запрещённый символ. */
  case AliasInvalid

  /** Псевдоним уже взял другой участник этого аукциона. */
  case AliasTaken

  /** Участник уже ставил в аукционе, и выбор больше не меняется. */
  case NameFrozen
}

/** Отказ ставки и прокси-лимита: участник не выбрал имя в аукционе лота. */
case object NameNotChosen

/** Решения об имени без хранилища. */
object DisplayNameRules {

  def decide(choice: NameChoice): Either[NamingRefusal, ChosenName] =
    choice match {
      case NameChoice.Username(Some(username)) => Right(ChosenName.Telegram(username))
      case NameChoice.Username(None) => Left(NamingRefusal.UsernameMissing)
      case NameChoice.Pseudonym(raw) => Alias(raw).map(ChosenName.Pseudonym(_))
    }

  /**
   * Ник показывается с «@», псевдоним — со звёздочкой, поэтому псевдоним, совпавший с чужим ником, от ника отличим.
   * Участник без выбора — ставка из зала или участник, чьи данные стёрты, — получает заглушку по хвосту идентификатора:
   * пробела и кириллицы в нике нет, а у псевдонима была бы звёздочка, так что заглушку не спутать ни с тем, ни с
   * другим.
   */
  def render(participant: ParticipantId, chosen: Option[ChosenName]): DisplayName =
    chosen match {
      case Some(ChosenName.Telegram(username)) => DisplayName(s"@${username.value}", DisplayKind.Username)
      case Some(ChosenName.Pseudonym(alias)) => DisplayName(s"${alias.value}*", DisplayKind.Pseudonym)
      case None => DisplayName(s"Участник ${participant.value.toString.takeRight(4)}", DisplayKind.Placeholder)
    }

  /** Ставка и прокси-лимит допускаются только с выбранным именем. */
  def requireChosen(chosen: Option[ChosenName]): Either[NameNotChosen.type, ChosenName] =
    chosen.toRight(NameNotChosen)
}
