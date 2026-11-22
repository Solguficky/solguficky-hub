import { GrammyError } from "grammy";
import { describe, expect, it } from "vitest";
import {
  announcementBodyCheck,
  announcementKey,
  announcementMaterialId,
  announcementPostText,
  announcementPrint,
  communityMessageLink,
  communityRightsError,
  createAnnouncementPosts,
} from "./meetup-announcement.js";

const meetupId = "01800000-0000-7000-8000-000000000001";

describe("анонс сходки в чат сообщества", () => {
  it("ссылка на пост собирается из супергруппы и номера сообщения", () => {
    expect(communityMessageLink(-1001234567890, 42)).toBe(
      "https://t.me/c/1234567890/42",
    );
    expect(communityMessageLink(-12345, 7)).toBe("https://t.me/c/12345/7");
  });

  it("id материала детерминирован и различает ключи", () => {
    const first = announcementMaterialId(meetupId, "key000000001");
    expect(announcementMaterialId(meetupId, "key000000001")).toBe(first);
    expect(announcementMaterialId(meetupId, "key000000002")).not.toBe(first);
    expect(announcementMaterialId("other", "key000000001")).not.toBe(first);
  });

  it("пост несёт подпись организатора и экранированный текст", () => {
    expect(announcementPostText("Иван <Иванов>", "Сходка & <друзья>")).toBe(
      "<b>Иван &lt;Иванов&gt;:</b>\n\nСходка &amp; &lt;друзья&gt;",
    );
  });

  it("отпечаток текста короток и следует за текстом", () => {
    expect(announcementPrint("привет")).toMatch(/^[0-9a-z]{5}$/);
    expect(announcementPrint("привет")).toBe(announcementPrint("привет"));
  });

  it("ключ подтверждения короток", () => {
    expect(announcementKey()).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it("отказ по правам чата распознаётся по описанию Telegram", () => {
    const refusal = new GrammyError(
      "Bad Request: not enough rights to send text messages to the chat",
      {
        ok: false,
        error_code: 400,
        description: "not enough rights to send text messages to the chat",
      },
      "sendMessage",
      {},
    );
    expect(communityRightsError(refusal)).toBe(true);
    expect(communityRightsError(new Error("network"))).toBe(false);
  });

  it("память поста хранит номер по ключу и имеет предел", () => {
    const posts = createAnnouncementPosts(2);
    expect(posts.posted("a")).toBeUndefined();
    posts.remember("a", 101);
    expect(posts.posted("a")).toBe(101);
    posts.remember("a", 102);
    expect(posts.posted("a")).toBe(102);
    posts.remember("b", 103);
    posts.remember("c", 104);
    expect(posts.posted("a")).toBeUndefined();
    expect(posts.posted("c")).toBe(104);
  });

  it("текст анонса проверяется теми же пределами, что и рассылка", () => {
    expect(announcementBodyCheck("  анонс  ")).toEqual({
      kind: "ok",
      body: "анонс",
    });
    expect(announcementBodyCheck("   ")).toEqual({ kind: "empty" });
    expect(announcementBodyCheck("x".repeat(4097))).toEqual({
      kind: "too-long",
    });
  });
});
