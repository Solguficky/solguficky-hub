import { countFailure } from "../failures.js";
import type { Logger } from "../logging.js";

// Имя операции обеих записей. Соединение — не subject и не обработчик, поэтому
// имя своё, но одно и то же у всех потребителей шины: запрос по нему собирает
// потерю шины у Notifications и бота сразу.
export const busConnectionOperation = "nats.connection";

// Событие соединения в той мере, в какой его знает наблюдатель: Status клиента
// nats.js сюда подходит как есть, а тест обходится без сервера.
export type BusStatus = { type: string };

// Пишет одну запись о потере шины и одну о восстановлении. Клиент
// переподключается без предела и на каждой попытке шлёт `reconnecting`: запись
// на попытку засыпала бы лог за минуту простоя, поэтому здесь пишется только
// переход между состояниями. Без записи простой потребителя неотличим от пустой
// шины: сообщений нет в обоих случаях.
export async function watchBusStatus(
  statuses: AsyncIterable<BusStatus>,
  logger: Logger,
  now: () => number = Date.now,
): Promise<void> {
  let lostAt: number | undefined;
  for await (const status of statuses) {
    if (status.type === "disconnect" && lostAt === undefined) {
      lostAt = now();
      countFailure("dependency_unavailable");
      // Переход мгновенный, поэтому длительность нулевая; каркас требует
      // поле всегда, а длину простоя несёт запись о восстановлении.
      logger.warn("bus connection lost", {
        operation: busConnectionOperation,
        result: "error",
        duration_us: 0,
        error_category: "dependency_unavailable",
        error: "connection to NATS lost; reconnecting",
      });
    } else if (status.type === "reconnect" && lostAt !== undefined) {
      logger.info("bus connection restored", {
        operation: busConnectionOperation,
        result: "ok",
        duration_us: Math.round((now() - lostAt) * 1000),
      });
      lostAt = undefined;
    }
  }
}
