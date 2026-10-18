package auction

import com.typesafe.config.ConfigFactory
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

/**
 * Обязательства ADR-045, которые живут только в конфигурации: сломанная строка здесь не роняет ни компиляцию, ни
 * одноузловой прогон — SBR начинает работать только со вторым узлом.
 */
final class ApplicationConfigSpec extends AnyWordSpec with Matchers {

  private val config = ConfigFactory.load()

  "application config" should {

    "run the node in a cluster with the split-brain resolver as its downing provider" in {
      config.getString("pekko.actor.provider") shouldBe "cluster"
      config.getString("pekko.cluster.downing-provider-class") shouldBe
        "org.apache.pekko.cluster.sbr.SplitBrainResolverProvider"
    }

    "keep events and snapshots in the jdbc plugin over one shared database" in {
      config.getString("pekko.persistence.journal.plugin") shouldBe "jdbc-journal"
      config.getString("pekko.persistence.snapshot-store.plugin") shouldBe "jdbc-snapshot-store"
      List("jdbc-journal", "jdbc-snapshot-store", "jdbc-read-journal")
        .map(plugin => config.getString(s"$plugin.use-shared-db")) shouldBe List.fill(3)("slick")
    }
  }
}
