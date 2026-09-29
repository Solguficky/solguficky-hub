package auction

import auction.entity.LotEntity
import auction.persistence.JournalDatabase
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.cluster.MemberStatus
import org.apache.pekko.cluster.sharding.typed.ShardingEnvelope
import org.apache.pekko.cluster.sharding.typed.scaladsl.ClusterSharding
import org.apache.pekko.cluster.sharding.typed.scaladsl.Entity
import org.apache.pekko.cluster.typed.Cluster
import org.apache.pekko.cluster.typed.Join

import java.time.Clock
import java.util.UUID
import scala.concurrent.Future
import scala.concurrent.duration.FiniteDuration

/**
 * Узел Auction в одноузловом кластере (ADR-045).
 *
 * Шардинг здесь нужен ради адресации entity и её жизненного цикла, а не ради распределения: узел присоединяется сам к
 * себе, и все shard'ы живут на нём. Второй узел потребует решения о хостинге и seed-адресов вместо self-join.
 */
object AuctionNode {

  /**
   * Присоединяет узел к самому себе и отдаёт шардинг, в котором агрегаты регистрируют свои entity.
   *
   * Join асинхронный: узел становится `Up` позже, и до этого [[readiness]] отвечает «кластер не поднят».
   */
  def join(system: ActorSystem[?]): ClusterSharding = {
    val cluster = Cluster(system)
    cluster.manager ! Join(cluster.selfMember.address)
    ClusterSharding(system)
  }

  /** Регистрирует entity лота; идентификатор entity — идентификатор лота. */
  def registerLots(
      sharding: ClusterSharding,
      clock: Clock,
      newId: () => UUID
  ): ActorRef[ShardingEnvelope[LotEntity.Command]] =
    sharding.init(Entity(LotEntity.TypeKey)(context => LotEntity(context.entityId, clock, newId)))

  def readiness(system: ActorSystem[?], timeout: FiniteDuration): () => Future[Readiness] = {
    val cluster = Cluster(system)
    val pingJournal = JournalDatabase.ping(system, timeout)
    given ActorSystem[?] = system
    import system.executionContext
    () => NodeReadiness.check(() => cluster.selfMember.status == MemberStatus.Up, pingJournal, timeout)
  }
}
