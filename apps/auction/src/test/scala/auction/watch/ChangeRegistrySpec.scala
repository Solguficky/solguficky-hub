package auction.watch

import org.apache.pekko.actor.testkit.typed.scaladsl.ActorTestKit
import org.apache.pekko.stream.Attributes
import org.apache.pekko.stream.scaladsl.Sink
import org.apache.pekko.stream.scaladsl.SinkQueueWithCancel
import org.scalatest.BeforeAndAfterAll
import org.scalatest.concurrent.Eventually
import org.scalatest.concurrent.ScalaFutures
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

import java.util.UUID

final class ChangeRegistrySpec
    extends AnyWordSpec
    with Matchers
    with ScalaFutures
    with Eventually
    with BeforeAndAfterAll {

  private val kit = ActorTestKit("change-registry")
  private given org.apache.pekko.actor.typed.ActorSystem[?] = kit.system

  override protected def afterAll(): Unit = kit.shutdownTestKit()

  private val auction = UUID.fromString("5d3b7c6a-1f2e-5a4b-8c9d-0e1f2a3b4c5d")
  private val other = UUID.fromString("6e4c8d7b-2a3f-5b5c-9d0e-1f2a3b4c5d6e")

  /**
   * Подписка, которую тест тянет сам: следующий повод забирается только по `pull`. Буфер приёмника — один элемент, как
   * у самого узкого места настоящего потока, поэтому впереди спроса держится не больше одного повода.
   */
  private def subscribe(registry: ChangeRegistry, id: UUID): SinkQueueWithCancel[Unit] =
    registry.subscribe(id).runWith(Sink.queue[Unit]().withAttributes(Attributes.inputBuffer(1, 1)))

  /** Сколько поводов подписка отдаёт, пока не замолчит. */
  private def drain(queue: SinkQueueWithCancel[Unit]): Int =
    Iterator.continually(pending(queue)).takeWhile(taken => taken).size

  /** Есть ли у подписки забранный повод: `pull` без повода не завершается. */
  private def pending(queue: SinkQueueWithCancel[Unit]): Boolean = {
    val next = queue.pull()
    try next.futureValue(timeout(org.scalatest.time.Span(300, org.scalatest.time.Millis))) == Some(())
    catch { case _: org.scalatest.exceptions.TestFailedException => false }
  }

  "a change registry" should {

    "give a subscriber a reason to read at once, before any change" in {
      val registry = ChangeRegistry()
      val queue = subscribe(registry, auction)
      queue.pull().futureValue shouldBe Some(())
      queue.cancel()
    }

    "wake only the subscribers of the changed auction" in {
      val registry = ChangeRegistry()
      val watching = subscribe(registry, auction)
      val elsewhere = subscribe(registry, other)
      watching.pull().futureValue shouldBe Some(())
      elsewhere.pull().futureValue shouldBe Some(())
      eventually(registry.subscriptions(auction) shouldBe 1)

      registry.changed(auction)

      watching.pull().futureValue shouldBe Some(())
      pending(elsewhere) shouldBe false
      watching.cancel()
      elsewhere.cancel()
    }

    "merge changes a subscriber has not taken yet instead of queueing one reason per change" in {
      val registry = ChangeRegistry()
      val queue = subscribe(registry, auction)
      queue.pull().futureValue shouldBe Some(())
      eventually(registry.subscriptions(auction) shouldBe 1)

      (1 to 100).foreach(_ => registry.changed(auction))

      drain(queue) should (be >= 1 and be <= 2)
      queue.cancel()
    }

    "wake every subscriber when the listener may have missed signals" in {
      val registry = ChangeRegistry()
      val first = subscribe(registry, auction)
      val second = subscribe(registry, other)
      first.pull().futureValue shouldBe Some(())
      second.pull().futureValue shouldBe Some(())

      registry.everything()

      first.pull().futureValue shouldBe Some(())
      second.pull().futureValue shouldBe Some(())
      first.cancel()
      second.cancel()
    }

    "forget a subscriber that cancelled" in {
      val registry = ChangeRegistry()
      val queue = subscribe(registry, auction)
      queue.pull().futureValue shouldBe Some(())
      eventually(registry.subscriptions(auction) shouldBe 1)

      queue.cancel()

      eventually(registry.subscriptions(auction) shouldBe 0)
      registry.changed(auction)
    }
  }
}
