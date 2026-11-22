import { GrammyError } from "grammy";
import { describe, expect, it } from "vitest";
import {
  announcementBodyCheck,
  announcementFits,
  announcementKey,
  announcementMaterialId,
  announcementPostText,
  announcementPrint,
  communityMessageLink,
  communityRightsError,
  createAnnouncementPosts,
  isCommunitySupergroup,
  postTooLongError,
} from "./meetup-announcement.js";

const meetupId = "01800000-0000-7000-8000-000000000001";

function tooLong(): GrammyError {
  return new GrammyError(
    "Bad Request: message is too long",
    { ok: false, error_code: 400, description: "message is too long" },
    "sendMessage",
    {},
  );
}

describe("анонс сходки в чат сообщества", () => {
  it("ссылка на пост собирается из супергруппы и номера сообщения", () => {
    expect(communityMessageLink(-1001234567890, 42)).toBe(
      "https://t.me/c/1234567890/42",
    );
    expect(isCommunitySupergroup(-1001234567890)).toBe(true);
    expect(isCommunitySupergroup(-12345)).toBe(false);
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

  it("предел считается по собранному посту, а не по телу", () => {
    expect(announcementFits("Иван", "анонс")).toBe(true);
    expect(announcementFits("Иван", "x".repeat(4096))).toBe(false);
    expect(announcementFits("Иван", "&".repeat(2040))).toBe(false);
  });

  it("отпечаток текста короток и следует за текстом", () => {
    expect(announcementPrint("привет")).toMatch(/^[0-9a-z]{5}$/);
    expect(announcementPrint("привет")).toBe(announcementPrint("привет"));
  });

  it("ключ подтверждения короток", () => {
    expect(announcementKey()).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it("отказы Telegram распознаются по описанию", () => {
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
    expect(postTooLongError(tooLong())).toBe(true);
    expect(postTooLongError(refusal)).toBe(false);
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
