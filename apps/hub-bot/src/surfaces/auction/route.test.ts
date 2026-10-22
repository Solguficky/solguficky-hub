import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  type AccessRequestAnswer,
  type AccessRight,
  encodeAuctionCallback,
  type ResolvedIdentity,
} from "../../auction-ui/index.js";
import {
  type AuctionCatalogPort,
  type AuctionSummary,
  LIST_PAGE_SIZE,
} from "./auctions.js";
import type { EntryPorts } from "./entry-ports.js";
import {
  applyCallback,
  entryCallback,
  listCallback,
  startCallback,
} from "./faq.js";
import {
  routeAuctionReply,
  routeAuctionStart,
  routeAuctionCallback as routeCallback,
} from "./route.js";

const lotId = "01926f3c-8b7a-7cde-8f00-0123456789ab";
const auctionId = "01926f3c-8b7a-7cde-8f00-0123456789ac";
const user = { telegramUserId: 42 };
const firstName = "Сова";

// Имя нужно одной кнопке — «Подать заявку»; остальным нажатиям оно безразлично.
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

// Пускает право смотрящего; те же права уходят в Auction.
const VIEWER_ID = "01926f3c-8b7a-7cde-8f00-00000000000a";
const GUEST: readonly AccessRight[] = ["place-bids"];
const MEMBER: readonly AccessRight[] = ["access-hub", "place-bids"];

function identity(
  overrides: { rights?: readonly AccessRight[]; blocked?: boolean } = {},
): ResolvedIdentity {
  return {
    viewer: { identityId: VIEWER_ID, rights: overrides.rights ?? [] },
    blocked: overrides.blocked ?? false,
  };
}

