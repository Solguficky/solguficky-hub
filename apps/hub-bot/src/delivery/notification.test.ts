import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { GlobalRole } from "../../gen/identity/v1/roles_pb.js";
import {
  MeetupLifecycle,
  MeetupVisibility,
} from "../../gen/meetups/v1/meetups_pb.js";
import {
  AccessGrantedSchema,
  AccessRequestedSchema,
  CommunityAnnouncementSchema,
  MeetupAspect,
  type MeetupCard,
  MeetupPublishedSchema,
  MeetupReminderSchema,
  type Notification,
  NotificationSchema,
  OrganizerMessageSchema,
} from "../../gen/notifications/v1/notifications_pb.js";
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

  // Ветку бота аукциона хаб узнаёт и отдаёт механике как чужую: общий поток
  // несёт её каждому каналу, и это не отказ.
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
      "lotPurchased",
      {
        case: "lotPurchased",
        value: {
          lotId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0",
          price: { minorUnits: 150_000n, currency: "RUB" },
        },
      },
    ],
  ] as const)(
    "hands the auction branch %s over as another channel's",
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
        notification: { content: { kind: "foreign", type: name } },
      });
    },
  );

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
    const requested = (circle: GlobalRole): Uint8Array =>
      published((message) => {
        message.type = {
          case: "accessRequested",
          value: create(AccessRequestedSchema, { circle }),
        };
      });

    it.each([
      [GlobalRole.MEMBER, "member"],
      [GlobalRole.PUBLIC, "public"],
    ] as const)("decodes a request for circle %s", (circle, expected) => {
      expect(decodeNotification(requested(circle))).toMatchObject({
        kind: "ok",
        notification: {
          content: { kind: "access-requested", circle: expected },
        },
      });
    });

    // Заявку ставят только на круги поверхностей: другой круг — дефект
    // издателя, а не повод звать администратора.
    it.each([GlobalRole.ADMIN, GlobalRole.MAINTAINER, GlobalRole.UNSPECIFIED])(
      "rejects a request for circle %s",
      (circle) => {
        expect(decodeNotification(requested(circle)).kind).toBe("malformed");
      },
    );
  });

  describe("access grants", () => {
    const granted = (circle: GlobalRole): Uint8Array =>
      published((message) => {
        message.type = {
          case: "accessGranted",
          value: create(AccessGrantedSchema, { circle }),
        };
      });

    it("decodes an admission to the hub as its own branch", () => {
      expect(decodeNotification(granted(GlobalRole.MEMBER))).toMatchObject({
        kind: "ok",
        notification: { content: { kind: "access-granted" } },
      });
    });

    // Допуск в аукцион доставляет бот аукциона: для хаба это чужая ветка,
    // которую он подтверждает без журнала и без отказа.
    it("leaves an admission to the auction to the auction bot", () => {
      expect(decodeNotification(granted(GlobalRole.PUBLIC))).toMatchObject({
        kind: "ok",
        notification: { content: { kind: "foreign", type: "accessGranted" } },
      });
    });

    it.each([GlobalRole.ADMIN, GlobalRole.UNSPECIFIED])(
      "rejects an admission to circle %s",
      (circle) => {
        expect(decodeNotification(granted(circle)).kind).toBe("malformed");
      },
    );
  });
});
