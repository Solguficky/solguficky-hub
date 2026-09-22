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
    } satisfies Pick<Meetups, "attachMaterial" | "removeMaterial">);

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
      meta: { requestId: "request-id", useCase: "update_meetup" },
    });
  });

  it("keeps a forbidden removal as an authorization rejection", async () => {
    const materials = createMeetupMaterials({
      attachMaterial: vi.fn(),
      removeMaterial: vi.fn(async () => ({ kind: "forbidden" as const })),
    } satisfies Pick<Meetups, "attachMaterial" | "removeMaterial">);

    await expect(
      materials({
        identity: person,
        intent: "remove-material",
        meetupId: meetup.id,
        materialId: "material-id",
      }),
    ).resolves.toEqual({ kind: "dependency-rejected", reason: "forbidden" });
  });
});
