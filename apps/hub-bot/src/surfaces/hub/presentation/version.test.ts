import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  createHarness,
  type HarnessOptions,
} from "../../../../testkit/harness.js";
import type { AccessRight } from "../../../auction-ui/index.js";
import { createDispatcher } from "../application/dispatcher.js";
import type { IdentityResolver } from "../identity/port.js";

// Строка версии в «Помощи» (PER-736): коммит и дата образа — мейнтейнеру, без
// данных сборки — «локальная сборка», остальным строки нет.

function holder(rights: readonly AccessRight[]): IdentityResolver {
  return {
    resolve: async () => ({
      kind: "resolved",
      identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
      rights,
      blocked: false,
    }),
  };
}

const help: Update = {
  update_id: 1,
  message: {
    message_id: 1,
    date: 0,
    chat: { id: 42, type: "private", first_name: "tester" },
    from: { id: 42, is_bot: false, first_name: "tester" },
    text: "/help",
  },
};

async function helpText(
  rights: readonly AccessRight[],
  options: HarnessOptions,
): Promise<string> {
  const { bot, calls } = createHarness(
    holder(rights),
    createDispatcher(),
    [],
    undefined,
    undefined,
    undefined,
    options,
  );
  await bot.init();
  await bot.handleUpdate(help);
  const sent = calls.find((call) => call.method === "sendMessage")?.payload;
  return sent !== undefined && "text" in sent && typeof sent.text === "string"
    ? sent.text
    : "";
}

const image = {
  build: { kind: "image", commit: "d78d99f", date: "2026-10-25" },
} satisfies HarnessOptions;

describe("version line in help", () => {
  it("names the commit and date of the image to a maintainer", async () => {
    const text = await helpText(["access-hub", "grant-admins"], image);
    expect(text).toContain("Помощь");
    expect(text).toContain("Версия бота: d78d99f от 25.10.2026.");
  });

  it("calls a build without build data a local build", async () => {
    expect(await helpText(["access-hub", "grant-admins"], {})).toContain(
      "Версия бота: локальная сборка.",
    );
  });

  it("is not shown to an administrator without grant-admins", async () => {
    const text = await helpText(
      ["access-hub", "manage-members", "manage-meetups", "admit-bidders"],
      image,
    );
    expect(text).toContain("Помощь");
    expect(text).not.toContain("Версия бота");
  });
});