// Что вход ответил бы человеку с такой личностью: заблокированному —
// `blocked`, с правом аукциона — что оно уже есть, остальным — заявку.
function entered(resolved: ResolvedIdentity): AccessRequestAnswer {
  const { rights } = resolved.viewer;
  return {
    viewer: {
      identityId: resolved.viewer.identityId,
      rights: resolved.blocked ? [] : rights,
    },
    outcome: resolved.blocked
      ? "blocked"
      : rights.includes("place-bids")
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
      requestAccess: vi.fn(async () => {
        if (resolved instanceof Error) throw resolved;
        return entered(resolved);
      }),
    },
    auction: {
      findLot: async () => undefined,
      getLot: vi.fn(async () => ({
        lotId,
        auctionId,
        version: 3,
        proxyEnabled: false,
        status: { kind: "unsold" as const },
      })),
      listAuctionLots: vi.fn(async () => ({ lots: [], nextPageToken: "" })),
      listLotHistory: vi.fn(async () => ({ entries: [], nextPageToken: "" })),
      getOwnDisplayName: async () => ({ text: "@fake", frozen: false }),
      getDisplayNames: vi.fn(async () => ({})),
      placeBid: vi.fn(async () => ({
        kind: "accepted" as const,
        lotVersion: 0,
      })),
      setProxyLimit: vi.fn(async () => ({
        kind: "accepted" as const,
        lotVersion: 0,
      })),
      chooseDisplayName: vi.fn(async () => ({
        kind: "accepted" as const,
        name: "@owl",
      })),
      getAuction: vi.fn(async () => undefined),
      getRaffle: vi.fn(async () => undefined),
      registerForRaffle: vi.fn(async () => {
        throw new Error("not used");
      }),
      cancelRaffleRegistration: vi.fn(async () => {
        throw new Error("not used");
      }),
      getMyPredictions: vi.fn(async () => []),
      getPredictionResults: vi.fn(async () => {
        throw new Error("not used");
      }),
      submitPrediction: vi.fn(async () => {
        throw new Error("not used");
      }),
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
    ).toEqual({ kind: "welcome" });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
    vi.mocked(p.identity.resolveIdentity).mockResolvedValue(
      identity({ rights: GUEST }),
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
    const p = ports(identity({ rights: [...MEMBER, "manage-members"] }));
    expect(await routeAuctionStart({ ports: p, user, firstName })).toEqual({
      screen: { kind: "denied", reason: "in-community" },
      identityId: VIEWER_ID,
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
    // `/start` разрешает личность один раз и заявки не ставит (PER-592).
    expect(p.identity.resolveIdentity).toHaveBeenCalledTimes(1);
    expect(p.entry.requestAccess).not.toHaveBeenCalled();
  });

  // Вход открывает корневое меню: из него видно всё, что доступно (PER-592).
  it("shows the menu to a returning participant", async () => {
    const p = ports(identity({ rights: GUEST }));
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({ kind: "menu" });
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
      ).toMatchObject({ kind: "auctions" });
    }
    expect(p.faq.acknowledge).toHaveBeenCalledTimes(2);
    expect(p.faq.acknowledge).toHaveBeenCalledWith({
      identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
      rights: ["place-bids"],
    });
  });

  // «‹ Меню» и прежние кнопки «Меню» открывают корневое меню и отметку не
  // ставят. Отметкой меню не закрыто: иначе «‹ Меню» с FAQ вернула бы в FAQ;
  // разделы за ним закрыты ею по-прежнему (PER-592).
  it("opens the menu from a menu button without recording completion", async () => {
    const p = ports(identity({ rights: GUEST }));
    const menu = () =>
      routeAuctionCallback({ ports: p, user, data: entryCallback("menu") });
    const shown = { kind: "menu" };
    expect((await menu()).screen).toEqual(shown);
    vi.mocked(p.faq.acknowledged).mockResolvedValue(false);
    expect((await menu()).screen).toEqual(shown);
    expect(p.faq.acknowledge).not.toHaveBeenCalled();
    expect(p.catalog.listAuctions).not.toHaveBeenCalled();
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
      ).toEqual({ kind: "welcome" });
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
        rights: ["place-bids"],
      },
      listing: "active",
      pageToken: "",
    });
    expect(p.auction.listAuctionLots).not.toHaveBeenCalled();
  });

  // «Настройки» (PER-595): имя выбирается в идущем аукционе — ближайшем
  // активном; без активного пункта имени нет, а без Notifications — частоты.
  it("opens the settings with the name in the nearest active auction", async () => {
    const later = {
      ...summary(2, "scheduled"),
      opensAt: "2026-11-01T09:00:00Z",
    };
    const nearest = summary(1, "prebidding");
    const withAuctions = await routeAuctionCallback({
      ports: ports(admitted, { active: [later, nearest] }),
      user,
      data: entryCallback("settings"),
    });
    expect(withAuctions.screen).toEqual({
      kind: "settings",
      notifications: false,
      auctionId: nearest.auctionId,
    });
    const without = await routeAuctionCallback({
      ports: ports(admitted),
      user,
      data: entryCallback("settings"),
    });
    expect(without.screen).toEqual({ kind: "settings", notifications: false });
    // Сбой списка убирает пункт имени, а не раздел: частота от Auction не
    // зависит.
    const failing = ports(admitted, { active: [nearest] });
    failing.catalog.listAuctions = vi.fn(async () => {
      throw new Error("auction is down");
    });
    const degraded = await routeAuctionCallback({
      ports: failing,
      user,
      data: entryCallback("settings"),
    });
    expect(degraded.screen).toEqual({ kind: "settings", notifications: false });
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

  // Корень аукциона возвращает в тот список, где аукцион стоит сейчас
  // (PER-644): лента под корнем, и её возврат ставит тело дерева.
  it("returns the auction root to the list where its auction stands now", async () => {
    const live = summary(0, "prebidding");
    const rootOf = (id: string) =>
      encodeAuctionCallback({ kind: "root", auctionId: id });
    expect(
      (
        await routeAuctionCallback({
          ports: ports(admitted, { active: [live] }),
          user,
          data: rootOf(live.auctionId),
        })
      ).screen,
    ).toMatchObject({ kind: "auction", parent: "auctions" });
    expect(
      (
        await routeAuctionCallback({
          ports: ports(admitted),
          user,
          data: rootOf(live.auctionId),
        })
      ).screen,
    ).toMatchObject({ kind: "auction", parent: "past" });
    const feed = await routeAuctionCallback({
      ports: ports(admitted, { active: [live] }),
      user,
      data: feedButton,
    });
    expect(feed.screen).toMatchObject({ kind: "auction" });
    expect(feed.screen).not.toHaveProperty("parent");
  });

  // Избранное открывается только из корня аукциона (PER-644): кнопка списка
  // без аукциона — из прежнего меню или набранная `/favorites` — получает
  // кадр устаревшего экрана и Notifications не зовёт.
  it("treats a favorites button without an auction as outdated", async () => {
    const p = ports(admitted);
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: encodeAuctionCallback({ kind: "favorites", page: 0 }),
    });
    expect(outcome.screen).toEqual({ kind: "outdated" });
    expect(p.identity.resolveIdentity).not.toHaveBeenCalled();
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
      rights: ["place-bids"],
    });
  });

  it("denies a person without the auction right before calling Auction", async () => {
    const p = ports(identity({ rights: [] }));
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: lotButton,
    });
    expect(outcome.screen).toEqual({ kind: "welcome" });
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

