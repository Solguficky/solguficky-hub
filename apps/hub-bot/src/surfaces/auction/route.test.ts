import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  type AccessRight,
  encodeAuctionCallback,
  type ResolvedIdentity,
  type RoleRequestAnswer,
} from "../../auction-ui/index.js";
import {
  type AuctionCatalogPort,
  type AuctionSummary,
  LIST_PAGE_SIZE,
} from "./auctions.js";
import type { EntryPorts } from "./entry-ports.js";
import { entryCallback, listCallback, startCallback } from "./faq.js";
import {
  routeAuctionReply,
  routeAuctionStart,
  routeAuctionCallback as routeCallback,
} from "./route.js";

const lotId = "01926f3c-8b7a-7cde-8f00-0123456789ab";
const auctionId = "01926f3c-8b7a-7cde-8f00-0123456789ac";
const user = { telegramUserId: 42 };
const firstName = "Сова";

// Имя нужно одной кнопке — повтору входа; остальным нажатиям оно безразлично.
const routeAuctionCallback = (
  input: Omit<Parameters<typeof routeCallback>[0], "firstName">,
) => routeCallback({ ...input, firstName });

function summary(index: number, stage: AuctionSummary["stage"]) {
  return {
    auctionId: `01926f3c-8b7a-5cde-8f00-${String(index).padStart(12, "0")}`,
    stage,
    opensAt: `2026-10-${String(10 + index).padStart(2, "0")}T16:00:00Z`,
    lotCount: index,
  };
}

// Роли едут транзитом в Auction и допуска не решают: пускает право.
const VIEWER = {
  identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
  globalRoles: ["public"],
} as const;
const GUEST: readonly AccessRight[] = ["auction"];
const MEMBER: readonly AccessRight[] = ["hub", "auction"];

function identity(
  overrides: Partial<Omit<ResolvedIdentity, "viewer">>,
): ResolvedIdentity {
  return { viewer: VIEWER, rights: [], blocked: false, ...overrides };
}

// Что вход ответил бы человеку с такой личностью: заблокированному —
// `blocked`, с правом аукциона — что оно уже есть, остальным — заявку.
function entered(resolved: ResolvedIdentity): RoleRequestAnswer {
  return {
    viewer: resolved.viewer,
    rights: resolved.blocked ? [] : resolved.rights,
    outcome: resolved.blocked
      ? "blocked"
      : resolved.rights.includes("auction")
        ? "already-held"
        : "pending",
  };
}

function ports(
  resolved: ResolvedIdentity | Error,
  auctions: { active?: AuctionSummary[]; finished?: AuctionSummary[] } = {},
): EntryPorts {
  return {
    identity: {
      resolveIdentity: vi.fn(async () => {
        if (resolved instanceof Error) throw resolved;
        return resolved;
      }),
    },
    entry: {
      requestRole: vi.fn(async () => {
        if (resolved instanceof Error) throw resolved;
        return entered(resolved);
      }),
    },
    auction: {
      getLot: vi.fn(async () => ({
        lotId,
        auctionId,
        version: 3,
        proxyEnabled: false,
        status: { kind: "unsold" as const },
      })),
      listAuctionLots: vi.fn(async () => ({ lots: [], nextPageToken: "" })),
      listLotHistory: vi.fn(async () => ({ entries: [], nextPageToken: "" })),
      getDisplayNames: vi.fn(async () => ({})),
      placeBid: vi.fn(async () => ({ kind: "accepted" as const })),
      setProxyLimit: vi.fn(async () => ({ kind: "accepted" as const })),
      chooseDisplayName: vi.fn(async () => ({
        kind: "accepted" as const,
        name: "@owl",
      })),
    },
    operations: {
      newOperationId: vi.fn(() => "01929b7e-5c1d-7a3f-8e4b-00000000c001"),
    },
    catalog: {
      listAuctions: vi.fn<AuctionCatalogPort["listAuctions"]>(
        async ({ listing }) => ({
          auctions: auctions[listing] ?? [],
          nextPageToken: "",
        }),
      ),
    },
    faq: {
      acknowledged: vi.fn(async () => true),
      acknowledge: vi.fn(async () => {}),
    },
  };
}

const lotButton = encodeAuctionCallback({ kind: "lot", lotId, page: 0 });
const feedButton = encodeAuctionCallback({
  kind: "feed",
  auctionId,
  page: 0,
});

