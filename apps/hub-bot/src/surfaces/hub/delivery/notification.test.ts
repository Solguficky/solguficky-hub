import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  ApplicationQueue,
  Circle,
  Preset,
} from "../../../../gen/identity/v1/access_pb.js";
import {
  MeetupLifecycle,
  MeetupVisibility,
} from "../../../../gen/meetups/v1/meetups_pb.js";
import {
  AccessGrantedSchema,
  AccessRequestedSchema,
  AuctionFinalLineupSchema,
  AuctionFinalStartedSchema,
  CircleChangedSchema,
  CommunityAnnouncementSchema,
  LotActivityKind,
  LotSetCollectedSchema,
  MeetupAspect,
  type MeetupCard,
  MeetupPublishedSchema,
  MeetupReminderSchema,
  type Notification,
  NotificationSchema,
  OrganizerMessageSchema,
  PresetGrantedSchema,
  ReleaseSummarySchema,
  StepWindowStartedSchema,
} from "../../../../gen/notifications/v1/notifications_pb.js";
import { decodeNotification } from "./notification.js";

const meetupId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cf";

// Готовое сообщение правится на месте: у oneof в форме инициализации нет
// частичного вида, а тесту нужна одна испорченная деталь, а не новый факт.
function published(
  adjust: (message: Notification) => void = () => {},
): Uint8Array {
  const message = create(NotificationSchema, {
    notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
    recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
    createdAt: "2026-09-26T10:00:00Z",
    requestId: "req-1",
    type: {
      case: "meetupPublished",
      value: {
        meetup: {
          id: meetupId,
          title: "Настолки у Лёши",
          venue: "Циферблат",
          schedule: {
            form: {
              case: "fixed",
              value: {
                precision: {
                  case: "dayStart",
                  value: {
                    date: { year: 2026, month: 8, day: 12 },
                    time: { hours: 19, minutes: 0 },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  adjust(message);
  return toBinary(NotificationSchema, message);
}

describe("decodeNotification", () => {
  // PER-537: понижение участника — весть бота хаба, её он и доставляет.
  it("decodes a demotion to a guest as its own branch", () => {
    expect(
      decodeNotification(
        published((message) => {
          message.type = {
            case: "circleChanged",
            value: create(CircleChangedSchema, {
              previousCircle: Circle.MEMBER,
              currentCircle: Circle.GUEST,
            }),
          };
        }),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: { content: { kind: "circle-demoted" } },
    });
  });

  // Повышение адресовано боту аукциона (PER-536) и в этот durable не попадает,
  // но разбирается как чужая ветка, а не как отказ.
  it("leaves a promotion to the auction bot", () => {
    expect(
      decodeNotification(
        published((message) => {
          message.type = {
            case: "circleChanged",
            value: create(CircleChangedSchema, {
              previousCircle: Circle.GUEST,
              currentCircle: Circle.MEMBER,
            }),
          };
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
      { previousCircle: Circle.UNSPECIFIED, currentCircle: Circle.GUEST },
    ],
    [
      "no current circle",
      { previousCircle: Circle.MEMBER, currentCircle: Circle.UNSPECIFIED },
    ],
  ])("treats a circle change with %s as malformed", (_name, value) => {
    expect(
      decodeNotification(
        published((message) => {
          message.type = {
            case: "circleChanged",
            value: create(CircleChangedSchema, value),
          };
        }),
      ),
    ).toEqual({ kind: "malformed", error: "invalid notification body" });
  });

  it("decodes a published meetup with its schedule and request id", () => {
    expect(decodeNotification(published())).toEqual({
      kind: "ok",
      notification: {
        notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
        recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        requestId: "req-1",
        content: {
          kind: "meetup-published",
          meetup: {
            id: meetupId,
            title: "Настолки у Лёши",
            venue: "Циферблат",
            kind: "",
            when: {
              kind: "day-start",
              tentative: false,
              at: { year: 2026, month: 8, day: 12, hours: 19, minutes: 0 },
            },
          },
        },
      },
    });
  });

  // Тип из схемы новее сборки доезжает неизвестным полем: у oneof тогда нет
  // выбранной ветки. Поле 99 с пустым значением — тег 99<<3|2 варинтом и длина 0.
  it("keeps a type the channel cannot render as an explicit variant", () => {
    const envelope = published((message) => {
      message.type = { case: undefined };
    });
    const decoded = decodeNotification(
      new Uint8Array([...envelope, 0x9a, 0x06, 0x00]),
    );
    expect(decoded).toMatchObject({
      kind: "ok",
      notification: { content: { kind: "unrendered", type: "unknown" } },
    });
  });

  // Аукционные факты участника теперь приходят в hub subject и разбираются
  // самим Hub Bot.
  it.each([
    [
      "lotOutbid",
      {
        case: "lotOutbid",
        value: {
          lotId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0",
          currentPrice: { minorUnits: 150_000n, currency: "RUB" },
        },
      },
    ],
    [
      "lotProxyRaised",
      {
        case: "lotProxyRaised",
        value: {
          lotId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0",
          currentPrice: { minorUnits: 150_000n, currency: "RUB" },
        },
      },
    ],
    [
      "lotPurchased",
      {
        case: "lotPurchased",
        value: {
          lotId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0",
          price: { minorUnits: 150_000n, currency: "RUB" },
        },
      },
    ],
    [
      "lotReminder",
      {
        case: "lotReminder",
        value: { lotId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0" },
      },
    ],
    [
      "lotLeadRestored",
      {
        case: "lotLeadRestored",
        value: {
          lotId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0",
          currentPrice: { minorUnits: 150_000n, currency: "RUB" },
        },
      },
    ],
  ] as const)(
    "decodes the auction branch %s for the hub recipient",
    (name, type) => {
      const decoded = decodeNotification(
        toBinary(
          NotificationSchema,
          create(NotificationSchema, {
            notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
            recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
            createdAt: "2026-09-26T10:00:00Z",
            type,
          }),
        ),
      );
      expect(decoded).toMatchObject({
        kind: "ok",
        notification: {
          content: {
            kind: {
              lotOutbid: "lot-outbid",
              lotProxyRaised: "lot-proxy-raised",
              lotPurchased: "lot-purchased",
              lotReminder: "lot-reminder",
              lotLeadRestored: "lot-lead-restored",
            }[name],
          },
        },
      });
    },
  );

  // Сводку окна частоты (PER-596) участнику доставляет бот хаба (PER-598).
  it("decodes an activity digest for the hub recipient", () => {
    const decoded = decodeNotification(
      toBinary(
        NotificationSchema,
        create(NotificationSchema, {
          notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
          recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
          createdAt: "2026-09-26T10:00:00Z",
          type: {
            case: "lotActivityDigest",
            value: {
              lines: [
                {
                  lotId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0",
                  kind: LotActivityKind.OUTBID,
                  currentPrice: { minorUnits: 150_000n, currency: "RUB" },
                  recipientLeads: false,
                },
              ],
            },
          },
        }),
      ),
    );
    expect(decoded).toMatchObject({
      kind: "ok",
      notification: { content: { kind: "lot-activity-digest" } },
    });
  });

  // Анонс финала (PER-478) участнику доставляет бот хаба, как вести о лотах
  // (ADR-064, п. 16): без разбора ветка ушла бы в отказ `unrendered_type`.
  it("decodes the final lineup and the started final for a community member", () => {
    const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
    const lotId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0";
    const fact = (type: Notification["type"]) =>
      decodeNotification(
        toBinary(
          NotificationSchema,
          create(NotificationSchema, {
            notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
            recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
            createdAt: "2026-09-26T10:00:00Z",
            type,
          }),
        ),
      );
    expect(
      fact({
        case: "auctionFinalLineup",
        value: create(AuctionFinalLineupSchema, {
          auctionId,
          lineup: [{ lotId, price: { minorUnits: 50_000n, currency: "RUB" } }],
          yourLotIds: [lotId],
        }),
      }),
    ).toMatchObject({
      kind: "ok",
      notification: {
        content: { kind: "final-lineup", auctionId, yourLotIds: [lotId] },
      },
    });
    expect(
      fact({
        case: "auctionFinalStarted",
        value: create(AuctionFinalStartedSchema, { auctionId }),
      }),
    ).toMatchObject({
      kind: "ok",
      notification: { content: { kind: "final-started", auctionId } },
    });
  });

  // Начало окна «Счастливых часов» (PER-616) участнику доставляет бот хаба,
  // как вести о лотах: без разбора ветка ушла бы в отказ `unrendered_type`.
  it("decodes the start of a window for a community member", () => {
    const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
    const lotId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0";
    expect(
      decodeNotification(
        toBinary(
          NotificationSchema,
          create(NotificationSchema, {
            notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
            recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
            createdAt: "2026-10-21T19:00:00Z",
            type: {
              case: "stepWindowStarted",
              value: create(StepWindowStartedSchema, {
                auctionId,
                startsAt: "2026-10-21T19:00:00Z",
                lots: [
                  {
                    lotId,
                    until: "2026-10-21T21:00:00Z",
                    step: { minorUnits: 50_000n, currency: "RUB" },
                  },
                ],
              }),
            },
          }),
        ),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: {
        content: {
          kind: "step-window-started",
          auctionId,
          lots: [
            {
              lotId,
              until: "2026-10-21T21:00:00Z",
              step: { minorUnits: 50_000, currency: "RUB" },
            },
          ],
        },
      },
    });
  });

  // Итог розыгрыша (PER-620) участнику доставляет бот хаба, как вести о лотах.
  describe("a raffle result", () => {
    const raffle = (value: {
      auctionId: string;
      ticket: number;
      winningTicket: number;
      ticketCount: number;
    }) =>
      decodeNotification(
        toBinary(
          NotificationSchema,
          create(NotificationSchema, {
            notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
            recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
            createdAt: "2026-09-26T10:00:00Z",
            type: { case: "raffleResult", value },
          }),
        ),
      );
    const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";

    it("decodes the recipient's ticket, the winning ticket and the pool", () => {
      expect(
        raffle({ auctionId, ticket: 3, winningTicket: 7, ticketCount: 12 }),
      ).toMatchObject({
        kind: "ok",
        notification: {
          content: {
            kind: "raffle-result",
            auctionId,
            ticket: 3,
            winningTicket: 7,
            ticketCount: 12,
          },
        },
      });
    });

    it("rejects a ticket outside the pool", () => {
      expect(
        raffle({ auctionId, ticket: 13, winningTicket: 7, ticketCount: 12 }),
      ).toMatchObject({ kind: "malformed" });
    });
  });

  // Собранный сет (PER-687) доставляется ботом круга получателя.
  it("decodes a collected set with its screen anchor", () => {
    const anchor = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0";
    expect(
      decodeNotification(
        published((message) => {
          message.type = {
            case: "lotSetCollected",
            value: create(LotSetCollectedSchema, {
              setName: "Сервиз",
              lotCount: 3,
              lotId: anchor,
            }),
          };
        }),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: {
        content: {
          kind: "lot-set-collected",
          setName: "Сервиз",
          lotCount: 3,
          lotId: anchor,
        },
      },
    });
  });

  // Итоги прогнозов (PER-568) участнику доставляет бот хаба.
  it("decodes prediction results as the thin notice", () => {
    const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
    expect(
      decodeNotification(
        toBinary(
          NotificationSchema,
          create(NotificationSchema, {
            notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
            recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
            createdAt: "2026-09-26T10:00:00Z",
            type: { case: "predictionResults", value: { auctionId } },
          }),
        ),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: {
        content: { kind: "prediction-results", auctionId },
      },
    });
  });

  // Извещение об отмене аукциона (PER-606) участнику доставляет бот хаба.
  it("decodes a cancelled auction with the purchases of the recipient", () => {
    const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
    expect(
      decodeNotification(
        toBinary(
          NotificationSchema,
          create(NotificationSchema, {
            notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
            recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
            createdAt: "2026-09-26T10:00:00Z",
            type: {
              case: "auctionCancelled",
              value: {
                auctionId,
                meetupId: "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
              },
            },
          }),
        ),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: {
        content: { kind: "auction-cancelled", auctionId, purchases: [] },
      },
    });
  });

  // Вести о новом аукционе и об открытии торгов (PER-646) участнику доставляет
  // бот хаба; гостю те же ветки приходят в боте аукциона.
  it("decodes a published auction and the opening of its trading", () => {
    const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
    const meetupId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60";
    const decode = (type: "auctionPublished" | "auctionTradingOpened") =>
      decodeNotification(
        toBinary(
          NotificationSchema,
          create(NotificationSchema, {
            notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
            recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
            createdAt: "2026-09-26T10:00:00Z",
            type:
              type === "auctionPublished"
                ? {
                    case: "auctionPublished",
                    value: { auctionId, meetupId, meetupTitle: "Пятничная" },
                  }
                : {
                    case: "auctionTradingOpened",
                    value: { auctionId, meetupId, meetupTitle: "Пятничная" },
                  },
          }),
        ),
      );

    expect(decode("auctionPublished")).toMatchObject({
      kind: "ok",
      notification: {
        content: { kind: "new-auction", auctionId, meetupTitle: "Пятничная" },
      },
    });
    expect(decode("auctionTradingOpened")).toMatchObject({
      kind: "ok",
      notification: {
        content: {
          kind: "trading-opened",
          auctionId,
          meetupTitle: "Пятничная",
        },
      },
    });
  });

  describe("a manual broadcast", () => {
    const senderId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce";
    // Сходка берётся из готового факта о публикации: карточка у сообщения
    // организатора та же, что у любого факта о сходке.
    const organizer = (body: string, withMeetup = true): Uint8Array =>
      published((message) => {
        if (message.type.case !== "meetupPublished") return;
        message.type = {
          case: "organizerMessage",
          value: create(OrganizerMessageSchema, {
            ...(withMeetup ? { meetup: message.type.value.meetup } : {}),
            senderId,
            body,
          }),
        };
      });
    const announcement = (body: string): Uint8Array =>
      published((message) => {
        message.type = {
          case: "communityAnnouncement",
          value: create(CommunityAnnouncementSchema, { senderId, body }),
        };
      });

    it("decodes an organizer message with its meetup and the verbatim body", () => {
      expect(
        decodeNotification(organizer("  Берите\nнастолки  ")),
      ).toMatchObject({
        kind: "ok",
        notification: {
          content: {
            kind: "organizer-message",
            meetup: { id: meetupId, title: "Настолки у Лёши" },
            body: "  Берите\nнастолки  ",
          },
        },
      });
    });

    it("decodes a community announcement without a meetup", () => {
      expect(decodeNotification(announcement("Сбор в пятницу"))).toMatchObject({
        kind: "ok",
        notification: {
          content: { kind: "community-announcement", body: "Сбор в пятницу" },
        },
      });
    });

    // Контракт запрещает только пустую строку: тело из пробелов уходит под
    // заголовком, и Telegram его примет.
    it("rejects an empty body", () => {
      expect(decodeNotification(announcement("")).kind).toBe("malformed");
      expect(decodeNotification(organizer("")).kind).toBe("malformed");
    });

    it("keeps a body of whitespace as written", () => {
      expect(decodeNotification(announcement(" \n "))).toMatchObject({
        kind: "ok",
        notification: { content: { body: " \n " } },
      });
    });

    it("rejects an organizer message without its meetup", () => {
      expect(decodeNotification(organizer("Берите настолки", false)).kind).toBe(
        "malformed",
      );
    });
  });

  describe("a reminder", () => {
    const reminder = (drop = false): Uint8Array =>
      published((message) => {
        if (message.type.case !== "meetupPublished") return;
        message.type = {
          case: "meetupReminder",
          value: create(MeetupReminderSchema, {
            meetup: drop ? undefined : message.type.value.meetup,
          }),
        };
      });

    it("carries the meetup it reminds about with its schedule", () => {
      expect(decodeNotification(reminder())).toMatchObject({
        kind: "ok",
        notification: {
          content: {
            kind: "meetup-reminder",
            meetup: {
              id: meetupId,
              title: "Настолки у Лёши",
              venue: "Циферблат",
              when: {
                kind: "day-start",
                at: { year: 2026, month: 8, day: 12, hours: 19, minutes: 0 },
              },
            },
          },
        },
      });
    });

    it("rejects a reminder without a meetup card", () => {
      expect(decodeNotification(reminder(true))).toEqual({
        kind: "malformed",
        error: "invalid notification body",
      });
    });
  });

  describe("a change", () => {
    const changed = (
      aspects: MeetupAspect[],
      card: Partial<MeetupCard> = {},
    ): Uint8Array =>
      published((message) => {
        if (message.type.case !== "meetupPublished") return;
        const meetup = message.type.value.meetup;
        message.type = {
          case: "meetupChanged",
          value: {
            $typeName: "notifications.v1.MeetupChanged",
            meetup: meetup === undefined ? meetup : { ...meetup, ...card },
            changedAspects: aspects,
          },
        };
      });
    const planned = {
      lifecycle: MeetupLifecycle.PLANNED,
      visibility: MeetupVisibility.VISIBLE,
    };

    it("carries what changed and the state of the meetup now", () => {
      const decoded = decodeNotification(
        changed([MeetupAspect.VENUE, MeetupAspect.LIFECYCLE], {
          lifecycle: MeetupLifecycle.CANCELLED,
          visibility: MeetupVisibility.VISIBLE,
        }),
      );
      expect(decoded).toMatchObject({
        kind: "ok",
        notification: {
          content: {
            kind: "meetup-changed",
            meetup: { id: meetupId, venue: "Циферблат" },
            aspects: ["venue", "lifecycle"],
            lifecycle: "cancelled",
            visibility: "visible",
          },
        },
      });
    });

    // Контракт обещает непустой список без UNSPECIFIED: иначе канал не знает,
    // о чём сообщать, и это дефект издателя, а не повод для пустого текста.
    it("rejects an empty or unspecified aspect list", () => {
      expect(decodeNotification(changed([], planned)).kind).toBe("malformed");
      expect(
        decodeNotification(changed([MeetupAspect.UNSPECIFIED], planned)).kind,
      ).toBe("malformed");
    });

    it("rejects a card without its state", () => {
      expect(decodeNotification(changed([MeetupAspect.TITLE])).kind).toBe(
        "malformed",
      );
    });

    // Аспект из схемы новее этой сборки — не дефект: изменение случилось, и
    // доставка не должна падать из-за того, что канал отстал от контракта.
    it("keeps an aspect from a newer schema as another detail", () => {
      const decoded = decodeNotification(
        changed([MeetupAspect.TITLE, 99 as MeetupAspect], planned),
      );
      expect(decoded).toMatchObject({
        kind: "ok",
        notification: { content: { aspects: ["title", "other"] } },
      });
    });
  });

  it("decodes new material with its title", () => {
    const decoded = decodeNotification(
      published((message) => {
        if (message.type.case !== "meetupPublished") return;
        message.type = {
          case: "meetupMaterial",
          value: {
            $typeName: "notifications.v1.MeetupMaterial",
            meetup: message.type.value.meetup,
            materialId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0",
            materialTitle: "Правила",
          },
        };
      }),
    );
    expect(decoded).toMatchObject({
      kind: "ok",
      notification: {
        content: { kind: "meetup-material", materialTitle: "Правила" },
      },
    });
  });

  it("decodes an unpublished meetup", () => {
    const decoded = decodeNotification(
      published((message) => {
        if (message.type.case !== "meetupPublished") return;
        message.type = {
          case: "meetupUnpublished",
          value: {
            $typeName: "notifications.v1.MeetupUnpublished",
            meetup: message.type.value.meetup,
          },
        };
      }),
    );
    expect(decoded).toMatchObject({
      kind: "ok",
      notification: {
        content: { kind: "meetup-unpublished", meetup: { id: meetupId } },
      },
    });
  });

  it("parses the deadline", () => {
    const decoded = decodeNotification(
      published((message) => {
        message.notAfter = "2026-09-27T10:00:00Z";
      }),
    );
    expect(decoded.kind === "ok" && decoded.notification.notAfter).toEqual(
      new Date("2026-09-27T10:00:00Z"),
    );
  });

  it("rejects a notification without a recipient or an id", () => {
    const without = (field: "recipientId" | "notificationId") =>
      decodeNotification(
        published((message) => {
          message[field] = "";
        }),
      ).kind;
    expect(without("recipientId")).toBe("malformed");
    expect(without("notificationId")).toBe("malformed");
  });

  // Пустой oneof расписания — не «без даты», а нарушение контракта: форма
  // no_date существует для этого отдельно.
  it("rejects a published meetup without a schedule form", () => {
    const decoded = decodeNotification(
      published((message) => {
        message.type = {
          case: "meetupPublished",
          value: create(MeetupPublishedSchema, {
            meetup: { id: meetupId, title: "x", schedule: {} },
          }),
        };
      }),
    );
    expect(decoded.kind).toBe("malformed");
  });

  it("rejects bytes that are not a notification", () => {
    expect(decodeNotification(new Uint8Array([0xff, 0xff, 0xff])).kind).toBe(
      "malformed",
    );
  });

  describe("access requests", () => {
    const requested = (queue: ApplicationQueue): Uint8Array =>
      published((message) => {
        message.type = {
          case: "accessRequested",
          value: create(AccessRequestedSchema, { queue }),
        };
      });

    it.each([
      [ApplicationQueue.COMMUNITY, "community"],
      [ApplicationQueue.AUCTION, "auction"],
    ] as const)("decodes a request in queue %s", (queue, expected) => {
      expect(decodeNotification(requested(queue))).toMatchObject({
        kind: "ok",
        notification: {
          content: { kind: "access-requested", queue: expected },
        },
      });
    });

    const withCursor = (applicationId: string, createdAt: string) =>
      published((message) => {
        message.type = {
          case: "accessRequested",
          value: create(AccessRequestedSchema, {
            queue: ApplicationQueue.COMMUNITY,
            applicationId,
            createdAt,
          }),
        };
      });

    // Курсор заявки — то, по чему бот прочитает её карточку (PER-634).
    it("decodes the application cursor", () => {
      expect(
        decodeNotification(
          withCursor(
            "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3903",
            "2026-10-12T18:05:07.040Z",
          ),
        ),
      ).toMatchObject({
        kind: "ok",
        notification: {
          content: {
            kind: "access-requested",
            queue: "community",
            application: {
              applicationId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3903",
              createdAtMs: Date.UTC(2026, 9, 12, 18, 5, 7, 40),
            },
          },
        },
      });
    });

    // Факт старше курсора или с неразборчивым курсором остаётся поводом:
    // модератор теряет тело заявки, но не весть о ней.
    it.each([
      ["", ""],
      ["0198F2A4-7C1E-7D3A-9B21-4F8E12AB3903", "2026-10-12T18:05:07.040Z"],
      ["not-a-uuid", "2026-10-12T18:05:07.040Z"],
      ["0198f2a4-7c1e-7d3a-9b21-4f8e12ab3903", ""],
      ["0198f2a4-7c1e-7d3a-9b21-4f8e12ab3903", "yesterday"],
      ["0198f2a4-7c1e-7d3a-9b21-4f8e12ab3903", "2026-10-12T18:05:07Z"],
      ["0198f2a4-7c1e-7d3a-9b21-4f8e12ab3903", "2026-10-12T21:05:07.040+03:00"],
    ])("decodes a request without a readable cursor (%s, %s)", (id, at) => {
      const decoded = decodeNotification(withCursor(id, at));
      expect(decoded).toMatchObject({
        kind: "ok",
        notification: { content: { kind: "access-requested" } },
      });
      expect(
        decoded.kind === "ok" && "application" in decoded.notification.content,
      ).toBe(false);
    });

    // Без очереди некуда вести модератора: это дефект издателя, а не повод
    // звать администратора.
    it("rejects a request without a queue", () => {
      expect(
        decodeNotification(requested(ApplicationQueue.UNSPECIFIED)).kind,
      ).toBe("malformed");
    });
  });

  describe("access grants", () => {
    const granted = (queue: ApplicationQueue): Uint8Array =>
      published((message) => {
        message.type = {
          case: "accessGranted",
          value: create(AccessGrantedSchema, { queue }),
        };
      });

    it("decodes an admission to the hub as its own branch", () => {
      expect(
        decodeNotification(granted(ApplicationQueue.COMMUNITY)),
      ).toMatchObject({
        kind: "ok",
        notification: { content: { kind: "access-granted" } },
      });
    });

    // Допуск в аукцион доставляет бот аукциона: для хаба это чужая ветка,
    // которую он подтверждает без журнала и без отказа.
    it("leaves an admission to the auction to the auction bot", () => {
      expect(
        decodeNotification(granted(ApplicationQueue.AUCTION)),
      ).toMatchObject({
        kind: "ok",
        notification: { content: { kind: "foreign", type: "accessGranted" } },
      });
    });

    it("rejects an admission without a queue", () => {
      expect(
        decodeNotification(granted(ApplicationQueue.UNSPECIFIED)).kind,
      ).toBe("malformed");
    });
  });

  describe("preset granted", () => {
    const presetGranted = (preset: Preset): Uint8Array =>
      published((message) => {
        message.type = {
          case: "presetGranted",
          value: create(PresetGrantedSchema, { preset }),
        };
      });

    it("decodes the administrator preset as its own branch", () => {
      expect(decodeNotification(presetGranted(Preset.ADMIN))).toMatchObject({
        kind: "ok",
        notification: { content: { kind: "preset-granted", preset: "admin" } },
      });
    });

    // Notifications шлёт ветку только для набора администратора: иной набор —
    // дефект издателя, а не весть, которую можно показать.
    it.each([Preset.MAINTAINER, Preset.UNSPECIFIED])(
      "rejects a grant of preset %s",
      (preset) => {
        expect(decodeNotification(presetGranted(preset)).kind).toBe(
          "malformed",
        );
      },
    );
  });

  it("decodes a release summary as record ids without their text", () => {
    const summaryId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401";
    expect(
      decodeNotification(
        published((message) => {
          message.type = {
            case: "releaseSummary",
            value: create(ReleaseSummarySchema, {
              summaryId,
              summarizedAt: "2026-10-14T12:00:00Z",
              recordIds: ["known"],
            }),
          };
        }),
      ),
    ).toMatchObject({
      kind: "ok",
      notification: {
        content: {
          kind: "release-summary",
          summaryId,
          summarizedAt: "2026-10-14T12:00:00Z",
          recordIds: ["known"],
        },
      },
    });
  });
});
