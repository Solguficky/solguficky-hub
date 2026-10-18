import { connect, createServer, type Socket } from "node:net";
import type { SlowService } from "./commands.js";

// Задержка и обрыв сервиса для пульта: TCP-прокси между ботами и настоящими
// Identity, Meetups и Auction. Бот говорит с прокси тем же клиентом и тем же
// дедлайном, что в продакшне, поэтому медленный сервис выглядит для него
// настоящим: запрос доходит позже, а дедлайн транспорта срабатывает сам.
// Подмена клиента этого не дала бы — ожидание шло бы мимо дедлайна. Обрыв
// («сервис недоступен») — тоже настоящий: прокси рвёт соединения, и клиент
// получает отказ соединения, а не истёкший дедлайн, — это разные кадры.

export type DelayProxy = {
  /** Адрес, который получает бот вместо адреса сервиса. */
  url: string;
  /** Задержка байтов от бота к сервису; 0 — без задержки. */
  setDelay(delayMs: number): void;
  /**
   * Сервис недоступен: открытые соединения рвутся, новые отвергаются сразу.
   * `false` возвращает сервис — следующий вызов бота соединится заново.
   */
  setDown(down: boolean): void;
  close(): Promise<void>;
};

type Held = { due: number; chunk: Buffer };

export async function openDelayProxy(target: string): Promise<DelayProxy> {
  const upstream = new URL(target);
  // Прокси слушает 127.0.0.1, а имя в сертификате сервиса — его собственное:
  // под TLS бот отверг бы такое соединение, и задержка проверяла бы не то.
  if (upstream.protocol !== "http:") {
    throw new Error(
      `задержка умеет только http, а сервис слушает ${upstream.protocol}//`,
    );
  }
  const upstreamPort = upstream.port === "" ? 80 : Number(upstream.port);
  let delayMs = 0;
  let down = false;
  const sockets = new Set<Socket>();

  // Полузакрытие разрешено с обеих сторон: клиент, закрывший запись, ещё ждёт
  // ответа, и прокси не вправе рвать соединение раньше сервиса.
  const server = createServer({ allowHalfOpen: true }, (client) => {
    if (down) {
      // Отказ соединения, а не тишина: иначе бот ждал бы дедлайн и показывал
      // бы «не ответил» вместо «недоступен». Именно RST: `destroy()` на
      // принятом соединении без непрочитанных байтов шлёт FIN, и на Linux
      // клиент видел бы тихое закрытие без ошибки — исход зависел бы от того,
      // успел ли его первый байт дойти раньше закрытия.
      client.resetAndDestroy();
      return;
    }
    const service = connect({
      port: upstreamPort,
      host: upstream.hostname,
      allowHalfOpen: true,
    });
    sockets.add(client);
    sockets.add(service);
    // Очередь держит порядок байтов: смена задержки посреди запроса не должна
    // пустить поздний кусок раньше раннего.
    const held: Held[] = [];
    let timer: NodeJS.Timeout | undefined;
    // Клиент закрыл запись или ушёл совсем, пока байты ещё в очереди: они уже
    // «в пути» и до сервиса доходят, а конец соединения идёт за ними.
    let clientState: "open" | "ended" | "gone" = "open";
    const settle = (): void => {
      if (held.length > 0) return;
      if (clientState === "ended") service.end();
      if (clientState === "gone") service.destroy();
    };
    const release = (): void => {
      timer = undefined;
      for (;;) {
        const next = held[0];
        if (next === undefined) {
          settle();
          return;
        }
        const wait = next.due - Date.now();
        if (wait > 0) {
          timer = setTimeout(release, wait);
          return;
        }
        held.shift();
        service.write(next.chunk);
      }
    };
    client.on("data", (chunk: Buffer) => {
      if (delayMs === 0 && held.length === 0) {
        service.write(chunk);
        return;
      }
      held.push({
        due: Math.max(Date.now() + delayMs, held.at(-1)?.due ?? 0),
        chunk,
      });
      timer ??= setTimeout(release, delayMs);
    });
    client.on("end", () => {
      if (clientState === "open") clientState = "ended";
      settle();
    });
    client.on("close", () => {
      clientState = "gone";
      sockets.delete(client);
      settle();
    });
    service.pipe(client);
    service.on("close", () => {
      clearTimeout(timer);
      held.length = 0;
      sockets.delete(service);
      client.destroy();
    });
    // Обрыв соединения — штатный исход для прокси: бот сам переживает его как
    // недоступность сервиса, а необработанная ошибка сокета уронила бы пульт.
    client.on("error", () => client.destroy());
    service.on("error", () => service.destroy());
  });

  const port = await new Promise<number>(
    (resolveListening, rejectListening) => {
      server.once("error", rejectListening);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          rejectListening(new Error("прокси задержки не получил порт"));
          return;
        }
        resolveListening(address.port);
      });
    },
  );

  return {
    url: `http://127.0.0.1:${port}`,
    setDelay(next) {
      delayMs = next;
    },
    setDown(next) {
      down = next;
      // Живая HTTP/2-сессия бота пережила бы флаг: рвём её, чтобы следующий
      // вызов соединялся заново и получал отказ.
      if (down) for (const socket of sockets) socket.destroy();
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolveClosed) => {
        server.close(() => resolveClosed());
      });
    },
  };
}

export type Latency = {
  /** Адреса сервисов для ботов: те же сервисы, но через прокси. */
  urls: Record<SlowService, string>;
  slow(service: SlowService, delayMs: number): void;
  down(service: SlowService): void;
  up(service: SlowService): void;
  close(): Promise<void>;
};

/** По прокси на сервис; отказ одного закрывает уже открытые. */
export async function openLatency(
  endpoints: Record<SlowService, string>,
): Promise<Latency> {
  const opened: Partial<Record<SlowService, DelayProxy>> = {};
  for (const service of Object.keys(endpoints) as SlowService[]) {
    try {
      opened[service] = await openDelayProxy(endpoints[service]);
    } catch (cause) {
      await Promise.all(Object.values(opened).map((proxy) => proxy.close()));
      throw cause;
    }
  }
  const proxies = opened as Record<SlowService, DelayProxy>;
  return {
    urls: Object.fromEntries(
      Object.entries(proxies).map(([service, proxy]) => [service, proxy.url]),
    ) as Record<SlowService, string>,
    slow(service, delayMs) {
      proxies[service].setDelay(delayMs);
    },
    down(service) {
      proxies[service].setDown(true);
    },
    up(service) {
      proxies[service].setDown(false);
    },
    async close() {
      await Promise.all(Object.values(proxies).map((proxy) => proxy.close()));
    },
  };
}
