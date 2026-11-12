import type { KV } from "@nats-io/kv";
import { z } from "zod";

// Состав зала (PER-816, ADR-070, дополнение 2026-10-29): люди, которые сейчас
// в зале, набирает помощник. Ставка зала идёт только за человека из состава —
// это защита от миссклика вместо подтверждения на каждую ставку. Состав
// хранится по аукциону и переживает рестарт бота: bucket JetStream KV
// `hub-bot-floor-room` с сроком записи двое суток (топология AppHost, ADR-050).

/** Человек состава: личность Identity и ник, по которому его нашли. */
export type RoomMember = { identityId: string; username?: string };

// Найденный поиском: имя в аукционе — подсказка кнопке, в состав не пишется.
export type FoundMember = RoomMember & { auctionName?: string };

export type RoomRead =
  | { kind: "ok"; members: readonly RoomMember[] }
  | { kind: "unavailable"; cause?: unknown };
export type RoomWrite =
  | { kind: "ok" }
  | { kind: "unavailable"; cause?: unknown };

export type FloorRoomStore = {
  read(auctionId: string): Promise<RoomRead>;
  add(auctionId: string, member: RoomMember): Promise<RoomWrite>;
  remove(auctionId: string, identityId: string): Promise<RoomWrite>;
};

/** Не больше людей, чем помещается на экране помощника (ADR-070: меньше 10). */
export const roomLimit = 20;

function withMember(
  members: readonly RoomMember[],
  member: RoomMember,
): RoomMember[] {
  const rest = members.filter((each) => each.identityId !== member.identityId);
  return [...rest, member].slice(-roomLimit);
}

function without(
  members: readonly RoomMember[],
  identityId: string,
): RoomMember[] {
  return members.filter((each) => each.identityId !== identityId);
}

/** Состав в памяти процесса: для процесса без шины и для тестов. */
export function createMemoryRoom(): FloorRoomStore {
  const rooms = new Map<string, RoomMember[]>();
  return {
    async read(auctionId) {
      return { kind: "ok", members: rooms.get(auctionId) ?? [] };
    },
    async add(auctionId, member) {
      rooms.set(auctionId, withMember(rooms.get(auctionId) ?? [], member));
      return { kind: "ok" };
    },
    async remove(auctionId, identityId) {
      rooms.set(auctionId, without(rooms.get(auctionId) ?? [], identityId));
      return { kind: "ok" };
    },
  };
}

export type RoomKv = Pick<KV, "get" | "create" | "update">;

const StoredSchema = z.array(
  z.object({ i: z.string().min(1), u: z.string().min(1).optional() }),
);

// Bucket — общее хранилище, и прочитанное оттуда — ввод: запись не той формы
// считается пустым составом.
function parse(raw: string): RoomMember[] {
  try {
    const parsed = StoredSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return [];
    return parsed.data.map((each) =>
      each.u === undefined
        ? { identityId: each.i }
        : { identityId: each.i, username: each.u },
    );
  } catch {
    return [];
  }
}

function serialize(members: readonly RoomMember[]): string {
  return JSON.stringify(
    members.map((each) =>
      each.username === undefined
        ? { i: each.identityId }
        : { i: each.identityId, u: each.username },
    ),
  );
}

const attempts = 4;

/**
 * Состав в JetStream KV. Запись — чтение с ревизией и обновление по ней:
 * два помощника, правящие состав одновременно, не затирают друг друга, а
 * проигравший по ревизии читает заново.
 */
export function createKvRoom(open: () => Promise<RoomKv>): FloorRoomStore {
  const key = (auctionId: string) => `room.${auctionId}`;
  async function change(
    auctionId: string,
    edit: (members: readonly RoomMember[]) => RoomMember[],
  ): Promise<RoomWrite> {
    try {
      const kv = await open();
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const entry = await kv.get(key(auctionId));
        const present = entry !== null && entry.operation === "PUT";
        const next = serialize(edit(present ? parse(entry.string()) : []));
        try {
          if (present) await kv.update(key(auctionId), next, entry.revision);
          else await kv.create(key(auctionId), next);
          return { kind: "ok" };
        } catch (cause) {
          // Ревизия ушла вперёд: читаем заново. Иной отказ — недоступность.
          if (attempt === attempts - 1 || !isRevisionConflict(cause)) {
            throw cause;
          }
        }
      }
      return { kind: "unavailable" };
    } catch (cause) {
      return { kind: "unavailable", cause };
    }
  }
  return {
    async read(auctionId) {
      try {
        const entry = await (await open()).get(key(auctionId));
        return {
          kind: "ok",
          members:
            entry === null || entry.operation !== "PUT"
              ? []
              : parse(entry.string()),
        };
      } catch (cause) {
        return { kind: "unavailable", cause };
      }
    },
    add: (auctionId, member) =>
      change(auctionId, (members) => withMember(members, member)),
    remove: (auctionId, identityId) =>
      change(auctionId, (members) => without(members, identityId)),
  };
}

function isRevisionConflict(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /wrong last sequence|key exists|10071/i.test(text);
}
