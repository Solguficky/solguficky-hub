import { connect, createServer, type Server } from "node:net";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "../../../../apps/telegram-bot/testkit/index.js";
import { openDelayProxy } from "./latency.js";

// L0: прокси задержки пульта против эхо-сервера на localhost. Контур ему не
// нужен: он двигает байты и ничего не знает ни о gRPC, ни о сервисах.

let echo: Server;
let echoUrl: string;

beforeAll(async () => {
  echo = createServer((socket) => {
    socket.pipe(socket);
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((listening) => {
    echo.listen(0, "127.0.0.1", listening);
  });
  const address = echo.address();
  if (address === null || typeof address === "string") {
    throw new Error("эхо-сервер не получил порт");
  }
  echoUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((closed) => {
    echo.close(() => closed());
  });
});

/** Пишет куски в прокси и возвращает эхо и время до последнего байта. */
function roundTrip(
  url: string,
  chunks: readonly string[],
): Promise<{ echoed: string; tookMs: number }> {
  const expected = chunks.join("").length;
  return new Promise((resolveEchoed, rejectEchoed) => {
    const startedAt = performance.now();
    const socket = connect(Number(new URL(url).port), "127.0.0.1");
    let echoed = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      echoed += chunk;
      if (echoed.length >= expected) {
        socket.destroy();
        resolveEchoed({ echoed, tookMs: performance.now() - startedAt });
      }
    });
    socket.on("error", rejectEchoed);
    socket.on("connect", () => {
      for (const chunk of chunks) socket.write(chunk);
    });
  });
}

describe("openDelayProxy", () => {
  it("passes bytes through unchanged without a delay", async () => {
    const proxy = await openDelayProxy(echoUrl);
    try {
      const { echoed } = await roundTrip(proxy.url, ["раз", "два"]);
      expect(echoed).toBe("раздва");
    } finally {
      await proxy.close();
    }
  });

  it("holds bytes for the delay and keeps their order", async () => {
    const proxy = await openDelayProxy(echoUrl);
    try {
      proxy.setDelay(150);
      const { echoed, tookMs } = await roundTrip(proxy.url, ["a", "b", "c"]);
      expect(echoed).toBe("abc");
      // Нижняя граница с запасом на округление таймера; верхней нет — под
      // нагрузкой таймер опаздывает, и тест не должен на этом мигать.
      expect(tookMs).toBeGreaterThanOrEqual(140);
    } finally {
      await proxy.close();
    }
  });

  it("delivers held bytes after the client closes its side", async () => {
    const received: string[] = [];
    const sink = createServer({ allowHalfOpen: true }, (socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => received.push(chunk));
      socket.on("end", () => socket.end("ответ"));
      socket.on("error", () => socket.destroy());
    });
    await new Promise<void>((listening) => {
      sink.listen(0, "127.0.0.1", listening);
    });
    const address = sink.address();
    if (address === null || typeof address === "string") {
      throw new Error("приёмник не получил порт");
    }
    const proxy = await openDelayProxy(`http://127.0.0.1:${address.port}`);
    try {
      proxy.setDelay(100);
      const reply = await new Promise<string>((resolveReply, rejectReply) => {
        const socket = connect({
          port: Number(new URL(proxy.url).port),
          host: "127.0.0.1",
          allowHalfOpen: true,
        });
        let text = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          text += chunk;
        });
        socket.on("end", () => {
          socket.destroy();
          resolveReply(text);
        });
        socket.on("error", rejectReply);
        socket.on("connect", () => socket.end("запрос"));
      });

      expect(received.join("")).toBe("запрос");
      expect(reply).toBe("ответ");
    } finally {
      await proxy.close();
      await new Promise<void>((closed) => {
        sink.close(() => closed());
      });
    }
  });

  it("rejects a service behind tls", async () => {
    await expect(openDelayProxy("https://127.0.0.1:1")).rejects.toThrow(
      /только http/,
    );
  });
});
