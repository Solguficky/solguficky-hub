import type { Person } from "../../apps/hub-bot/src/surfaces/hub/application/types.js";
import type {
  AuctionConsoles,
  LotAdministration,
  MeetupAuctions,
} from "../../apps/hub-bot/src/surfaces/hub/auction/port.js";
import type { IdentityResolver } from "../../apps/hub-bot/src/surfaces/hub/identity/port.js";
import type {
  MeetupResult,
  MeetupSnapshot,
  Meetups,
} from "../../apps/hub-bot/src/surfaces/hub/meetups/port.js";
import type { Catalog } from "./catalog.js";

// Наполнение аукциона stage по каталогу (PER-613). Вызовы — те же порты, что у
// формы сходки и формы лота бота хаба, от имени администратора, которого
// Identity разрешает по Telegram id: Auction и Meetups решают право сами, и
// путь в обход их проверок здесь не строится. Сроки недели, «Счастливые часы»,
// розыгрыш и открытие недели — пульт администратора, их команда не задаёт.
// Аукцион рождается скрытым от участников (ADR-047, дополнение 2026-10-20), и
// последний шаг его публикует (PER-673): прогон stage показывает лоты.

export type SeedPorts = {
  identity: IdentityResolver;
  meetups: Pick<
    Meetups,
    "createDraft" | "changeAttributes" | "setSchedule" | "publish"
  >;
  auctions: Pick<MeetupAuctions, "enableAuction"> &
    Pick<
      LotAdministration,
      "createLotCard" | "editLotCard" | "addLot" | "scheduleLot"
    > &
    Pick<AuctionConsoles, "publishAuction">;
  newId: () => string;
  log: (line: string) => void;
};

export type SeededLot = { title: string; lotId: string };

export type SeedResult = {
  meetupId: string;
  auctionId: string;
  lots: readonly SeededLot[];
};

/**
 * Отказ посреди наполнения: что уже заведено, остаётся заведённым, а сообщение
 * называет шаг и лот, на котором наполнение остановилось.
 */
export class SeedError extends Error {
  readonly step: string;
  readonly lot: number | undefined;

  constructor(step: string, outcome: string, lot?: number) {
    super(
      lot === undefined
        ? `наполнение остановилось на шаге «${step}»: ${outcome}`
        : `наполнение остановилось на лоте ${lot}, шаг «${step}»: ${outcome}`,
    );
    this.name = "SeedError";
    this.step = step;
    this.lot = lot;
  }
}

const rub = (rubles: number) => ({ minorUnits: rubles * 100, currency: "RUB" });

export async function seedAuction(
  catalog: Catalog,
  administratorTelegramUserId: bigint,
  ports: SeedPorts,
): Promise<SeedResult> {
  const { identity, meetups, auctions, newId, log } = ports;

  const resolved = await identity.resolve({
    telegramUserId: administratorTelegramUserId,
  });
  if (resolved.kind !== "resolved") {
    throw new SeedError("разрешение администратора", describe(resolved));
  }
  if (resolved.blocked) {
    throw new SeedError("разрешение администратора", "человек заблокирован");
  }
  const person: Person = {
    identityId: resolved.identityId,
    rights: resolved.rights,
  };

  const meetupStep = async (
    step: string,
    run: () => Promise<MeetupResult>,
  ): Promise<MeetupSnapshot> => {
    const result = await run();
    if (result.kind !== "ok") throw new SeedError(step, describe(result));
    return result.meetup;
  };

  const { meetup: spec } = catalog;
  let meetup = await meetupStep("черновик сходки", () =>
    meetups.createDraft(person, newId()),
  );
  meetup = await meetupStep("атрибуты сходки", () =>
    meetups.changeAttributes(person, {
      ...meetup,
      title: spec.title,
      description: spec.description,
      venue: spec.venue,
    }),
  );
  meetup = await meetupStep("дата сходки", () =>
    meetups.setSchedule(person, meetup, spec.startsAt),
  );
  meetup = await meetupStep("публикация сходки", () =>
    meetups.publish(person, meetup),
  );
  log(`сходка ${meetup.id} опубликована: «${spec.title}»`);

  const enabled = await auctions.enableAuction(person, meetup.id, newId());
  if (enabled.kind !== "enabled") {
    throw new SeedError("включение аукциона", describe(enabled));
  }
  const auctionId = enabled.auctionId;
  log(`аукцион ${auctionId} включён`);

  const seeded: SeededLot[] = [];
  for (const [index, lot] of catalog.lots.entries()) {
    const number = index + 1;
    const lotId = newId();
    const card = { lotId, title: lot.title, description: lot.description };
    const lotStep = async (
      step: string,
      run: () => Promise<{ kind: string }>,
    ) => {
      const result = await run();
      if (result.kind !== "ok") {
        throw new SeedError(step, describe(result), number);
      }
    };
    await lotStep("карточка", () => auctions.createLotCard(person, card));
    // Создание карточки фото не несёт в порте бота: оно приходит правкой, как
    // во второй вопрос формы лота, и тем же отказом Auction о размере и типе.
    const { image } = lot;
    if (image !== undefined) {
      await lotStep("фото", () =>
        auctions.editLotCard(person, { ...card, image }),
      );
    }
    await lotStep("добавление в аукцион", () =>
      auctions.addLot(person, { auctionId, lotId, opId: newId() }),
    );
    await lotStep("цена и шаг", () =>
      auctions.scheduleLot(person, {
        auctionId,
        lotId,
        opId: newId(),
        startingPrice: rub(lot.startingPriceRubles),
        stepPolicy: { kind: "fixed", step: rub(lot.stepRubles) },
      }),
    );
    seeded.push({ title: lot.title, lotId });
    log(
      `лот ${number}/${catalog.lots.length} заведён: «${lot.title}» ${lotId}`,
    );
  }

  const published = await auctions.publishAuction(person, {
    auctionId,
    opId: newId(),
  });
  if (published.kind !== "ok") {
    throw new SeedError("публикация аукциона", describe(published));
  }
  log(`аукцион ${auctionId} опубликован`);

  return { meetupId: meetup.id, auctionId, lots: seeded };
}

// Исход для человека: вид ответа и, если есть, текст причины. Объект причины
// целиком в строку не идёт — в нём может быть ответ сервиса с заголовками.
function describe(result: { kind: string; cause?: unknown }): string {
  const { cause } = result;
  if (cause instanceof Error) return `${result.kind}: ${cause.message}`;
  return result.kind;
}
