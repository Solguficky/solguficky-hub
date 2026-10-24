import net from "node:net";

// TCP-прокси до сервера, чья сеть обрывается так, как её обрывает зал (PER-705):
// соединение не закрывается, а замолкает. Закрытое соединение клиент замечает
// сам, а замолкшее — только по своему keepalive. Тот же приём, что у
// `testkit/StallingProxy` сьюта Auction.
//
// Тишина замораживает и открытые соединения, и принятые в ней: ни байта, ни
// закрытия. Возврат сети закрывает замороженные, иначе клиент ждал бы на
// соединении, принятом в тишине, а новые соединения идут к серверу.
export type StallingProxy = {
  port: number;
  /** Сколько соединений прокси принял: по нему тест ждёт новую попытку клиента. */
  connections(): number;
  /** Сеть замолкла: открытые соединения и новые не отдают ни байта и не закрываются. */
  silence(): void;
  /** Сеть вернулась. */
  restore(): void;
  close(): Promise<void>;
};

export async function openStallingProxy(
  targetPort: number,
): Promise<StallingProxy> {
  let silent = false;
  let accepted = 0;
  const sockets = new Set<net.Socket>();
  const frozen = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      frozen.delete(socket);
    });
  };
  const freeze = (socket: net.Socket) => {
    frozen.add(socket);
    socket.pause();
  };

  const server = net.createServer((client) => {
    accepted += 1;
    track(client);
    if (silent) {
      freeze(client);
      return;
    }
    const upstream = net.connect(targetPort, "127.0.0.1");
    track(upstream);
    // Замороженная пара молчит в обе стороны: данные не идут дальше, а
    // закрытие одной стороны не закрывает другую.
    const forward = (from: net.Socket, to: net.Socket) => {
      from.on("data", (chunk) => {
        if (!frozen.has(from)) to.write(chunk);
      });
      from.on("close", () => {
        if (!frozen.has(to)) to.destroy();
      });
    };
    forward(client, upstream);
    forward(upstream, client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: (server.address() as net.AddressInfo).port,
    connections: () => accepted,
    silence() {
      silent = true;
      for (const socket of sockets) freeze(socket);
    },
    restore() {
      silent = false;
      for (const socket of [...frozen]) socket.destroy();
      frozen.clear();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