// Шаг вопроса суммы — данные «Отмены» под вопросом, заданным этому человеку.
const QUESTION_STEP = encodeAuctionCallback({
  kind: "question",
  question: "bid",
  lotId,
  page: 0,
  addressee: user.telegramUserId,
});

describe("FAQ entry", () => {
  it("shows no FAQ before admission and opens it on the first admitted start", async () => {
    const p = ports(identity({ rights: [] }));
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({
      kind: "denied",
      reason: "not-admitted",
    });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
    vi.mocked(p.entry.requestRole).mockResolvedValue(
      entered(identity({ rights: GUEST })),
    );
    vi.mocked(p.faq.acknowledged).mockResolvedValue(false);
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({
      kind: "faq",
    });
    expect(p.faq.acknowledge).not.toHaveBeenCalled();
  });
  it.each([
    "faq",
    "menu",
    "read",
    "start",
    "auctions",
    "past",
    "details",
    "question",
  ] as const)(
    "refuses a blocked person even with a stale auction right on %s",
    async (action) => {
      const p = ports(identity({ rights: GUEST, blocked: true }));
      expect(
        (
          await routeAuctionCallback({
            ports: p,
            user,
            data: entryCallback(action),
          })
        ).screen,
      ).toEqual({ kind: "denied", reason: "blocked" });
      expect(
        (await routeAuctionStart({ ports: p, user, firstName })).screen,
      ).toEqual({
        kind: "denied",
        reason: "blocked",
      });
      expect(p.faq.acknowledged).not.toHaveBeenCalled();
      expect(p.faq.acknowledge).not.toHaveBeenCalled();
      expect(p.auction.getLot).not.toHaveBeenCalled();
      expect(p.catalog.listAuctions).not.toHaveBeenCalled();
    },
  );

  // Участнику сообщества бот аукциона отвечает только переходом в бот хаба:
  // ни FAQ, ни меню, ни списков, ни торгов (ADR-064, пункт 2).
  it.each([
    "faq",
    "menu",
    "read",
    "start",
    "auctions",
    "past",
    "details",
    "question",
  ] as const)(
    "sends a community member to the hub bot on %s",
    async (action) => {
      const p = ports(identity({ rights: MEMBER }));
      expect(
        (
          await routeAuctionCallback({
            ports: p,
            user,
            data: entryCallback(action),
          })
        ).screen,
      ).toEqual({ kind: "denied", reason: "in-community" });
      expect(p.faq.acknowledged).not.toHaveBeenCalled();
      expect(p.faq.acknowledge).not.toHaveBeenCalled();
      expect(p.catalog.listAuctions).not.toHaveBeenCalled();
    },
  );

  it("sends a community member to the hub bot on /start and on a lot press", async () => {
    const p = ports(identity({ rights: [...MEMBER, "manage-membership"] }));
    expect(await routeAuctionStart({ ports: p, user, firstName })).toEqual({
      screen: { kind: "denied", reason: "in-community" },
      identityId: VIEWER.identityId,
    });
    expect(
      (await routeAuctionCallback({ ports: p, user, data: lotButton })).screen,
    ).toEqual({ kind: "denied", reason: "in-community" });
    expect(p.auction.getLot).not.toHaveBeenCalled();
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
  });

  it.each(["details", "question"] as const)(
    "opens the local %s destination and returns to FAQ",
    async (action) => {
      const p = ports(identity({ rights: GUEST }));
      expect(
        (
          await routeAuctionCallback({
            ports: p,
            user,
            data: entryCallback(action),
          })
        ).screen,
      ).toEqual({ kind: action });
      expect(
        (
          await routeAuctionCallback({
            ports: p,
            user,
            data: entryCallback("faq"),
          })
        ).screen,
      ).toEqual({ kind: "faq" });
      expect(p.faq.acknowledge).not.toHaveBeenCalled();
    },
  );
  it("shows FAQ on the first admitted start and leaves completion untouched", async () => {
    const p = ports(identity({ rights: GUEST }));
    vi.mocked(p.faq.acknowledged).mockResolvedValue(false);
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({
      kind: "faq",
    });
    expect(p.faq.acknowledge).not.toHaveBeenCalled();
    expect(p.auction.getLot).not.toHaveBeenCalled();
    // Вход заменяет разрешение личности: Identity спрошен один раз.
    expect(p.entry.requestRole).toHaveBeenCalledTimes(1);
    expect(p.identity.resolveIdentity).not.toHaveBeenCalled();
  });

  it("shows the menu to a returning participant without an auction id", async () => {
    const p = ports(identity({ rights: GUEST }));
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({
      kind: "menu",
    });
  });

  it("records completion on the return from FAQ and allows its repetition", async () => {
    const p = ports(identity({ rights: GUEST }));
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await routeAuctionCallback({
            ports: p,
            user,
            data: entryCallback("read"),
          })
        ).screen,
      ).toEqual({ kind: "menu" });
    }
    expect(p.faq.acknowledge).toHaveBeenCalledTimes(2);
    expect(p.faq.acknowledge).toHaveBeenCalledWith({
      identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
      globalRoles: ["public"],
    });
  });

  // «Меню» под лотом, списком или кадром отказа отметку не ставит: человек,
  // который FAQ не закрывал, видит FAQ, а не меню.
  it("opens the menu without recording completion", async () => {
    const p = ports(identity({ rights: GUEST }));
    const menu = () =>
      routeAuctionCallback({ ports: p, user, data: entryCallback("menu") });
    expect((await menu()).screen).toEqual({ kind: "menu" });
    vi.mocked(p.faq.acknowledged).mockResolvedValue(false);
    expect((await menu()).screen).toEqual({ kind: "faq" });
    expect(p.faq.acknowledge).not.toHaveBeenCalled();
  });

  it("does not enter the menu when completion cannot be saved", async () => {
    const p = ports(identity({ rights: GUEST }));
    vi.mocked(p.faq.acknowledge).mockRejectedValue(
      new ConnectError("offline", Code.Unavailable),
    );
    expect(
      (
        await routeAuctionCallback({
          ports: p,
          user,
          data: entryCallback("read"),
        })
      ).screen,
    ).toEqual({
      kind: "unavailable",
      exit: { kind: "retry", data: entryCallback("read") },
    });
  });

  it("allows a manual return to FAQ without storage or Auction reads", async () => {
    const p = ports(identity({ rights: GUEST }));
    expect(
      (
        await routeAuctionCallback({
          ports: p,
          user,
          data: entryCallback("faq"),
        })
      ).screen,
    ).toEqual({ kind: "faq" });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
    expect(p.faq.acknowledge).not.toHaveBeenCalled();
    expect(p.auction.getLot).not.toHaveBeenCalled();
  });

  it.each([entryCallback("auctions"), entryCallback("past"), lotButton])(
    "shows FAQ before an unacknowledged participant follows %s",
    async (data) => {
      const p = ports(identity({ rights: GUEST }));
      vi.mocked(p.faq.acknowledged).mockResolvedValue(false);
      expect(
        (await routeAuctionCallback({ ports: p, user, data })).screen,
      ).toEqual({ kind: "faq" });
      expect(p.auction.getLot).not.toHaveBeenCalled();
      expect(p.catalog.listAuctions).not.toHaveBeenCalled();
    },
  );

  it.each([
    "faq",
    "menu",
    "read",
    "start",
    "auctions",
    "past",
    "details",
    "question",
  ] as const)(
    "rechecks access on the old %s button before reaching FAQ storage",
    async (action) => {
      const p = ports(identity({ rights: [] }));
      expect(
        (
          await routeAuctionCallback({
            ports: p,
            user,
            data: entryCallback(action),
          })
        ).screen,
      ).toEqual({ kind: "denied", reason: "not-admitted" });
      expect(p.faq.acknowledged).not.toHaveBeenCalled();
      expect(p.faq.acknowledge).not.toHaveBeenCalled();
    },
  );

  it("fails closed if the completion read is unavailable", async () => {
    const p = ports(identity({ rights: GUEST }));
    vi.mocked(p.faq.acknowledged).mockRejectedValue(
      new ConnectError("offline", Code.Unavailable),
    );
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({
      kind: "unavailable",
      exit: { kind: "enter", data: startCallback() },
    });
  });
});

