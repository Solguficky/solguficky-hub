package auction.meetup

import auction.aggregate.ApplyMeetupCancelled
import auction.aggregate.Auction
import auction.aggregate.MeetupId
import auction.lot.AuctionId
import meetups.v1.meetups_events.MeetupEvent

import java.util.UUID
import scala.util.Try

/**
 * Аукцион сходки и команда ему, выведенные из факта отмены сходки. `requestId` — сквозной идентификатор из конверта
 * факта: потребитель несёт его в свои записи и своего не рождает (logging.md).
 */
final case class Inheritance(auctionId: AuctionId, command: ApplyMeetupCancelled, requestId: Option[String])

/**
 * Факт `events.meetups.meetup_cancelled` как команда аукциону (ADR-047, дополнение 2026-10-12). Потребитель ничего не
 * выбирает: аукцион — UUIDv5 от `meetup_id`, `op_id` — UUIDv5 от `event_id`, а что делать, решает агрегат.
 */
object MeetupCancellations {

  /**
   * Тело сообщения, которое не разобрать или которое не отмена сходки, — `Left` с причиной: повтор его не исправит, и
   * потребитель снимает сообщение. Причина называет поле, но не значение.
   */
  def inheritance(payload: Array[Byte]): Either[String, Inheritance] =
    for {
      event <- Try(MeetupEvent.parseFrom(payload)).toOption.toRight("meetup event is not a MeetupEvent")
      _ <- Either.cond(event.occasion.isMeetupCancelled, (), "meetup event is not meetup_cancelled")
      eventId <- uuid(event.eventId).toRight("meetup event has no valid event_id")
      meetupId <- uuid(event.meetupId).toRight("meetup event has no valid meetup_id")
    } yield Inheritance(
      Auction.idOf(MeetupId(meetupId)),
      ApplyMeetupCancelled(Auction.meetupCancellationOf(eventId)),
      event.requestId
    )

  private def uuid(raw: String): Option[UUID] = Try(UUID.fromString(raw)).toOption
}
