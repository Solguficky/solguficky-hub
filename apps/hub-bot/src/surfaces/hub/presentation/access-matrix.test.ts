import type { Update } from "grammy/types";
import { createHarness } from "../../../../testkit/harness.js";
import {
  type AccessAnswer,
  type AccessMatrixInput,
  describeAccessMatrix,
} from "../../../auction-ui/contract/index.js";
import {
  blockedHubAccessText,
  declinedHubAccessText,
  pendingHubAccessText,
} from "../application/hub-access.js";
import { refusalText } from "./screens/kit.js";

// Матрица доступа пакета над ботом хаба целиком (ADR-044, «Проверка общего
// поведения»; ADR-060): update проходит тот же `createBot`, что и в проде, а
// Identity и Auction подменены шпионами матрицы. Ответ читается с экрана,
// который получил человек, — по тексту кадра, а не по решению политики.

function updateOf({ from, firstName, action }: AccessMatrixInput): Update {
  const sender = {
    id: from.telegramUserId,
    is_bot: false,
    first_name: firstName,
    ...(from.telegramUsername === undefined
      ? {}
      : { username: from.telegramUsername }),
  };
  const chat = {
    id: from.telegramUserId,
    type: "private" as const,
    first_name: firstName,
  };
  if (action.kind === "callback") {
    return {
      update_id: 1,
      callback_query: {
        id: "press",
        chat_instance: "chat",
        from: sender,
        data: action.data,
        message: { message_id: 9, date: 0, chat },
      },
    };
  }
  return {
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat,
      from: sender,
      text:
        action.sourceCode === undefined
          ? "/start"
          : `/start s_${action.sourceCode}`,
    },
  };
}

describeAccessMatrix("hub bot", "hub", (ports) => async (input) => {
  const { bot, calls, records } = createHarness(
    {
      async resolve({ telegramUserId, telegramUsername }) {
        const resolved = await ports.identity.resolveIdentity({
          telegramUserId: Number(telegramUserId),
          ...(telegramUsername === undefined ? {} : { telegramUsername }),
        });
        return {
          kind: "resolved",
          ...resolved.viewer,
          rights: resolved.rights,
          blocked: resolved.blocked,
        };
      },
      async requestRole({ telegramUserId, telegramUsername, ...request }) {
        const answered = await ports.entry.requestRole({
          user: {
            telegramUserId: Number(telegramUserId),
            ...(telegramUsername === undefined ? {} : { telegramUsername }),
          },
          ...request,
        });
        return {
          kind: "answered",
          ...answered.viewer,
          rights: answered.rights,
          outcome: answered.outcome,
        };
      },
    },
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    {
      auction: {
        screenPorts: () => ({
          auction: ports.auction,
          operations: ports.operations,
          // Байты фото доступу не нужны: карточка уходит без изображения.
          image: {
            getLotImage: () => Promise.reject(new Error("no image here")),
          },
        }),
      },
    },
  );
  await bot.init();
  await bot.handleUpdate(updateOf(input));

  const boundary = records.find((record) => record.fields.result !== undefined);
  if (boundary === undefined) throw new Error("the update left no boundary");
  const identityId = String(boundary.fields.identity_id);
  const shown = calls.flatMap((call) =>
    "text" in call.payload && typeof call.payload.text === "string"
      ? [call.payload.text]
      : [],
  );
  const frames: ReadonlyArray<[string, AccessAnswer]> = [
    [pendingHubAccessText(identityId, undefined), "pending"],
    [declinedHubAccessText, "declined"],
    [blockedHubAccessText, "blocked"],
  ];
  for (const [text, answer] of frames) {
    if (shown.includes(refusalText(text))) return answer;
  }
  // Запись границы без единого сообщения — не ответ человеку: «ok» в логе
  // ещё не значит, что он что-то увидел.
  const answered = calls.some(
    (call) =>
      call.method === "sendMessage" || call.method === "editMessageText",
  );
  if (!answered) throw new Error("the person got no answer");
  return boundary.fields.result === "ok" ? "admitted" : "unavailable";
});