describe("auction lists", () => {
  const admitted = identity({ rights: GUEST });

  it("lists one active auction as a one-row list, not as its feed", async () => {
    const only = summary(1, "prebidding");
    const p = ports(admitted, { active: [only] });
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: entryCallback("auctions"),
    });
    expect(outcome.screen).toEqual({
      kind: "auctions",
      list: { page: 0, pageCount: 1, auctions: [only] },
    });
    expect(p.catalog.listAuctions).toHaveBeenCalledWith({
      viewer: {
        identityId: admitted.viewer.identityId,
        globalRoles: ["public"],
      },
      listing: "active",
      pageToken: "",
    });
    expect(p.auction.listAuctionLots).not.toHaveBeenCalled();
  });

  it("reads finished auctions for the past list, freshest first", async () => {
    const older = summary(1, "finished");
    const newer = summary(2, "finished");
    const p = ports(admitted, { finished: [older, newer] });
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: entryCallback("past"),
    });
    expect(outcome.screen).toEqual({
      kind: "past",
      list: { page: 0, pageCount: 1, auctions: [newer, older] },
    });
    expect(p.catalog.listAuctions).toHaveBeenCalledWith(
      expect.objectContaining({ listing: "finished" }),
    );
  });

  it("follows every server page before cutting the list into pages", async () => {
    const all = Array.from({ length: LIST_PAGE_SIZE + 2 }, (_, index) =>
      summary(index + 1, "finished"),
    );
    const p = ports(admitted);
    vi.mocked(p.catalog.listAuctions).mockImplementation(
      async ({ pageToken }) =>
        pageToken === ""
          ? { auctions: all.slice(0, 5), nextPageToken: "next" }
          : { auctions: all.slice(5), nextPageToken: "" },
    );
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: listCallback("past", 1),
    });
    expect(outcome.screen).toEqual({
      kind: "past",
      list: { page: 1, pageCount: 2, auctions: [all[1], all[0]] },
    });
  });

  it("shows the last page when the list shrank under an old button", async () => {
    const p = ports(admitted, { active: [summary(1, "scheduled")] });
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: listCallback("auctions", 3),
    });
    expect(outcome.screen).toMatchObject({
      kind: "auctions",
      list: { page: 0, pageCount: 1 },
    });
  });

  it("returns the feed to the list where its auction stands now", async () => {
    const live = summary(0, "prebidding");
    const feedOf = (id: string) =>
      encodeAuctionCallback({ kind: "feed", auctionId: id, page: 0 });
    expect(
      (
        await routeAuctionCallback({
          ports: ports(admitted, { active: [live] }),
          user,
          data: feedOf(live.auctionId),
        })
      ).screen,
    ).toMatchObject({ kind: "auction", parent: "auctions" });
    expect(
      (
        await routeAuctionCallback({
          ports: ports(admitted),
          user,
          data: feedButton,
        })
      ).screen,
    ).toMatchObject({ kind: "auction", parent: "past" });
  });

  it("fails closed when the list cannot be read", async () => {
    const p = ports(admitted);
    vi.mocked(p.catalog.listAuctions).mockRejectedValue(
      new ConnectError("offline", Code.Unavailable),
    );
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: entryCallback("auctions"),
    });
    expect(outcome.screen).toEqual({
      kind: "unavailable",
      exit: { kind: "retry", data: entryCallback("auctions") },
    });
    expect(outcome.failure?.category).toBe("dependency_unavailable");
  });
});

