package auction.grpc

import auction.lot.BidSource

import java.util.concurrent.atomic.AtomicReference

/**
 * Поля записи операции, которые знает только сервис: граница тела запроса не разбирает, а запись об операции у вызова
 * одна и пишет её граница ([[GrpcBoundary]]). Сервис кладёт сюда значения из уже разобранного запроса — не ввод
 * человека, а словарь контракта, — и граница дописывает их к своей записи. Поля каркаса записи сервис не переписывает.
 */
final class OperationNotes private (accepting: Boolean) {
  private val fields = new AtomicReference(Map.empty[String, String])

  def add(field: String, value: String): Unit =
    if (accepting) fields.updateAndGet(_ + (field -> value)): Unit

  def all: Map[String, String] = fields.get()
}

object OperationNotes {

  /** Источник ставки `PlaceBid` (ADR-049, дополнение 2026-10-18). */
  val Source = "source"

  def apply(): OperationNotes = new OperationNotes(accepting = true)

  /** Сервис вне границы — тесты сервиса без записи операции: заметки некуда дописать. */
  val discarded: OperationNotes = new OperationNotes(accepting = false)

  /** Значение источника — имя из контракта без префикса: `BOT` или `FLOOR`. */
  def source(source: BidSource): String =
    source match {
      case BidSource.Bot => "BOT"
      case BidSource.Floor => "FLOOR"
    }
}
