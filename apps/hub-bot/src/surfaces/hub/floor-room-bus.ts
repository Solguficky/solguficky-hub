import { Kvm } from "@nats-io/kv";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { natsConnectOptions } from "../../core/delivery/index.js";
import {
  createKvRoom,
  type FloorRoomStore,
  type RoomKv,
} from "./application/floor-room.js";

// Bucket состава зала (ADR-070, дополнение 2026-10-29). Объявляет его таблица
// топологии AppHost (ADR-050) со сроком записи двое суток: бот только
// привязывается к нему.
export const floorRoomBucket = "hub-bot-floor-room";

/**
 * Состав зала в JetStream KV. Соединение открывается при первом обращении и
 * живёт до остановки процесса: боту без шины состав просто недоступен, и
 * экран помощника говорит об этом, а не роняет процесс. Отказ открытия не
 * запоминается — следующее нажатие пробует снова.
 */
export function createFloorRoomBus(url: string): {
  store: FloorRoomStore;
  close(): Promise<void>;
} {
  let opened: Promise<{ nats: NatsConnection; kv: RoomKv }> | undefined;
  const open = () => {
    opened ??= (async () => {
      const nats = await connect({
        ...natsConnectOptions(url),
        name: "hub-bot-floor-room",
        maxReconnectAttempts: -1,
      });
      try {
        const kv = await new Kvm(nats).open(floorRoomBucket);
        await kv.status();
        return { nats, kv };
      } catch (cause) {
        await nats.close();
        throw cause;
      }
    })().catch((cause: unknown) => {
      opened = undefined;
      throw cause;
    });
    return opened;
  };
  return {
    store: createKvRoom(async () => (await open()).kv),
    async close() {
      const current = opened;
      opened = undefined;
      if (current === undefined) return;
      const { nats } = await current.catch(() => ({ nats: undefined }));
      if (nats !== undefined && !nats.isClosed()) {
        await nats.drain().catch(() => nats.close());
      }
    },
  };
}
