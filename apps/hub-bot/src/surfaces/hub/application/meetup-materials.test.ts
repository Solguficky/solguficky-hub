import { describe, expect, it, vi } from "vitest";
import type { MeetupSnapshot, Meetups } from "../meetups/port.js";
import { createMeetupMaterials } from "./meetup-materials.js";

const person = {
  identityId: "person-id",
  rights: ["access-hub", "place-bids"] as const,
};
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
      reorderMaterials: vi.fn(async () => {
        throw new Error("unexpected reorderMaterials");
      }),
      removeMaterial: vi.fn(),
      get: vi.fn(),
    } satisfies Pick<
      Meetups,
      "attachMaterial" | "removeMaterial" | "reorderMaterials" | "get"
    >);

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
      reorderMaterials: vi.fn(async () => {
        throw new Error("unexpected reorderMaterials");
      }),
      removeMaterial: vi.fn(async () => ({ kind: "forbidden" as const })),
      get: vi.fn(),
    } satisfies Pick<
      Meetups,
      "attachMaterial" | "removeMaterial" | "reorderMaterials" | "get"
    >);

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
        reorderMaterials: vi.fn(async () => {
          throw new Error("unexpected reorderMaterials");
        }),
        removeMaterial: conflict,
        get,
      } satisfies Pick<
        Meetups,
        "attachMaterial" | "removeMaterial" | "reorderMaterials" | "get"
      >);

      const result = await materials(
        intent === "attach-material"
          ? {
              identity: person,
              intent,
              meetupId: meetup.id,
              material: {
                id: "material-id",
                title: "Опрос",
                source: {
                  kind: "file",
                  fileId: "file-id",
                  fileKind: "document",
                },
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
      reorderMaterials: vi.fn(async () => {
        throw new Error("unexpected reorderMaterials");
      }),
      removeMaterial: vi.fn(async () => ({ kind: "conflict" as const })),
      get: vi.fn(async () => ({ kind: "not-found" as const })),
    } satisfies Pick<
      Meetups,
      "attachMaterial" | "removeMaterial" | "reorderMaterials" | "get"
    >);

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

describe("material movement", () => {
  const person = { identityId: "person", rights: ["manage-meetups"] as const };
  const meetup: MeetupSnapshot = {
    id: "meetup",
    author: "person",
    title: "Meetup",
    description: "",
    venue: "",
    lifecycle: "planned",
    visibility: "visible",
    version: 5,
    materials: Array.from({ length: 10 }, (_, index) => ({
      id: `material-${index}`,
      title: `Material ${index}`,
      source: {
        kind: "file" as const,
        fileKind: "photo" as const,
        fileId: `file-${index}`,
      },
    })),
  };
  const request = {
    identity: person,
    intent: "move-material" as const,
    meetupId: meetup.id,
    materialId: "material-7",
    direction: "down" as const,
    expectedVersion: 5,
  };

  describe("moving one material", () => {
    it("moves one of ten in one request without attaching any file again", async () => {
      const ids = meetup.materials.map((material) => material.id);
      const target = [...ids.slice(0, 7), ids[8], ids[7], ids[9]];
      const reorderMaterials = vi.fn(async () => ({
        kind: "ok" as const,
        meetup: {
          ...meetup,
          version: 6,
          materials: target.flatMap((id) =>
            meetup.materials.filter((material) => material.id === id),
          ),
        },
      }));
      const attachMaterial = vi.fn();
      const removeMaterial = vi.fn();
      const execute = createMeetupMaterials({
        attachMaterial,
        removeMaterial,
        reorderMaterials,
        get: vi.fn(async () => ({ kind: "ok" as const, meetup })),
      });
      const result = await execute(request);
      expect(result).toMatchObject({
        kind: "materials-reordered",
        meetup: { materials: target.map((id) => ({ id })) },
      });
      expect(reorderMaterials).toHaveBeenCalledExactlyOnceWith({
        person,
        meetupId: meetup.id,
        materialIds: target,
        expectedVersion: 5,
      });
      expect(attachMaterial).not.toHaveBeenCalled();
      expect(removeMaterial).not.toHaveBeenCalled();
    });

    it("rejects an old keyboard before sending a reordered list", async () => {
      const reorderMaterials = vi.fn();
      const fresh = {
        ...meetup,
        version: 6,
        materials: [...meetup.materials].reverse(),
      };
      const execute = createMeetupMaterials({
        attachMaterial: vi.fn(),
        removeMaterial: vi.fn(),
        reorderMaterials,
        get: vi.fn(async () => ({ kind: "ok" as const, meetup: fresh })),
      });
      expect(await execute(request)).toEqual({
        kind: "conflict",
        meetup: fresh,
      });
      expect(reorderMaterials).not.toHaveBeenCalled();
    });

    it("rereads a racing write conflict without automatically moving again", async () => {
      const reorderMaterials = vi.fn(async () => ({
        kind: "conflict" as const,
      }));
      const fresh = { ...meetup, version: 6 };
      const get = vi
        .fn()
        .mockResolvedValueOnce({ kind: "ok", meetup })
        .mockResolvedValueOnce({ kind: "ok", meetup: fresh });
      const execute = createMeetupMaterials({
        attachMaterial: vi.fn(),
        removeMaterial: vi.fn(),
        reorderMaterials,
        get,
      });
      expect(await execute(request)).toEqual({
        kind: "conflict",
        meetup: fresh,
      });
      expect(reorderMaterials).toHaveBeenCalledTimes(1);
    });
  });
});
