import { create } from "@bufbuild/protobuf";
import { GrammyError, InputFile } from "grammy";
import { describe, expect, it, vi } from "vitest";
import {
  AuctionNoticeSchema,
  AuctionNoticeView,
} from "../../../gen/notifications/v1/notifications_pb.js";
import { parseAuctionCallback } from "../../auction-ui/index.js";
import {
  type AnnouncementApi,
  type AnnouncementButtonKind,
  announcementButtonData,
  checkAnnouncementText,
  createAnnouncementPhotos,
  organizerAnnouncementOf,
  renderOrganizerAnnouncement,
  sendOrganizerAnnouncement,
  wireAnnouncementButton,
  wireAnnouncementPhoto,
} from "./organizer-announcement.js";

// Объявление аукциона (PER-765): разбор факта, кнопка, текст и отправка с
// фото лота — общие у двух ботов и у предпросмотра в пульте.

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const photoId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1c01";

describe("organizerAnnouncementOf", () => {
  it("reads the text, the lot button and the lot photo", () => {
    expect(
      organizerAnnouncementOf(
        create(AuctionNoticeSchema, {
          auctionId,
          body: "Ваза ждёт <ставок> & внимания",
          button: wireAnnouncementButton({ kind: "lot", lotId }),
          photo: wireAnnouncementPhoto({ lotId, photoId }),
        }),
      ),
    ).toEqual({
      kind: "organizer-announcement",
      auctionId,
      text: "Ваза ждёт <ставок> & внимания",
      button: { kind: "lot", lotId },
      photo: { lotId, photoId },
    });
  });

  it("delivers the text without a button or a photo it cannot read", () => {
    expect(
      organizerAnnouncementOf(
        create(AuctionNoticeSchema, {
          auctionId,
          body: "Текст",
          button: { view: 99 as AuctionNoticeView },
          photo: {
            source: { case: "lotPhoto", value: { lotId: "bad", photoId } },
          },
        }),
      ),
    ).toEqual({ kind: "organizer-announcement", auctionId, text: "Текст" });
  });

  it("rejects a broken auction id, an empty text and a lot button without a lot", () => {
    expect(
      organizerAnnouncementOf(
        create(AuctionNoticeSchema, { auctionId: "x", body: "Текст" }),
      ),
    ).toBeUndefined();
    expect(
      organizerAnnouncementOf(
        create(AuctionNoticeSchema, { auctionId, body: " " }),
      ),
    ).toBeUndefined();
    expect(
      organizerAnnouncementOf(
        create(AuctionNoticeSchema, {
          auctionId,
          body: "Текст",
          button: { view: AuctionNoticeView.LOT, lotId: "" },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("announcement button", () => {
  const kinds: AnnouncementButtonKind[] = [
    "auction",
    "lots",
    "lot",
    "raffle",
    "predictions",
    "chronicle",
  ];

  it.each(kinds)(
    "opens a screen of the auction tree for %s within 64 bytes",
    (kind) => {
      const view = renderOrganizerAnnouncement({
        auctionId,
        text: "Текст",
        button: kind === "lot" ? { kind, lotId } : { kind },
      });
      const data = announcementButtonData(
        view.button ?? { kind, text: "", auctionId },
      );
      expect(parseAuctionCallback(data).ok).toBe(true);
      expect(Buffer.byteLength(`v1:t:${data.slice(3)}`)).toBeLessThanOrEqual(
        64,
      );
    },
  );
});

describe("checkAnnouncementText", () => {
  it("keeps a text up to the photo caption limit and refuses longer", () => {
    expect(checkAnnouncementText(` ${"а".repeat(1024)} `)).toEqual({
      kind: "ok",
      text: "а".repeat(1024),
    });
    expect(checkAnnouncementText("а".repeat(1025))).toEqual({
      kind: "too-long",
    });
    expect(checkAnnouncementText("  ")).toEqual({ kind: "empty" });
    expect(checkAnnouncementText("а\u0000б")).toEqual({ kind: "nul" });
  });
});

describe("sendOrganizerAnnouncement", () => {
  function api(photoFails?: unknown): AnnouncementApi & {
    sendMessage: ReturnType<typeof vi.fn>;
    sendPhoto: ReturnType<typeof vi.fn>;
  } {
    return {
      sendMessage: vi.fn(async () => ({ message_id: 5 })),
      sendPhoto: vi.fn(async () => {
        if (photoFails !== undefined) throw photoFails;
        return {
          message_id: 6,
          photo: [{ file_id: "small" }, { file_id: "big" }],
        };
      }),
    };
  }
  const view = { text: "Ваза", photo: { lotId, photoId } };
  const bytes = {
    content: new Uint8Array([1]),
    mediaType: "image/jpeg",
    version: "1",
  };

  it("sends the photo with the text as its caption once and reuses its file id", async () => {
    const load = vi.fn(async () => bytes);
    const photos = createAnnouncementPhotos(load, () => {});
    const telegram = api();
    const options = { photos, viewerId: "viewer", mark: {} };

    expect(await sendOrganizerAnnouncement(telegram, 1, view, options)).toBe(6);
    await sendOrganizerAnnouncement(telegram, 2, view, options);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({ lotId, photoId }, "viewer");
    expect(telegram.sendPhoto.mock.calls[0]?.[1]).toBeInstanceOf(InputFile);
    expect(telegram.sendPhoto.mock.calls[0]?.[2]).toMatchObject({
      caption: "Ваза",
    });
    expect(telegram.sendPhoto.mock.calls[1]?.[1]).toBe("big");
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("sends the text alone when the photo cannot be read", async () => {
    const missing = vi.fn();
    const photos = createAnnouncementPhotos(async () => {
      throw new Error("not found");
    }, missing);
    const telegram = api();

    expect(
      await sendOrganizerAnnouncement(telegram, 1, view, {
        photos,
        viewerId: "viewer",
        mark: {},
      }),
    ).toBe(5);
    expect(telegram.sendPhoto).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith(1, "Ваза", {
      link_preview_options: { is_disabled: true },
    });
    expect(missing).toHaveBeenCalledOnce();
  });

  it("sends the text alone when Telegram refuses the picture, but not on other failures", async () => {
    const photos = () =>
      createAnnouncementPhotos(
        async () => bytes,
        () => {},
      );
    const refused = api(
      new GrammyError(
        "bad photo",
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: IMAGE_PROCESS_FAILED",
        },
        "sendPhoto",
        {},
      ),
    );
    await sendOrganizerAnnouncement(refused, 1, view, {
      photos: photos(),
      viewerId: "viewer",
      mark: {},
    });
    expect(refused.sendMessage).toHaveBeenCalledOnce();

    const blocked = api(new Error("network"));
    await expect(
      sendOrganizerAnnouncement(blocked, 1, view, {
        photos: photos(),
        viewerId: "viewer",
        mark: {},
      }),
    ).rejects.toThrow("network");
    expect(blocked.sendMessage).not.toHaveBeenCalled();
  });
});