describe("routeAuctionCallback", () => {
  it("wraps the shared body into the entry screen for a guest", async () => {
    const outcome = await routeAuctionCallback({
      ports: ports(identity({ rights: GUEST })),
      user,
      data: lotButton,
    });
    expect(outcome.screen).toMatchObject({
      kind: "auction",
      body: { blocks: [{ kind: "lot", lotId }] },
    });
    expect(outcome.identityId).toBe("01926f3c-8b7a-7cde-8f00-00000000000a");
    expect(outcome.viewer).toEqual({
      identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
      globalRoles: ["public"],
    });
  });

  it("denies a person without the auction right before calling Auction", async () => {
    const p = ports(identity({ rights: [] }));
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: lotButton,
    });
    expect(outcome.screen).toEqual({ kind: "denied", reason: "not-admitted" });
    expect(p.auction.getLot).not.toHaveBeenCalled();
  });

  it("gives the blocked person a refusal of its own", async () => {
    const outcome = await routeAuctionCallback({
      ports: ports(identity({ blocked: true })),
      user,
      data: lotButton,
    });
    expect(outcome.screen).toEqual({ kind: "denied", reason: "blocked" });
  });

  it.each([
    ["a foreign button", "v1:meetup:x"],
    ["an outdated version", "v9:auc:lot:x"],
    ["a malformed button", "v1:auc:lot:"],
    // Страница с ведущим нулём — не та строка, что пишет кодировщик.
    ["a page button in a foreign spelling", `${feedButton.slice(0, -1)}01`],
  ])(
    "answers %s with the outdated screen without calling neighbours",
    async (_name, data) => {
      const p = ports(new Error("Identity must not be called"));
      const outcome = await routeAuctionCallback({ ports: p, user, data });
      expect(outcome).toEqual({ screen: { kind: "outdated" } });
      expect(p.identity.resolveIdentity).not.toHaveBeenCalled();
    },
  );

  it("fails closed when Identity is unavailable", async () => {
    const failure = new Error("connect ECONNREFUSED");
    const p = ports(failure);
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: lotButton,
    });
    expect(outcome).toEqual({
      screen: {
        kind: "unavailable",
        exit: { kind: "retry", data: lotButton },
      },
      failure: { category: "unexpected", message: "connect ECONNREFUSED" },
    });
    expect(p.auction.getLot).not.toHaveBeenCalled();
  });

  it("answers unavailable when Auction refuses the read", async () => {
    const p = ports(identity({ rights: GUEST }));
    vi.mocked(p.auction.getLot).mockRejectedValueOnce(
      new ConnectError("not implemented", Code.Unimplemented),
    );
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: lotButton,
    });
    // Повтор несёт данные нажатия, на котором случился отказ.
    expect(outcome.screen).toEqual({
      kind: "unavailable",
      exit: { kind: "retry", data: lotButton },
    });
    expect(outcome.identityId).toBeDefined();
    expect(outcome.failure).toMatchObject({
      category: "dependency_unavailable",
      grpcCode: "Unimplemented",
    });
  });

  // Критерий PER-306: недоступный Auction — именованный экран, а не пустая
  // лента.
  it("answers unavailable, not an empty feed, when Auction refuses the list", async () => {
    const p = ports(identity({ rights: GUEST }));
    vi.mocked(p.auction.listAuctionLots).mockRejectedValueOnce(
      new ConnectError("not implemented", Code.Unimplemented),
    );
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: feedButton,
    });
    expect(outcome.screen).toEqual({
      kind: "unavailable",
      exit: { kind: "retry", data: feedButton },
    });
    expect(outcome.identityId).toBe("01926f3c-8b7a-7cde-8f00-00000000000a");
    expect(outcome.failure).toMatchObject({ grpcCode: "Unimplemented" });
  });

  it("classifies an expired deadline as a timeout", async () => {
    const outcome = await routeAuctionCallback({
      ports: ports(new ConnectError("deadline", Code.DeadlineExceeded)),
      user,
      data: lotButton,
    });
    expect(outcome.failure?.category).toBe("timeout");
  });
});