// `/start` заявку не ставит (PER-592, дополнение ADR-060): он разрешает
// личность, а человеку без права отвечает приветствием, и код канала едет в
// кнопке «Подать заявку».
describe("routeAuctionStart", () => {
  it("welcomes a person without the right and applies nowhere", async () => {
    const p = ports(identity({ rights: [] }));
    const outcome = await routeAuctionStart({
      ports: p,
      user: { telegramUserId: 42, telegramUsername: "owl" },
      firstName,
      sourceCode: "chat",
    });
    expect(p.entry.requestAccess).not.toHaveBeenCalled();
    expect(p.identity.resolveIdentity).toHaveBeenCalledExactlyOnceWith({
      telegramUserId: 42,
      telegramUsername: "owl",
    });
    expect(outcome).toEqual({
      screen: { kind: "welcome", sourceCode: "chat" },
      identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
    });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
  });

  // Присутствие кода значимо: пустой код после `s_` едет пустой строкой, а
  // payload без префикса поля не несёт.
  it.each([
    ["", { sourceCode: "" }],
    [undefined, {}],
  ])(
    "carries the channel code %j into the welcome",
    async (sourceCode, expected) => {
      const p = ports(identity({ rights: [] }));
      const outcome = await routeAuctionStart({
        ports: p,
        user,
        firstName,
        ...(sourceCode === undefined ? {} : { sourceCode }),
      });
      expect(outcome.screen).toEqual({ kind: "welcome", ...expected });
    },
  );

  it("opens the menu for a person the allowlist has just admitted", async () => {
    const p = ports(identity({ rights: GUEST }));
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({ kind: "menu" });
  });

  it("fails closed when Identity is unavailable", async () => {
    const p = ports(new ConnectError("offline", Code.Unavailable));
    const outcome = await routeAuctionStart({
      ports: p,
      user,
      firstName,
      sourceCode: "chat",
    });
    // Повтор `/start` несёт код канала: приветствие не теряет источник.
    expect(outcome.screen).toEqual({
      kind: "unavailable",
      exit: { kind: "enter", data: startCallback("chat") },
    });
    expect(outcome.failure?.category).toBe("dependency_unavailable");
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
  });
});

