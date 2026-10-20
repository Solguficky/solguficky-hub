package auction.testkit

import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.stream.KillSwitches
import org.apache.pekko.stream.SharedKillSwitch
import org.apache.pekko.stream.scaladsl.Flow
import org.apache.pekko.stream.scaladsl.Keep
import org.apache.pekko.stream.scaladsl.Sink
import org.apache.pekko.stream.scaladsl.Source
import org.apache.pekko.stream.scaladsl.Tcp
import org.apache.pekko.util.ByteString

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import scala.concurrent.Await
import scala.concurrent.duration.*

/**
 * TCP-прокси между браузером и узлом, который обрывает сеть так, как её обрывает зал: соединение не закрывается, а
 * замолкает. Закрытое соединение браузер замечает сам, и сторож тишины страницы такой обрыв не проверяет.
 *
 * Режим действует на соединения, принятые после его смены. Тишина замораживает и открытые соединения: ни байта, ни
 * закрытия. Остальные режимы открытые соединения закрывают, иначе браузер отдал бы следующий запрос замороженному
 * соединению из своего пула, и восстановление ждало бы сторожа страницы на каждом таком соединении.
 */
final class StallingProxy(target: Int)(using system: ActorSystem[?]) {

  private final case class Generation(mode: StallingProxy.Mode, number: Int, switch: SharedKillSwitch)

  private val current = AtomicReference(Generation(StallingProxy.Mode.Open, 0, KillSwitches.shared("proxy-0")))
  private val accepted = AtomicInteger(0)
  private val headersPassed = AtomicInteger(0)

  /** Выключатели поколений, чьи соединения заморожены, но ещё не закрыты. */
  private val frozen = ConcurrentLinkedQueue[SharedKillSwitch]()

  private val binding = Await.result(
    Tcp(system)
      .bind("127.0.0.1", 0)
      .toMat(Sink.foreach { incoming =>
        val mine = current.get
        accepted.incrementAndGet()
        val alive = () => current.get.number == mine.number
        val upstream = Flow[ByteString].filter(_ => alive()).via(Tcp(system).outgoingConnection("127.0.0.1", target))
        incoming.handleWith((mine.mode match {
          case StallingProxy.Mode.Open => upstream.filter(_ => alive())
          case StallingProxy.Mode.Silent => Flow.fromSinkAndSourceCoupled(Sink.ignore, Source.maybe[ByteString])
          case StallingProxy.Mode.HeadersOnly =>
            upstream
              .statefulMap(() => false)(
                (headed, chunk) =>
                  if (headed) (true, ByteString.empty)
                  else {
                    val (ended, passed) = StallingProxy.headers(chunk)
                    if (ended) headersPassed.incrementAndGet(): Unit
                    (ended, passed)
                  },
                _ => None
              )
              .filter(_.nonEmpty)
              .concat(Source.maybe[ByteString])
        }).via(mine.switch.flow))
      })(Keep.left)
      .run(),
    10.seconds
  )

  val port: Int = binding.localAddress.getPort

  /** Сколько соединений прокси принял: по нему сьют ждёт попытку страницы в новом режиме. */
  def connections: Int = accepted.get

  /** Сколько ответов дошли до браузера заголовками без тела в режиме `headersOnly`. */
  def headersOnlyResponses: Int = headersPassed.get

  /** Сеть замолкла: открытые соединения и новые не отдают ни байта и не закрываются. */
  def silence(): Unit = switch(StallingProxy.Mode.Silent)

  /** Новое соединение открывается, но после заголовков ответа поток молчит: снимок не приходит. */
  def headersOnly(): Unit = switch(StallingProxy.Mode.HeadersOnly)

  /** Сеть вернулась. */
  def restore(): Unit = switch(StallingProxy.Mode.Open)

  private def switch(next: StallingProxy.Mode): Unit = {
    val previous =
      current.getAndUpdate(old => Generation(next, old.number + 1, KillSwitches.shared(s"proxy-${old.number + 1}")))
    frozen.add(previous.switch)
    if (next != StallingProxy.Mode.Silent) closeFrozen()
  }

  private def closeFrozen(): Unit =
    Iterator.continually(frozen.poll()).takeWhile(_ != null).foreach(_.shutdown())

  def close(): Unit = {
    frozen.add(current.get.switch)
    closeFrozen()
    Await.result(binding.unbind(), 10.seconds)
  }
}

object StallingProxy {

  enum Mode {
    case Open, Silent, HeadersOnly
  }

  private val HeaderEnd = ByteString("\r\n\r\n")

  /** Кусок до конца заголовков ответа и признак, что конец пройден; заголовки приходят первым куском. */
  private def headers(chunk: ByteString): (Boolean, ByteString) = {
    val end = chunk.indexOfSlice(HeaderEnd)
    if (end < 0) (false, chunk) else (true, chunk.take(end + HeaderEnd.length))
  }
}
