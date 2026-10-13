import { create, type MessageInitShape, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  ApplicationQueue,
  Circle,
  Preset,
} from "../../../../gen/identity/v1/access_pb.js";
import {
  LotActivityKind,
  NotificationSchema,
} from "../../../../gen/notifications/v1/notifications_pb.js";
import { decodeNotification } from "./notification.js";

const lotId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0";
const price = { minorUnits: 150_000n, currency: "RUB" };

function fact(
  type: NonNullable<MessageInitShape<typeof NotificationSchema>["type"]>,
): Uint8Array {
  return toBinary(
    NotificationSchema,
    create(NotificationSchema, {
      notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
      recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
      createdAt: "2026-10-04T10:00:00Z",
      requestId: "req-1",
      type,
    }),
  );
}

describe("decodeNotification", () => {
  // PER-537: повышение гостя — весть бота аукциона, её он и доставляет.
  it("decodes a promotion to the community as its own branch", () => {
    expect(
      decodeNotification(
        fact({
          case: "circleChanged",
          value: {
            previousCircle: Circle.GUEST,
            currentCircle: Circle.MEMBER,
          },
        }),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: { content: { kind: "circle-promoted" } },
    });
  });

  // Понижение адресовано боту хаба (PER-536) и в этот durable не попадает, но
  // разбирается как чужая ветка, а не как отказ.
  it("leaves a demotion to the hub bot", () => {
    expect(
      decodeNotification(
        fact({
          case: "circleChanged",
          value: {
            previousCircle: Circle.MEMBER,
            currentCircle: Circle.GUEST,
          },
        }),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: { content: { kind: "foreign", type: "circleChanged" } },
    });
  });

  // Пару кругов вне `guest ↔ member` издатель не рождает: показывать в ней
  // нечего, и это дефект, а не весть.
  it.each([
    [
      "no previous circle",
      { previousCircle: Circle.UNSPECIFIED, currentCircle: Circle.MEMBER },
    ],
    [
      "no current circle",
      { previousCircle: Circle.GUEST, currentCircle: Circle.UNSPECIFIED },
    ],
  ])("treats a circle change with %s as malformed", (_name, value) => {
    expect(decodeNotification(fact({ case: "circleChanged", value }))).toEqual({
      kind: "malformed",
      error: "invalid notification body",
    });
  });

  // Сводка окна частоты (PER-596) — ветка этого бота с PER-598: до неё она
  // уходила в `unrendered_type`.
  it("decodes an activity digest with every line", () => {
    expect(
      decodeNotification(
        fact({
          case: "lotActivityDigest",
          value: {
            lines: [
              {
                lotId,
                kind: LotActivityKind.OUTBID,
                currentPrice: price,
                recipientLeads: true,
              },
              {
                lotId,
                kind: LotActivityKind.PROXY_RAISED,
                currentPrice: price,
                recipientLeads: false,
              },
            ],
          },
        }),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: {
        content: {
          kind: "lot-activity-digest",
          lines: [
            {
              lotId,
              kind: "outbid",
              currentPrice: { minorUnits: 150_000, currency: "RUB" },
              recipientLeads: true,
            },
            {
              lotId,
              kind: "proxy-raised",
              currentPrice: { minorUnits: 150_000, currency: "RUB" },
              recipientLeads: false,
            },
          ],
        },
      },
    });
  });

  // Сводку без строк и строку без вида или с битым лотом издатель не рождает.
  it.each([
    ["no lines", []],
    [
      "a line of no kind",
      [
        {
          lotId,
          kind: LotActivityKind.UNSPECIFIED,
          currentPrice: price,
          recipientLeads: false,
        },
      ],
    ],
    [
      "a line with a broken lot",
      [
        {
          lotId: "lot-1",
          kind: LotActivityKind.OUTBID,
          currentPrice: price,
          recipientLeads: false,
        },
      ],
    ],
  ])("treats an activity digest with %s as malformed", (_name, lines) => {
    expect(
      decodeNotification(fact({ case: "lotActivityDigest", value: { lines } })),
    ).toEqual({ kind: "malformed", error: "invalid notification body" });
  });

  it("decodes an outbid fact with the lot and the current price", () => {
    expect(
      decodeNotification(
        fact({ case: "lotOutbid", value: { lotId, currentPrice: price } }),
      ),
    ).toEqual({
      kind: "ok",
      notification: {
        notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
        recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        requestId: "req-1",
        content: {
          kind: "lot-outbid",
          lotId,
          currentPrice: { minorUnits: 150_000, currency: "RUB" },
        },
      },
    });
  });

  it("decodes a proxy raise with the lot and the current price", () => {
    expect(
      decodeNotification(
        fact({ case: "lotProxyRaised", value: { lotId, currentPrice: price } }),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: {
        content: {
          kind: "lot-proxy-raised",
          lotId,
          currentPrice: { minorUnits: 150_000, currency: "RUB" },
        },
      },
    });
  });

  it("decodes a purchase fact with the sale price", () => {
    expect(
      decodeNotification(
        fact({ case: "lotPurchased", value: { lotId, price } }),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: {
        content: {
          kind: "lot-purchased",
          lotId,
          price: { minorUnits: 150_000, currency: "RUB" },
        },
      },
    });
  });

  // Общий поток несёт ветки бота хаба и сюда: это не отказ.
  it("hands a meetup branch over as another channel's", () => {
    expect(
      decodeNotification(
        fact({ case: "communityAnnouncement", value: { body: "Сбор" } }),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: {
        content: { kind: "foreign", type: "communityAnnouncement" },
      },
    });
  });

  it("decodes an admission to the auction as its own branch", () => {
    expect(
      decodeNotification(
        fact({
          case: "accessGranted",
          value: { queue: ApplicationQueue.AUCTION },
        }),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: { content: { kind: "access-granted" } },
    });
  });

  // Права администратора сообщества доставляет бот хаба (PER-468).
  it("leaves a granted preset to the hub bot", () => {
    expect(
      decodeNotification(
        fact({ case: "presetGranted", value: { preset: Preset.ADMIN } }),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: { content: { kind: "foreign", type: "presetGranted" } },
    });
  });

  // Допуск в хаб доставляет бот хаба: здесь это чужая ветка, а не отказ.
  it("leaves an admission to the hub to the hub bot", () => {
    expect(
      decodeNotification(
        fact({
          case: "accessGranted",
          value: { queue: ApplicationQueue.COMMUNITY },
        }),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: { content: { kind: "foreign", type: "accessGranted" } },
    });
  });

  it("rejects an admission without a queue", () => {
    expect(
      decodeNotification(
        fact({
          case: "accessGranted",
          value: { queue: ApplicationQueue.UNSPECIFIED },
        }),
      ).kind,
    ).toBe("malformed");
  });

  it("keeps a branch it does not know as an explicit variant", () => {
    expect(decodeNotification(fact({ case: undefined }))).toMatchObject({
      kind: "ok",
      notification: { content: { kind: "unrendered", type: "unknown" } },
    });
  });

  // Без лота кнопку не собрать, без суммы цену не назвать: это дефект
  // издателя, а не повод показать человеку полуфакт.
  it.each([
    ["a lot id that is not canonical", { lotId: "lot-1", currentPrice: price }],
    ["no price", { lotId }],
    [
      "a price without currency",
      { lotId, currentPrice: { minorUnits: 1n, currency: "" } },
    ],
    [
      "a currency that is not an ISO 4217 code",
      { lotId, currentPrice: { minorUnits: 1n, currency: "R" } },
    ],
  ])("treats an outbid fact with %s as malformed", (_name, value) => {
    expect(
      decodeNotification(fact({ case: "lotOutbid", value: value as never })),
    ).toEqual({ kind: "malformed", error: "invalid notification body" });
  });

  it("treats bytes that are not a notification as malformed", () => {
    expect(decodeNotification(new Uint8Array([0xff, 0xff]))).toMatchObject({
      kind: "malformed",
    });
  });
});
