package auction.persistence

import auction.lot.AuctionId
import auction.raffle.PrizePhotoBytes
import auction.raffle.RafflePrizePhotos
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.persistence.jdbc.db.SlickExtension
import slick.jdbc.GetResult
import slick.jdbc.JdbcBackend.Database
import slick.jdbc.PostgresProfile.api.*
import slick.jdbc.SetParameter

import java.util.UUID
import scala.concurrent.ExecutionContext
import scala.concurrent.Future

/**
 * Байты фото приза розыгрыша в таблице `raffle_prize_photo` (PER-772) через пул плагина журнала — по той же причине,
 * что каталог лота и снимок имён билетов.
 */
final class SlickRafflePrizePhotos(database: Database)(using ExecutionContext) extends RafflePrizePhotos {

  private given SetParameter[Array[Byte]] = SetParameter((value, params) => params.setBytes(value))

  private given GetResult[PrizePhotoBytes] = GetResult { row =>
    PrizePhotoBytes(IArray.unsafeFromArray(row.nextBytes()), row.nextString(), row.nextString())
  }

  /**
   * Вставка без перезаписи; после неё версия под этим id — своя или чужая, и сравнение решает исход. Строку могли
   * удалить между вставкой и чтением: её id тогда уже не станет текущим, и решение остаётся за розыгрышем.
   */
  def store(auction: AuctionId, photoId: UUID, photo: PrizePhotoBytes): Future[Boolean] = {
    val content = IArray.genericWrapArray(photo.content).toArray
    val insert =
      sqlu"""INSERT INTO raffle_prize_photo (auction_id, photo_id, content, media_type, version)
             VALUES (${auction.value.toString}::uuid, ${photoId.toString}::uuid, $content, ${photo.mediaType},
                     ${photo.version})
             ON CONFLICT (auction_id, photo_id) DO NOTHING"""
    val stored =
      sql"""SELECT version FROM raffle_prize_photo
            WHERE auction_id = ${auction.value.toString}::uuid AND photo_id = ${photoId.toString}::uuid"""
        .as[String]
        .headOption
    database.run(insert.andThen(stored).transactionally).map(_.forall(_ == photo.version))
  }

  def read(auction: AuctionId, photoId: UUID): Future[Option[PrizePhotoBytes]] =
    database.run(
      sql"""SELECT content, media_type, version FROM raffle_prize_photo
            WHERE auction_id = ${auction.value.toString}::uuid AND photo_id = ${photoId.toString}::uuid"""
        .as[PrizePhotoBytes]
        .headOption
    )

  def delete(auction: AuctionId, photoId: UUID): Future[Unit] =
    database
      .run(
        sqlu"""DELETE FROM raffle_prize_photo
               WHERE auction_id = ${auction.value.toString}::uuid AND photo_id = ${photoId.toString}::uuid"""
      )
      .map(_ => ())
}

object SlickRafflePrizePhotos {

  def apply(system: ActorSystem[?]): SlickRafflePrizePhotos = {
    val database = SlickExtension(system).database(system.settings.config.getConfig("jdbc-journal")).database
    new SlickRafflePrizePhotos(database)(using system.executionContext)
  }
}
