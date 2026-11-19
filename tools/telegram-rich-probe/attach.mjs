#!/usr/bin/env node

// Зонд прикрепления из чата (PER-885): ставит невидимую команду `/attach` в
// scope группы, отвечает на неё шёпотом с кнопками выбора сходки и правит
// шёпот по нажатию. Отвечает на три вопроса:
//   1. доходит ли до бота текст невидимой команды с аргументом;
//   2. укладывается ли выбор сходки кнопкой на шёпоте в окно ответа — правка
//      сразу, через 12 и через 20 секунд после нажатия;
//   3. несёт ли `callback_query.message` шёпота его `text`.
// Каждый update и ответ сервера печатается строкой JSON, строки `probe` —
// выжимка по вопросам; токен в вывод не попадает.

const token = process.env["HUB_BOT_TOKEN"];
const groupChatId = process.env["GROUP_CHAT_ID"];

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

// Задержка правки после нажатия: 0, 12 и 20 секунд.
const picks = { a: 0, b: 12_000, c: 20_000 };
const pickKeyboard = keyboard([
  [["Сходка A — сразу", "per885:pick:a"]],
  [["Сходка B — правка через 12 с", "per885:pick:b"]],
  [["Сходка C — правка через 20 с", "per885:pick:c"]],
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const commands = [{ command: "attach", description: "PER-885 прикрепить ссылку к сходке", is_ephemeral: true }];

// "/attach", "/attach@bot" и "/attach аргументы"; хвост — всё после команды.
function parseCommand(text) {
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  return match === null ? undefined : { name: match[1], rest: (match[2] ?? "").trim() };
}

// Ссылка — первое слово, название — остальное, как в постановке.
function splitArgument(rest) {
  const space = rest.search(/\s/);
  return space === -1
    ? { link: rest, title: "" }
    : { link: rest.slice(0, space), title: rest.slice(space).trim() };
}

async function onMessage(message, receivedAt) {
  const command = parseCommand(message.text ?? "");
  if (command?.name !== "attach") return;
  const { link, title } = splitArgument(command.rest);
  print("probe", {
    question: 1,
    ephemeral: message.ephemeral_message_id !== undefined,
    text_length: (message.text ?? "").length,
    argument_length: command.rest.length,
    link_present: link !== "",
    title_length: title.length,
    lag_ms: receivedAt - message.date * 1_000,
  });
  if (message.ephemeral_message_id === undefined) return;
  await call("sendMessage", {
    chat_id: message.chat.id,
    text: `PER-885 Прикрепить материал?\nСсылка: ${link || "—"}\nНазвание: ${title || "—"}\n\nВыбери сходку.`,
    reply_parameters: { ephemeral_message_id: message.ephemeral_message_id },
    ephemeral_message_parameters: { receiver_user_id: message.from.id },
    reply_markup: pickKeyboard,
    link_preview_options: { is_disabled: true },
  });
}

async function onCallback(query, receivedAt) {
  const message = query.message;
  const match = /^per885:pick:([abc])$/.exec(query.data ?? "");
  print("probe", {
    question: 3,
    ephemeral: message?.ephemeral_message_id !== undefined,
    message_keys: message === undefined ? [] : Object.keys(message).sort(),
    has_text: typeof message?.text === "string",
    text: message?.text,
    has_reply_markup: message?.reply_markup !== undefined,
  });
  await call("answerCallbackQuery", { callback_query_id: query.id });
  if (match === null || message?.ephemeral_message_id === undefined) return;
  const pick = match[1];
  const delay = picks[pick];
  const edit = async () => {
    const calledAfterMs = Date.now() - receivedAt;
    const result = await call("editEphemeralMessageText", {
      chat_id: message.chat.id,
      receiver_user_id: query.from.id,
      ephemeral_message_id: message.ephemeral_message_id,
      text: `PER-885 Прикреплено к «Сходка ${pick.toUpperCase()}»\nПравка через ${delay / 1_000} с после нажатия.\n\nПрочитано из шёпота: ${message.text === undefined ? "текста нет" : "текст есть"}`,
      reply_markup: pickKeyboard,
    });
    print("probe", {
      question: 2,
      pick,
      delay_ms: delay,
      called_after_press_ms: calledAfterMs,
      answered_after_press_ms: Date.now() - receivedAt,
      ok: result.ok === true,
      description: result.description,
    });
  };
  // Правка «сразу» ждётся внутри обработчика, как в боте на grammY: прогон
  // 2026-11-19 показал, что запрос, отправленный параллельно висящему
  // getUpdates, на этой машине ждёт его возврата.
  if (delay === 0) {
    await edit();
    return;
  }
  // Отложенная правка не держит цикл getUpdates: у остальных нажатий своё окно.
  sleep(delay)
    .then(edit)
    .catch((error) => print("edit-failed", String(error)));
}

// Команды зонда заменяют список группы только на время прогона: при остановке
// возвращается прежний.
const scope = { type: "chat", chat_id: Number(groupChatId) };
const previous = await call("getMyCommands", { scope });
// Список из одних команд зонда — след прогона, оборванного без возврата:
// прежним он не считается.
const previousCommands =
  previous.ok === true && !previous.result.every((entry) => commands.some((own) => own.command === entry.command))
    ? previous.result
    : [];

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
print("ready", { commands: commands.map((command) => command.command) });

let offset = 0;
for (;;) {
  // Короткий long-poll: отложенная правка, отправленная параллельно, ждёт
  // возврата getUpdates не дольше секунды.
  const updates = await call("getUpdates", { offset, timeout: 1, allowed_updates: ["message", "callback_query"] }).catch(
    (error) => ({ ok: false, description: String(error) }),
  );
  if (updates.ok !== true) {
    print("getUpdates", updates);
    await restoreCommands();
    process.exit(1);
  }
  for (const update of updates.result) {
    offset = update.update_id + 1;
    const receivedAt = Date.now();
    print("update", update);
    if (update.message !== undefined) {
      await onMessage(update.message, receivedAt);
    }
    if (update.callback_query !== undefined) {
      await onCallback(update.callback_query, receivedAt);
    }
  }
}
