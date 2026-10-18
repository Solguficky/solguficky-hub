package auction.persistence

import org.flywaydb.core.Flyway

/**
 * Схема базы Auction: журнал, snapshots, каталог лота и будущие offsets проекций.
 *
 * Таблицы журнала принадлежат плагину Pekko Persistence JDBC, но создаёт их сервис: плагин схему не ведёт, а его
 * обновление требует миграции (ADR-045, «Последствия»). Таблица каталога — строка состояния сервиса, а не журнал.
 * Скрипты лежат в `db/migration`, применённые версии — в [[JournalSchema.HistoryTable]].
 *
 * Повторный запуск на уже применённой схеме ничего не выполняет, а два процесса, стартующие одновременно, Flyway
 * сериализует advisory lock в PostgreSQL.
 */
object JournalSchema {

  val HistoryTable = "auction_schema_history"

  /** Применяет недостающие миграции и возвращает их число. Отказ — исключение Flyway: без схемы сервис не стартует. */
  def migrate(database: DatabaseSettings): Int =
    Flyway
      .configure()
      .dataSource(database.url, database.user, database.password)
      .locations("classpath:db/migration")
      // Пустой каталог — не «нечего применять», а потерянные ресурсы сборки:
      // без флага Flyway рапортует успех, и журнал падает позже на
      // отсутствующей таблице с ошибкой, которая про миграции ничего не говорит.
      .failOnMissingLocations(true)
      // Флаг выше ловит только отсутствующий каталог. Файл, названный не по
      // шаблону (`V1_…` с одним подчёркиванием), Flyway без этой проверки
      // пропускает молча: на пустой базе миграция вернула бы 0 — ровно как
      // штатный рестарт, — а падал бы только первый persist.
      .validateMigrationNaming(true)
      .table(HistoryTable)
      .load()
      .migrate()
      .migrationsExecuted
}
