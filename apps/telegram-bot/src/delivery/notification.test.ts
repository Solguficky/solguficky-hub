import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  MeetupLifecycle,
  MeetupVisibility,
} from "../../gen/meetups/v1/meetups_pb.js";
import {
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

  it("keeps a type the channel cannot render as an explicit variant", () => {
    const decoded = decodeNotification(
      published((message) => {
        message.type = {
          case: "organizerMessage",
          value: create(OrganizerMessageSchema),
        };
      }),
    );
    expect(decoded).toMatchObject({
      kind: "ok",
      notification: {
        content: { kind: "unrendered", type: "organizerMessage" },
      },
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
});
