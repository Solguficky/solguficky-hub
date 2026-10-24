import { describe, expect, it } from "vitest";
import {
  createSupportHarness,
  refusal,
  type SupportRespond,
  supportBotInfo,
  supportGroupId,
} from "../../../testkit/support.js";
import { checkOperatorGroup } from "./group.js";

const forum = {
  id: supportGroupId,
  type: "supergroup",
  title: "Операторы",
  is_forum: true,
};

const admin = (rights: Record<string, unknown>) => ({
  status: "administrator",
  user: supportBotInfo,
  can_be_edited: false,
  is_anonymous: false,
  ...rights,
});

function group(chat: unknown, member: unknown): SupportRespond {
  return (method) => {
    if (method === "getMe") return supportBotInfo;
    if (method === "getChat") return chat;
    if (method === "getChatMember") return member;
    return undefined;
  };
}

async function check(respond: SupportRespond) {
  const { bot, calls } = createSupportHarness({ respond });
  return { result: await checkOperatorGroup(bot.api, supportGroupId), calls };
}

describe("operator group check at start", () => {
  it("passes a forum where the bot manages topics", async () => {
    const { result, calls } = await check(
      group(forum, admin({ can_manage_topics: true })),
    );
    expect(result).toEqual({ ok: true });
    expect(
      calls.find((call) => call.method === "getChatMember")?.payload,
    ).toMatchObject({ chat_id: supportGroupId, user_id: supportBotInfo.id });
  });

  it("refuses a supergroup without topics", async () => {
    const { result } = await check(
      group({ ...forum, is_forum: false }, admin({ can_manage_topics: true })),
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(/BOT_SUPPORT_GROUP_ID.*topics/);
  });

  it("refuses a bot without the right to manage topics", async () => {
    for (const member of [
      admin({ can_manage_topics: false }),
      { status: "member", user: supportBotInfo },
    ]) {
      const { result } = await check(group(forum, member));
      expect(result).toMatchObject({ ok: false });
      expect(!result.ok && result.error).toMatch(/allowed to manage topics/);
    }
  });

  it("refuses a group the bot cannot read", async () => {
    const { result } = await check((method) =>
      method === "getChat"
        ? refusal(400, "Bad Request: chat not found")
        : undefined,
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(/chat not found/);
  });
});
