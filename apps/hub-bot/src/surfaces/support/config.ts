import { type Env, type Loaded, reader } from "../../core/config.js";

// Своё у поверхности поддержки — супергруппа операторов с темами (ADR-068,
// п. 4). Токены, среда, пояс сообщества, Identity и шина — общая конфигурация
// процесса (`src/core/config.ts`).
export type SupportConfig = {
  groupId: number;
};

// Id супергруппы в Bot API — `-100` и номер канала. Умолчания нет: бот без
// группы не знает, куда класть темы, а чужая группа увидела бы переписку.
const supergroupId = /^-100\d+$/;

export function readSupportConfig(env: Env): Loaded<SupportConfig> {
  const raw = reader(env)("BOT_SUPPORT_GROUP_ID");
  if (raw === undefined) {
    return { ok: false, error: "BOT_SUPPORT_GROUP_ID is not set" };
  }
  const groupId = Number(raw);
  if (!supergroupId.test(raw) || !Number.isSafeInteger(groupId)) {
    return {
      ok: false,
      error: "BOT_SUPPORT_GROUP_ID must be a supergroup id like -100…",
    };
  }
  return { ok: true, config: { groupId } };
}
