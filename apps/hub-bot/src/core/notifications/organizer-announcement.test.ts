import { create } from "@bufbuild/protobuf";
import { GrammyError, InputFile } from "grammy";
import { describe, expect, it, vi } from "vitest";
import {
  AuctionNoticeSchema,
  AuctionNoticeView,
} from "../../../gen/notifications/v1/notifications_pb.js";
import { parseAuctionCallback } from "../../auction-ui/index.js";
import { createMediaChat } from "../media-chat.js";
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
  wireAnnouncementPost,
} from "./organizer-announcement.js";

// Объявление аукциона (PER-765): разбор факта, кнопка, текст и отправка с
// фото лота — общие у двух ботов и у предпросмотра в пульте.

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const photoId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1c01";

describe("organizerAnnouncementOf", () => {
  it("reads a post of the media chat as the picture (PER-776)", () => {
    expect(
      organizerAnnouncementOf(
        create(AuctionNoticeSchema, {
          auctionId,
          body: "Смотри ролик",
          photo: wireAnnouncementPost(42),
        }),
      ),
    ).toEqual({
      kind: "organizer-announcement",
      auctionId,
      text: "Смотри ролик",
      post: 42,
    });
  });

  it("delivers the text without a post it cannot name", () => {
    expect(
      organizerAnnouncementOf(
        create(AuctionNoticeSchema, {
          auctionId,
          body: "Текст",
          photo: {
            source: { case: "channelPost", value: { messageId: 0n } },
          },
        }),
      ),
    ).toEqual({ kind: "organizer-announcement", auctionId, text: "Текст" });
  });

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
    copyMessage: ReturnType<typeof vi.fn>;
  } {
    return {
      sendMessage: vi.fn(async () => ({ message_id: 5 })),
      copyMessage: vi.fn(async () => ({ message_id: 7 })),
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

    expect(await sendOrganizerAnnouncement(telegram, 1, view, options)).toEqual(
      {
        messageId: 6,
        withPhoto: true,
      },
    );
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
    ).toEqual({ messageId: 5, withPhoto: false });
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

  it("forgets a cached file id Telegram refuses and uploads the photo again", async () => {
    const load = vi.fn(async () => bytes);
    const photos = createAnnouncementPhotos(load, () => {});
    photos.remember(view.photo, "stale");
    const refused = api(
      new GrammyError(
        "bad file id",
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: wrong file id",
        },
        "sendPhoto",
        {},
      ),
    );
    await sendOrganizerAnnouncement(refused, 1, view, {
      photos,
      viewerId: "viewer",
      mark: {},
    });
    expect(load).not.toHaveBeenCalled();

    await sendOrganizerAnnouncement(api(), 2, view, {
      photos,
      viewerId: "viewer",
      mark: {},
    });
    expect(load).toHaveBeenCalledOnce();
  });

  it("copies the media chat post with the text as its caption and the button (PER-776)", async () => {
    const telegram = api();
    const warn = vi.fn();
    const media = createMediaChat({ channelId: -1001, logger: { warn } });
    const markup = {
      inline_keyboard: [[{ text: "К лоту", callback_data: "x" }]],
    };

    expect(
      await sendOrganizerAnnouncement(
        telegram,
        1,
        { text: "Ваза", post: 42 },
        {
          photos: createAnnouncementPhotos(vi.fn(), vi.fn()),
          media,
          viewerId: "viewer",
          markup,
          mark: { tag: "notification" },
        },
      ),
    ).toEqual({ messageId: 7, withPhoto: false });
    expect(telegram.copyMessage).toHaveBeenCalledWith(1, -1001, 42, {
      tag: "notification",
      caption: "Ваза",
      reply_markup: markup,
    });
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends the text alone and records the refusal when the post is gone", async () => {
    const telegram = api();
    telegram.copyMessage.mockRejectedValueOnce(
      new GrammyError(
        "gone",
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: message to copy not found",
        },
        "copyMessage",
        {},
      ),
    );
    const warn = vi.fn();
    const media = createMediaChat({ channelId: -1001, logger: { warn } });

    expect(
      await sendOrganizerAnnouncement(
        telegram,
        1,
        { text: "Ваза", post: 42 },
        {
          photos: createAnnouncementPhotos(vi.fn(), vi.fn()),
          media,
          viewerId: "viewer",
          mark: {},
        },
      ),
    ).toEqual({ messageId: 5, withPhoto: false });
    expect(telegram.sendMessage).toHaveBeenCalledWith(1, "Ваза", {
      link_preview_options: { is_disabled: true },
    });
    expect(warn).toHaveBeenCalledWith("media chat post not shown", {
      error_category: "dependency_unavailable",
      error: "Bad Request: message to copy not found",
      media_post_id: 42,
    });
  });
});
