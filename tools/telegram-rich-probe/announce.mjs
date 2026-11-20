#!/usr/bin/env node

// Зонд поста-анонса в группе (PER-918): бот-участник без админки публикует
// видимый всем пост с кнопками, правит и удаляет его, отвечает на нажатие
// шёпотом и печатает кандидатов ссылки на пост. Пост ставит команда /announce,
// набранная в группе; каждый update и ответ сервера печатается строкой JSON,
// токен в вывод не попадает.
//
// EDIT_POST=<chat_id>:<message_id> — разовая правка ранее опубликованного поста
// (проверка правки спустя время) без long polling.

const token = process.env["HUB_BOT_TOKEN"];
const editPost = process.env["EDIT_POST"];

if (token === undefined || token === "") {
  process.stderr.write("HUB_BOT_TOKEN is required\n");
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

const me = await call("getMe");
if (me.ok !== true) {
  process.exit(1);
}
const botUsername = me.result.username;

function postKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Открыть сходку", url: `https://t.me/${botUsername}?start=meetups` }],
      [{ text: "🔔 Подписаться", callback_data: "per918:sub" }],
      [
        { text: "✏️ Править", callback_data: "per918:edit" },
        { text: "🗑 Удалить", callback_data: "per918:del" },
      ],
    ],
  };
}

function postText(author, edited) {
  const lines = [
    "PER-918 зонд: анонс свободным текстом организатора.",
    "Здесь мог бы быть любой текст, который организатор написал боту.",
    "———",
    "🗓 Сб, 29 ноября, 18:00 · место из карточки",
    `✍️ анонс от ${author}`,
  ];
  if (edited !== undefined) {
    lines.push(`(отредактировано ${edited})`);
  }
  return lines.join("\n");
}

if (editPost !== undefined && editPost !== "") {
  const [chatId, messageId] = editPost.split(":");
  const edited = await call("editMessageText", {
    chat_id: Number(chatId),
    message_id: Number(messageId),
    text: postText("организатора", `спустя время, ${new Date().toISOString()}`),
    reply_markup: postKeyboard(),
  });
  process.exit(edited.ok === true ? 0 : 1);
}

// Кандидаты ссылки на пост. Документированы только ссылки супергрупп и
// каналов: публичная по username и t.me/c/<id без -100>/<номер>. Для обычной
// группы (id без -100) форма не документирована, и кандидат печатается, чтобы
// проверить его клиентом, а не потому, что он должен работать.
function linkCandidates(chat, messageId) {
  const links = [];
  if (chat.username !== undefined) {
    links.push({ form: "public", url: `https://t.me/${chat.username}/${messageId}` });
  }
  const id = String(chat.id);
  if (id.startsWith("-100")) {
    links.push({ form: "c-supergroup", url: `https://t.me/c/${id.slice(4)}/${messageId}` });
  } else {
    links.push({ form: "c-group-undocumented", url: `https://t.me/c/${id.replace("-", "")}/${messageId}` });
  }
  return links;
}

function whisperTo(message, text) {
  if (message.ephemeral_message_id === undefined) {
    return Promise.resolve();
  }
  return call("sendMessage", {
    chat_id: message.chat.id,
    text,
    reply_parameters: { ephemeral_message_id: message.ephemeral_message_id },
    ephemeral_message_parameters: { receiver_user_id: message.from.id },
  });
}

// "/announce", "/announce@bot" и "/announce аргументы" — да, "/announcex" — нет.
function commandOf(text) {
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/.exec(text);
  return match === null ? undefined : match[1];
}

async function onMessage(message) {
  if (message.chat.type === "private" || commandOf(message.text ?? "") !== "announce") {
    return;
  }
  const chat = await call("getChat", { chat_id: message.chat.id });
  const member = await call("getChatMember", { chat_id: message.chat.id, user_id: me.result.id });
  print("probe", {
    chat_type: chat.result?.type,
    bot_status: member.result?.status,
    can_read_all_group_messages: me.result.can_read_all_group_messages,
    member_can_send_messages: chat.result?.permissions?.can_send_messages,
  });
  const author = message.from.username === undefined ? message.from.first_name : `@${message.from.username}`;
  const sent = await call("sendMessage", {
    chat_id: message.chat.id,
    text: postText(author),
    reply_markup: postKeyboard(),
  });
  if (sent.ok !== true) {
    await whisperTo(message, `PER-918: пост не ушёл — ${sent.description}`);
    return;
  }
  const links = linkCandidates(sent.result.chat, sent.result.message_id);
  print("post", { chat_id: sent.result.chat.id, message_id: sent.result.message_id, links });
  await whisperTo(message, `PER-918: пост ${sent.result.message_id}, ссылки:\n${links.map((l) => `${l.form}: ${l.url}`).join("\n")}`);
}

async function onCallback(query) {
  const message = query.message;
  await call("answerCallbackQuery", { callback_query_id: query.id });
  if (message === undefined) {
    return;
  }
  switch (query.data) {
    case "per918:sub":
      await call("sendMessage", {
        chat_id: message.chat.id,
        text: "PER-918: подписка (зонд) — этот ответ видишь только ты",
        ephemeral_message_parameters: { receiver_user_id: query.from.id, callback_query_id: query.id },
      });
      break;
    case "per918:edit":
      await call("editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text: postText("организатора", new Date().toISOString()),
        reply_markup: postKeyboard(),
      });
      break;
    case "per918:del":
      await call("deleteMessage", { chat_id: message.chat.id, message_id: message.message_id });
      break;
  }
}

// /announce ставится невидимой командой во всех группах только на время
// прогона: при остановке возвращается прежний список этого scope.
const scope = { type: "all_group_chats" };
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

const installed = await call("setMyCommands", {
  scope,
  commands: [{ command: "announce", description: "PER-918 опубликовать пост-анонс", is_ephemeral: true }],
});
if (installed.ok !== true) {
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