describe("routeAuctionStart", () => {
  it("applies to the auction queue with the channel code and the first name", async () => {
    const p = ports(identity({ rights: [] }));
    const outcome = await routeAuctionStart({
      ports: p,
      user: { telegramUserId: 42, telegramUsername: "owl" },
      firstName,
      sourceCode: "chat",
    });
    expect(p.entry.requestRole).toHaveBeenCalledExactlyOnceWith({
      user: { telegramUserId: 42, telegramUsername: "owl" },
      queue: "auction",
      sourceCode: "chat",
      firstName,
    });
    expect(outcome).toEqual({
      screen: { kind: "denied", reason: "not-admitted" },
      identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
    });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
  });

  // Присутствие кода значимо: пустой код после `s_` едет пустой строкой, а
  // payload без префикса поля не несёт.
  it.each([
    ["", { sourceCode: "" }],
    [undefined, {}],
  ])("passes the channel code %j as received", async (sourceCode, expected) => {
    const p = ports(identity({ rights: [] }));
    await routeAuctionStart({
      ports: p,
      user,
      firstName,
      ...(sourceCode === undefined ? {} : { sourceCode }),
    });
    expect(p.entry.requestRole).toHaveBeenCalledExactlyOnceWith({
      user,
      queue: "auction",
      firstName,
      ...expected,
    });
  });

  it("opens the entry for a person the allowlist has just admitted", async () => {
    const p = ports(identity({ rights: [] }));
    vi.mocked(p.entry.requestRole).mockResolvedValue({
      ...entered(identity({ rights: GUEST })),
      outcome: "granted-by-allowlist",
    });
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({ kind: "menu" });
  });

  it("answers a declined application with a refusal of its own", async () => {
    const p = ports(identity({ rights: [] }));
    vi.mocked(p.entry.requestRole).mockResolvedValue({
      ...entered(identity({ rights: [] })),
      outcome: "declined",
    });
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({ kind: "denied", reason: "declined" });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
  });

  it("fails closed on an outcome it does not know, whatever the rights", async () => {
    const p = ports(identity({ rights: GUEST }));
    vi.mocked(p.entry.requestRole).mockResolvedValue({
      ...entered(identity({ rights: GUEST })),
      outcome: "unspecified",
    });
    expect(await routeAuctionStart({ ports: p, user, firstName })).toEqual({
      screen: {
        kind: "unavailable",
        exit: { kind: "enter", data: startCallback() },
      },
      identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
      failure: {
        category: "invariant",
        message: "identity answered an unknown role request outcome",
      },
    });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
  });

  it("fails closed when the entry is unavailable", async () => {
    const p = ports(new ConnectError("offline", Code.Unavailable));
    const outcome = await routeAuctionStart({
      ports: p,
      user,
      firstName,
      sourceCode: "chat",
    });
    // Повтор входа несёт код канала прихода: заявка не теряет источник.
    expect(outcome.screen).toEqual({
      kind: "unavailable",
      exit: { kind: "enter", data: startCallback("chat") },
    });
    expect(outcome.failure?.category).toBe("dependency_unavailable");
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
  });
});

