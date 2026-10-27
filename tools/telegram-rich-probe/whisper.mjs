#!/usr/bin/env node

// Зонд шёпота в группе (PER-680): ставит невидимые команды в scope группы и
// отвечает на них и на нажатия эфемерными сообщениями. Каждый update и ответ
// сервера печатается строкой JSON; токен в вывод не попадает.

const token = process.env["HUB_BOT_TOKEN"];
const groupChatId = process.env["GROUP_CHAT_ID"];
const lateDelayMs = Number(process.env["LATE_DELAY_MS"] ?? "10000");

if (token === undefined || token === "" || groupChatId === undefined || groupChatId === "") {
  process.stderr.write("HUB_BOT_TOKEN and GROUP_CHAT_ID are required\n");
  process.exit(2);
}

const apiRoot = `https://api.telegram.org/bot${token}`;

function print(kind, data) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), kind, data })}\n`);
}

async function call(method, body) {
  const response = await fetch(`${apiRoot}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json();
  if (method !== "getUpdates") {
    print("call", { method, body, http_status: response.status, response: payload });
  }
  return payload;
}

function keyboard(rows) {
  return { inline_keyboard: rows.map((row) => row.map(([text, callback_data]) => ({ text, callback_data }))) };
}

const whisperKeyboard = keyboard([
  [["Нажми", "per680:tap"], ["Правь меня", "per680:edit"]],
  [["Удали меня", "per680:del"]],
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;

// /whisper и /late невидимые, /loud и /public — обычные, для сравнения.
const commands = [
  { command: "whisper", description: "PER-680 невидимая", is_ephemeral: true },
  { command: "late", description: "PER-680 ответ с задержкой", is_ephemeral: true },
  { command: "loud", description: "PER-680 обычная" },
];

// "/whisper", "/whisper@bot" и "/whisper аргументы" — да, "/whisperx" — нет.
function commandOf(text) {
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/.exec(text);
  return match === null ? undefined : match[1];
}

async function whisperBack(message) {
  counter += 1;
  await call("sendMessage", {
    chat_id: message.chat.id,
    text: `PER-680 шёпот ${counter} в ответ на команду`,
    reply_parameters: { ephemeral_message_id: message.ephemeral_message_id },
    ephemeral_message_parameters: { receiver_user_id: message.from.id },
    reply_markup: whisperKeyboard,
  });
}

async function onMessage(message) {
  const command = commandOf(message.text ?? "");
  const chatId = message.chat.id;
  if (message.ephemeral_message_id !== undefined && command === "whisper") {
    await whisperBack(message);
  } else if (message.ephemeral_message_id !== undefined && command === "late") {
    // Задержка не держит цикл getUpdates: у остальных действий своё 15-секундное окно.
    // Без catch сетевой отказ здесь уронил бы процесс, не вернув команды группы.
    sleep(lateDelayMs)
      .then(() => whisperBack(message))
      .catch((error) => print("late-failed", String(error)));
  } else if (command === "public") {
    await call("sendMessage", {
      chat_id: chatId,
      text: "PER-680 публичная карточка: кнопки отвечают шёпотом",
      reply_markup: keyboard([[["Шепни мне", "per680:pub"], ["Шепни вместо карточки", "per680:replace"]]]),
    });
  }
}

async function onCallback(query) {
  const chatId = query.message?.chat.id;
  const ephemeralMessageId = query.message?.ephemeral_message_id;
  await call("answerCallbackQuery", { callback_query_id: query.id });
  switch (query.data) {
    case "per680:tap":
    case "per680:pub":
    case "per680:replace":
      counter += 1;
      await call("sendMessage", {
        chat_id: chatId,
        text: `PER-680 шёпот ${counter} по нажатию ${query.data}`,
        ephemeral_message_parameters: {
          receiver_user_id: query.from.id,
          callback_query_id: query.id,
          replace_callback_query_message: query.data === "per680:replace",
        },
        reply_markup: whisperKeyboard,
      });
      break;
    case "per680:edit":
      await call("editEphemeralMessageText", {
        chat_id: chatId,
        receiver_user_id: query.from.id,
        ephemeral_message_id: ephemeralMessageId,
        text: `PER-680 шёпот отредактирован в ${new Date().toISOString()}`,
        reply_markup: whisperKeyboard,
      });
      break;
    case "per680:del":
      await call("deleteEphemeralMessage", {
        chat_id: chatId,
        receiver_user_id: query.from.id,
        ephemeral_message_id: ephemeralMessageId,
      });
      break;
  }
}

// Команды зонда заменяют список группы только на время прогона: при остановке
// возвращается прежний, иначе в меню остались бы команды, которых бот не обрабатывает.
const scope = { type: "chat", chat_id: Number(groupChatId) };
const previous = await call("getMyCommands", { scope });
const previousCommands = previous.ok === true ? previous.result : [];

async function restoreCommands() {
  if (previousCommands.length === 0) {
    await call("deleteMyCommands", { scope });
  } else {
    await call("setMyCommands", { scope, commands: previousCommands });
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restoreCommands().finally(() => process.exit(0));
  });
}

const installed = await call("setMyCommands", { scope, commands });
if (installed.ok !== true) {
  process.stderr.write(`setMyCommands failed: ${installed.description ?? "unknown error"}\n`);
  process.exit(1);
}

let offset = 0;
for (;;) {
  const updates = await call("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }).catch(
    (error) => ({ ok: false, description: String(error) }),
  );
  if (updates.ok !== true) {
    print("getUpdates", updates);
    await restoreCommands();
    process.exit(1);
  }
  for (const update of updates.result) {
    offset = update.update_id + 1;
    print("update", update);
    if (update.message !== undefined) {
      await onMessage(update.message);
    }
    if (update.callback_query !== undefined) {
      await onCallback(update.callback_query);
    }
  }
}
