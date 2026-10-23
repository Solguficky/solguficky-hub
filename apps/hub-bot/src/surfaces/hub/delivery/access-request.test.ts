import { describe, expect, it, vi } from "vitest";
import type {
  ApplicationCard,
  ApplicationQueueRead,
  IdentityAdminResult,
} from "../identity/port.js";
import {
  createAccessRequestRender,
  type ReadApplicationQueue,
} from "./access-request.js";

const applicationId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3903";
const createdAtMs = Date.UTC(2026, 9, 12, 18, 5, 7, 40);
const shownAtMs = createdAtMs + 60_000;
const recipientId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3905";

const content = {
  kind: "access-requested",
  queue: "community",
  application: { applicationId, createdAtMs },
} as const;

function card(id: string): ApplicationCard {
  return {
    applicationId: id,
    identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3904",
    telegramUserId: 7110n,
    circle: "member",
    source: { kind: "none" },
    createdAtMs,
  };
}

function render(result: IdentityAdminResult<ApplicationQueueRead>) {
  const read = vi.fn<ReadApplicationQueue>().mockResolvedValue(result);
  const onBodyMissing = vi.fn();
  const run = createAccessRequestRender({
    read,
    now: () => shownAtMs,
    onBodyMissing,
  });
  return { read, run, onBodyMissing };
}

describe("access request render", () => {
  // Курсор «эта же, если открыта»: тот же момент и предшествующий UUID — по
  // нему Identity отдаёт заявку первой (PER-634).
  it("reads the queue as the recipient from just before the application", async () => {
    const { read, run } = render({ kind: "ok", value: { total: 0 } });

    await run(content, { recipientId, requestId: "req-1" });

    expect(read).toHaveBeenCalledWith(
      recipientId,
      "community",
      {
        createdAtMs,
        applicationId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3902",
      },
      "req-1",
    );
  });

  it("shows the card while the application is open", async () => {
    const { run } = render({
      kind: "ok",
      value: {
        card: { application: card(applicationId), position: 1 },
        total: 1,
      },
    });

    await expect(run(content, { recipientId })).resolves.toEqual({
      kind: "ready",
      message: {
        kind: "access-request-card",
        queue: "community",
        application: card(applicationId),
        shownAtMs,
      },
    });
  });

  // Решённая заявка из очереди уходит: на её месте следующая или ничего.
  it.each([
    [
      "the next application",
      {
        card: {
          application: card("0198f2a4-7c1e-7d3a-9b21-4f8e12ab3999"),
          position: 1,
        },
        total: 1,
      },
    ],
    ["nothing", { total: 0 }],
  ])(
    "says the application was decided when the queue gives %s",
    async (_, value) => {
      const { run } = render({ kind: "ok", value });

      await expect(run(content, { recipientId })).resolves.toEqual({
        kind: "ready",
        message: { kind: "access-request-decided", queue: "community" },
      });
    },
  );

  // Потерявший право очереди узнаёт о заявке, но тела не видит: штатный
  // исход, в лог он не пишется.
  it("sends the bare request to a recipient without the queue right", async () => {
    const { run, onBodyMissing } = render({ kind: "forbidden" });

    await expect(run(content, { recipientId })).resolves.toEqual({
      kind: "ready",
      message: { kind: "access-requested", queue: "community" },
    });
    expect(onBodyMissing).not.toHaveBeenCalled();
  });

  // Сбой чтения тела не роняет повод: повтор на отказе, который повтор не
  // изменит, потерял бы оповещение целиком. Деградация видна в логе.
  it.each([
    ["invalid", { kind: "invalid" }],
    ["unavailable", { kind: "unavailable", cause: new Error("down") }],
  ] as const)(
    "sends the bare request and reports a %s read",
    async (_, result) => {
      const { run, onBodyMissing } = render(result);

      await expect(
        run(content, { recipientId, requestId: "req-2" }),
      ).resolves.toEqual({
        kind: "ready",
        message: { kind: "access-requested", queue: "community" },
      });
      expect(onBodyMissing).toHaveBeenCalledWith(result, "req-2");
    },
  );

  it("sends a request without a cursor as it came, without reading", async () => {
    const { read, run } = render({ kind: "ok", value: { total: 0 } });
    const bare = { kind: "access-requested", queue: "auction" } as const;

    await expect(run(bare, { recipientId })).resolves.toEqual({
      kind: "ready",
      message: bare,
    });
    expect(read).not.toHaveBeenCalled();
  });
});
