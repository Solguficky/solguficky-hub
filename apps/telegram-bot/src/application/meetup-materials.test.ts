import { describe, expect, it, vi } from "vitest";
import type { MeetupSnapshot, Meetups } from "../meetups/port.js";
import { createMeetupMaterials } from "./meetup-materials.js";

const person = { identityId: "person-id", globalRoles: ["admin"] };
const meetup: MeetupSnapshot = {
  id: "meetup-id",
  title: "Настолки",
  description: "",
  venue: "",
  lifecycle: "planned",
  visibility: "visible",
  author: "0192f0a0-0000-7000-8000-00000000a001",
  version: 1,
  materials: [],
};

describe("meetup materials", () => {
  it("attaches a material through the port and returns the updated meetup", async () => {
    const attachMaterial = vi.fn(async () => ({
      kind: "ok" as const,
      meetup: {
        ...meetup,
        materials: [
          {
            id: "material-id",
            title: "Опрос",
            source: {
              kind: "message-link" as const,
              url: "https://t.me/c/42/7",
            },
          },
        ],
      },
    }));
    const materials = createMeetupMaterials({
      attachMaterial,
      removeMaterial: vi.fn(),
      get: vi.fn(),
    } satisfies Pick<Meetups, "attachMaterial" | "removeMaterial" | "get">);

    await expect(
      materials({
        identity: person,
        intent: "attach-material",
        meetupId: meetup.id,
        material: {
          id: "material-id",
          title: "Опрос",
          source: { kind: "message-link", url: "https://t.me/c/42/7" },
        },
        expectedVersion: 3,
        requestId: "request-id",
        useCase: "update_meetup",
      }),
    ).resolves.toMatchObject({
      kind: "material-attached",
      meetup: { materials: [{ id: "material-id", title: "Опрос" }] },
    });
    expect(attachMaterial).toHaveBeenCalledWith({
      person,
      meetupId: meetup.id,
      material: expect.objectContaining({
        id: "material-id",
        title: "Опрос",
      }),
      expectedVersion: 3,
      meta: { requestId: "request-id", useCase: "update_meetup" },
    });
  });

  it("keeps a forbidden removal as an authorization rejection", async () => {
    const materials = createMeetupMaterials({
      attachMaterial: vi.fn(),
      removeMaterial: vi.fn(async () => ({ kind: "forbidden" as const })),
      get: vi.fn(),
    } satisfies Pick<Meetups, "attachMaterial" | "removeMaterial" | "get">);

    await expect(
      materials({
        identity: person,
        intent: "remove-material",
        meetupId: meetup.id,
        materialId: "material-id",
        expectedVersion: 1,
      }),
    ).resolves.toEqual({ kind: "dependency-rejected", reason: "forbidden" });
  });

  it.each(["attach-material", "remove-material"] as const)(
    "answers a %s version conflict with the reread meetup instead of a dependency failure",
    async (intent) => {
      const fresh = { ...meetup, title: "Настолки в субботу", version: 2 };
      const get = vi.fn(async () => ({ kind: "ok" as const, meetup: fresh }));
      const conflict = vi.fn(async () => ({ kind: "conflict" as const }));
      const materials = createMeetupMaterials({
        attachMaterial: conflict,
        removeMaterial: conflict,
        get,
      } satisfies Pick<Meetups, "attachMaterial" | "removeMaterial" | "get">);

      const result = await materials(
        intent === "attach-material"
          ? {
              identity: person,
              intent,
              meetupId: meetup.id,
              material: {
                id: "material-id",
                title: "Опрос",
                source: { kind: "file", fileId: "file-id" },
              },
              expectedVersion: 1,
            }
          : {
              identity: person,
              intent,
              meetupId: meetup.id,
              materialId: "material-id",
              expectedVersion: 1,
            },
      );

      expect(result).toEqual({ kind: "conflict", meetup: fresh });
      expect(conflict).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledWith(person, meetup.id, undefined);
    },
  );

  it("answers a conflict on a meetup that is no longer visible as not found", async () => {
    const materials = createMeetupMaterials({
      attachMaterial: vi.fn(),
      removeMaterial: vi.fn(async () => ({ kind: "conflict" as const })),
      get: vi.fn(async () => ({ kind: "not-found" as const })),
    } satisfies Pick<Meetups, "attachMaterial" | "removeMaterial" | "get">);

    await expect(
      materials({
        identity: person,
        intent: "remove-material",
        meetupId: meetup.id,
        materialId: "material-id",
        expectedVersion: 1,
      }),
    ).resolves.toEqual({ kind: "meetup-not-found" });
  });
});
