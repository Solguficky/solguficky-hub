package auction

import com.typesafe.config.Config

import scala.concurrent.duration.FiniteDuration
import scala.jdk.DurationConverters.*

/**
 * Сроки слота торгов сообщества (ADR-047, дополнение 2026-10-12). Они вложены: держатель отвечает слоту быстрее, чем
 * слот — аукциону, а слот — быстрее, чем истекает команда открытия у шлюза (`auction.grpc.ask-timeout`). Иначе первым
 * истекал бы внешний срок, и вместо `UNAVAILABLE` вызывающий получал бы `DEADLINE_EXCEEDED`.
 */
final case class SlotSettings(holderTimeout: FiniteDuration, askTimeout: FiniteDuration)

object SlotSettings {

  /** Сроки не по порядку — дефект развёртывания: сервис не стартует. */
  def fromConfig(config: Config, commandTimeout: FiniteDuration): Either[String, SlotSettings] = {
    val holderTimeout = config.getDuration("auction.slot.holder-timeout").toScala
    val askTimeout = config.getDuration("auction.slot.ask-timeout").toScala
    if (holderTimeout >= askTimeout)
      Left("auction slot holder timeout is not shorter than the slot ask timeout: auction.slot.holder-timeout")
    else if (askTimeout >= commandTimeout)
      Left("auction slot ask timeout is not shorter than the command ask timeout: auction.slot.ask-timeout")
    else Right(SlotSettings(holderTimeout, askTimeout))
  }
}