// «Повторить» под кадром «недоступно» после `/start` — тот же вход: без него
// новичок после сбоя увидел бы «заявка на рассмотрении» без заявки.
describe("entry retry", () => {
  it("requests the role again with the channel code and the first name", async () => {
    const p = ports(identity({ rights: [] }));
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: startCallback("chat"),
    });
    expect(p.entry.requestRole).toHaveBeenCalledExactlyOnceWith({
      user,
      queue: "auction",
      sourceCode: "chat",
      firstName,
    });
    expect(p.identity.resolveIdentity).not.toHaveBeenCalled();
    expect(outcome.screen).toEqual({ kind: "denied", reason: "not-admitted" });
  });

  it("opens the menu for an admitted person and FAQ before its completion", async () => {
    const p = ports(identity({ rights: GUEST }));
    const retry = () =>
      routeAuctionCallback({ ports: p, user, data: startCallback() });
    expect((await retry()).screen).toEqual({ kind: "menu" });
    vi.mocked(p.faq.acknowledged).mockResolvedValue(false);
    expect((await retry()).screen).toEqual({ kind: "faq" });
    expect(p.faq.acknowledge).not.toHaveBeenCalled();
  });

  // `/start s_` несёт канал с пустым кодом: повтор его не теряет и не
  // становится нечитаемой кнопкой.
  it("keeps an empty channel code through the retry", async () => {
    const down = ports(new ConnectError("offline", Code.Unavailable));
    const failed = await routeAuctionStart({
      ports: down,
      user,
      firstName,
      sourceCode: "",
    });
    if (
      failed.screen.kind !== "unavailable" ||
      failed.screen.exit.kind !== "enter"
    )
      throw new Error("expected the entry retry frame");
    const p = ports(identity({ rights: [] }));
    await routeAuctionCallback({
      ports: p,
      user,
      data: failed.screen.exit.data,
    });
    expect(p.entry.requestRole).toHaveBeenCalledExactlyOnceWith({
      user,
      queue: "auction",
      sourceCode: "",
      firstName,
    });
  });

  it("offers the same retry when the entry fails again", async () => {
    const p = ports(new ConnectError("offline", Code.Unavailable));
    const data = startCallback("chat");
    expect(
      (await routeAuctionCallback({ ports: p, user, data })).screen,
    ).toEqual({ kind: "unavailable", exit: { kind: "enter", data } });
  });
});

// Ответ на вопрос в кнопку не помещается: повтора у кадра нет, ответ
// присылают ещё раз.
describe("routeAuctionReply", () => {
  it("asks to send the answer again when Identity is unavailable", async () => {
    const outcome = await routeAuctionReply({
      ports: ports(new ConnectError("offline", Code.Unavailable)),
      user,
      data: QUESTION_STEP,
      text: "1 500",
    });
    expect(outcome.screen).toEqual({
      kind: "unavailable",
      exit: { kind: "answer" },
    });
  });
});
