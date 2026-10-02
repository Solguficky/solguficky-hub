import { connect, createServer, type Socket } from "node:net";
import type { SlowService } from "./commands.js";

// Задержка сервиса для пульта: TCP-прокси между ботом и настоящим Identity или
// Meetups. Бот говорит с прокси тем же клиентом и тем же дедлайном, что в
// продакшне, поэтому медленный сервис выглядит для него настоящим: запрос
// доходит позже, а дедлайн транспорта срабатывает сам. Подмена клиента этого
// не дала бы — ожидание шло бы мимо дедлайна.

export type DelayProxy = {
  /** Адрес, который получает бот вместо адреса сервиса. */
  url: string;
  /** Задержка байтов от бота к сервису; 0 — без задержки. */
  setDelay(delayMs: number): void;
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
  const sockets = new Set<Socket>();

  // Полузакрытие разрешено с обеих сторон: клиент, закрывший запись, ещё ждёт
  // ответа, и прокси не вправе рвать соединение раньше сервиса.
  const server = createServer({ allowHalfOpen: true }, (client) => {
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
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolveClosed) => {
        server.close(() => resolveClosed());
      });
    },
  };
}

export type Latency = {
  /** Адреса сервисов для бота: те же сервисы, но через прокси. */
  identityUrl: string;
  meetupsUrl: string;
  slow(service: SlowService, delayMs: number): void;
  close(): Promise<void>;
};

export async function openLatency(endpoints: {
  identityUrl: string;
  meetupsUrl: string;
}): Promise<Latency> {
  const identity = await openDelayProxy(endpoints.identityUrl);
  // Второй прокси может отказать — тогда первый уже слушает порт и без
  // закрытия остался бы висеть до конца процесса.
  const meetups = await openDelayProxy(endpoints.meetupsUrl).catch(
    async (cause: unknown) => {
      await identity.close();
      throw cause;
    },
  );
  const proxies: Record<SlowService, DelayProxy> = { identity, meetups };
  return {
    identityUrl: identity.url,
    meetupsUrl: meetups.url,
    slow(service, delayMs) {
      proxies[service].setDelay(delayMs);
    },
    async close() {
      await Promise.all([identity.close(), meetups.close()]);
    },
  };
}