// «Подать заявку» — единственное действие, которое зовёт `RequestAccess`:
// очередь аукциона, код канала из кнопки и имя для карточки модератора.
describe("apply", () => {
  it("puts the application into the auction queue with the channel code and the first name", async () => {
    const p = ports(identity({ rights: [] }));
    const outcome = await routeAuctionCallback({
      ports: p,
      user: { telegramUserId: 42, telegramUsername: "owl" },
      data: applyCallback("chat"),
    });
    expect(p.entry.requestAccess).toHaveBeenCalledExactlyOnceWith({
      user: { telegramUserId: 42, telegramUsername: "owl" },
      queue: "auction",
      sourceCode: "chat",
      firstName,
    });
    expect(p.identity.resolveIdentity).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      screen: { kind: "denied", reason: "not-admitted" },
      identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
    });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
  });

  it.each([
    ["", { sourceCode: "" }],
    [undefined, {}],
  ])("passes the channel code %j as received", async (sourceCode, expected) => {
    const p = ports(identity({ rights: [] }));
    await routeAuctionCallback({
      ports: p,
      user,
      data: applyCallback(sourceCode),
    });
    expect(p.entry.requestAccess).toHaveBeenCalledExactlyOnceWith({
      user,
      queue: "auction",
      firstName,
      ...expected,
    });
  });

  it("opens the menu for a person the allowlist has just admitted", async () => {
    const p = ports(identity({ rights: [] }));
    vi.mocked(p.entry.requestAccess).mockResolvedValue({
      ...entered(identity({ rights: GUEST })),
      outcome: "granted-by-allowlist",
    });
    expect(
      (
        await routeAuctionCallback({
          ports: p,
          user,
          data: applyCallback(),
        })
      ).screen,
    ).toEqual({ kind: "menu" });
  });

  it("answers a declined application with a refusal of its own", async () => {
    const p = ports(identity({ rights: [] }));
    vi.mocked(p.entry.requestAccess).mockResolvedValue({
      ...entered(identity({ rights: [] })),
      outcome: "declined",
    });
    expect(
      (
        await routeAuctionCallback({
          ports: p,
          user,
          data: applyCallback(),
        })
      ).screen,
    ).toEqual({ kind: "denied", reason: "declined" });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
  });

  it("fails closed on an outcome it does not know, whatever the rights", async () => {
    const p = ports(identity({ rights: GUEST }));
    vi.mocked(p.entry.requestAccess).mockResolvedValue({
      ...entered(identity({ rights: GUEST })),
      outcome: "unspecified",
    });
    expect(
      await routeAuctionCallback({ ports: p, user, data: applyCallback() }),
    ).toEqual({
      screen: {
        kind: "unavailable",
        exit: { kind: "enter", data: applyCallback() },
      },
      identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
      failure: {
        category: "invariant",
        message: "identity answered an unknown access request outcome",
      },
    });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
  });

  // Повтор заявки несёт тот же код канала: заявка не теряет источник.
  it("offers the same application again when Identity is unavailable", async () => {
    const p = ports(new ConnectError("offline", Code.Unavailable));
    const data = applyCallback("chat");
    const outcome = await routeAuctionCallback({ ports: p, user, data });
    expect(outcome.screen).toEqual({
      kind: "unavailable",
      exit: { kind: "enter", data },
    });
    expect(outcome.failure?.category).toBe("dependency_unavailable");
  });
});

// «Повторить» под кадром «недоступно» после `/start` — тот же `/start`:
// личность разрешается заново, а код канала доживает до кнопки заявки.
describe("entry retry", () => {
  it("welcomes again with the channel code and applies nowhere", async () => {
    const p = ports(identity({ rights: [] }));
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: startCallback("chat"),
    });
    expect(p.entry.requestAccess).not.toHaveBeenCalled();
    expect(outcome.screen).toEqual({ kind: "welcome", sourceCode: "chat" });
  });

  it("opens FAQ until it is read and the menu after", async () => {
    const p = ports(identity({ rights: GUEST }));
    const retry = () =>
      routeAuctionCallback({ ports: p, user, data: startCallback() });
    expect((await retry()).screen).toMatchObject({ kind: "menu" });
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
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: failed.screen.exit.data,
    });
    expect(outcome.screen).toEqual({ kind: "welcome", sourceCode: "" });
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
