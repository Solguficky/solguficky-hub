#!/usr/bin/env node

// Зонд копии сообщения из чата (PER-916): копирует ли `copyMessage` сообщение с
// фото из чата сообщества, где бот — участник без прав администратора и с
// Privacy Mode. Отвечает на пять вопросов:
//   1. видит ли бот чат и кем он в нём числится (`getChat`/`getChatMember`);
//   2. что отвечает Telegram на `copyMessage` по номеру сообщения из ссылки;
//   3. при удачной копии — что скопировалось: фото, документ или текст;
//   4. контроль: тот же ли отказ на номер, которого в чате заведомо нет;
//   5. необязательный обход соседних номеров (`SCAN_RANGE`): чьи сообщения бот
//      смог взять.
// Строки `call` — ответ сервера как есть, строки `probe` — выжимка по вопросам.
// Ответы `getChat` и `forwardMessage` целиком не печатаются: в них бывают
// закреплённое сообщение и текст чужих сообщений. Токен в вывод не попадает.
// Long polling не запускается: бот может быть занят поллером, а копии и
// пересылке он не мешает.
//
// Переменные без умолчаний: HUB_BOT_TOKEN — токен бота-участника без прав
// администратора; MESSAGE_LINK — ссылка «Копировать ссылку» на сообщение с
// фото из этого чата. Необязательные: TARGET_CHAT_ID — числовой id, куда
// копировать (личка или канал медиа), без неё копия идёт в тот же чат;
// SCAN_RANGE — например `18-30`, нужен вместе с TARGET_CHAT_ID другого чата:
// в тот же чат чужие сообщения не пересылаются.

const token = process.env["HUB_BOT_TOKEN"];
const messageLink = process.env["MESSAGE_LINK"];
const targetChat = process.env["TARGET_CHAT_ID"];
const scanSpec = process.env["SCAN_RANGE"] ?? "";
const scanRange = /^(\d+)-(\d+)$/.exec(scanSpec);

if (token === undefined || token === "" || messageLink === undefined || messageLink === "") {
  process.stderr.write("HUB_BOT_TOKEN and MESSAGE_LINK are required\n");
  process.exit(2);
}
if (
  targetChat !== undefined &&
  targetChat !== "" &&
  !(/^-?\d+$/.test(targetChat) && Number.isSafeInteger(Number(targetChat)))
) {
  process.stderr.write("TARGET_CHAT_ID must be a numeric chat id\n");
  process.exit(2);
}
// Опечатка в SCAN_RANGE не должна выглядеть как прогон без находок.
if (scanSpec !== "" && (scanRange === null || Number(scanRange[1]) > Number(scanRange[2]))) {
  process.stderr.write("SCAN_RANGE must look like 18-30, from <= to\n");
  process.exit(2);
}

const apiRoot = `https://api.telegram.org/bot${token}`;

function print(kind, data) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), kind, data })}\n`);
}

// `quiet` — не печатать сырой ответ: в нём может стоять чужой текст.
async function call(method, body, quiet = false) {
  // Сбой сети печатается без адреса: в нём стоит токен.
  const response = await fetch(`${apiRoot}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).catch((error) => {
    process.stderr.write(`${method}: network failure (${error?.cause?.code ?? error?.name})\n`);
    process.exit(1);
  });
  const payload = await response.json().catch(() => {
    process.stderr.write(`${method}: HTTP ${response.status}, body is not JSON\n`);
    process.exit(1);
  });
  if (!quiet) print("call", { method, body, http_status: response.status, response: payload });
  return { status: response.status, payload };
}

// Ссылка «Копировать ссылку»: `t.me/c/<чат>[/<тема>]/<номер>` или
// `t.me/<имя>[/<тема>]/<номер>`, тот же разбор, что у материала бота.
function parseLink(link) {
  const match = /^(?:https?:\/\/)?t\.me\/(?:c\/([1-9]\d*)|([A-Za-z][A-Za-z0-9_]{3,31}))(?:\/([1-9]\d*))?\/([1-9]\d*)\/?(?:\?\S*)?$/i.exec(
    link.trim(),
  );
  if (match === null) return undefined;
  const [, internal, username, , message] = match;
  return {
    // У закрытой супергруппы номер в ссылке — id без `-100`.
    chat: internal === undefined ? `@${username}` : `-100${internal}`,
    messageId: Number(message),
  };
}

// Что в сообщении: из ответа `forwardMessage` — полного `Message`.
function contentOf(message) {
  return ["photo", "document", "video", "sticker", "animation", "voice", "audio", "poll", "text"].filter(
    (kind) => message[kind] !== undefined,
  );
}

// Взять сообщение пересылкой в `toChat` и тут же удалить пересылку. Сырой ответ
// не печатается. Возвращает ответ пересылки и результат удаления.
async function peek(fromChat, toChat, messageId) {
  const forward = await call(
    "forwardMessage",
    { chat_id: toChat, from_chat_id: fromChat, message_id: messageId },
    true,
  );
  const forwarded = forward.payload.result;
  const deleted =
    forwarded === undefined
      ? undefined
      : await call("deleteMessage", { chat_id: toChat, message_id: forwarded.message_id });
  return { forward: forward.payload, forwarded, deleted: deleted?.payload };
}

const parsed = parseLink(messageLink);
if (parsed === undefined) {
  process.stderr.write(`MESSAGE_LINK is not a message link: ${messageLink}\n`);
  process.exit(2);
}

const me = await call("getMe");
const botId = me.payload.result?.id;
if (botId === undefined) {
  process.stderr.write("getMe failed: check HUB_BOT_TOKEN\n");
  process.exit(1);
}
print("probe", {
  question: 1,
  bot_id: botId,
  privacy_mode: me.payload.result?.can_read_all_group_messages === true ? "off" : "on",
});

// Публичный чат называется в ссылке именем, закрытый — номером; `getChat`
// переводит имя в id и заодно показывает, видит ли бот чат вообще.
const sourceChatId = Number.isFinite(Number(parsed.chat))
  ? Number(parsed.chat)
  : (await call("getChat", { chat_id: parsed.chat }, true)).payload.result?.id;
if (sourceChatId === undefined) {
  process.stderr.write("source chat is unknown: getChat failed\n");
  process.exit(1);
}
const targetChatId =
  targetChat === undefined || targetChat === "" ? sourceChatId : Number(targetChat);

const chat = await call("getChat", { chat_id: sourceChatId }, true);
print("probe", {
  question: 1,
  source_chat_id: sourceChatId,
  ok: chat.payload.ok === true,
  description: chat.payload.description,
  chat_type: chat.payload.result?.type,
  chat_title: chat.payload.result?.title,
});
const member = await call("getChatMember", { chat_id: sourceChatId, user_id: botId });
print("probe", {
  question: 1,
  status: member.payload.result?.status,
  is_admin: member.payload.result?.status === "administrator",
});

// Копия без подписи и без клавиатуры: вопрос только о доступе к сообщению.
// `copyMessage` отвечает лишь `MessageId`: что именно скопировалось, из ответа
// не видно.
const copy = await call("copyMessage", {
  chat_id: targetChatId,
  from_chat_id: sourceChatId,
  message_id: parsed.messageId,
});
const copied = copy.payload.result;
print("probe", {
  question: 2,
  ok: copy.payload.ok === true,
  http_status: copy.status,
  error_code: copy.payload.error_code,
  description: copy.payload.description,
  copied_message_id: copied?.message_id,
});
if (copied !== undefined) {
  // Тип копии узнаём пересылкой её же в тот же чат: `forwardMessage` отвечает
  // полным `Message`, а копия лежит в чате цели и бот её видит.
  const peeked = await peek(targetChatId, targetChatId, copied.message_id);
  print("probe", {
    question: 3,
    ok: peeked.forward.ok === true,
    description: peeked.forward.description,
    content: peeked.forwarded === undefined ? undefined : contentOf(peeked.forwarded),
    has_caption: peeked.forwarded === undefined ? undefined : peeked.forwarded.caption !== undefined,
    forward_deleted: peeked.deleted === undefined ? undefined : peeked.deleted.ok === true,
  });
  // Копия тоже след прогона: удаляется, если Telegram разрешает боту удалить
  // своё сообщение в этом чате.
  const deletedCopy = await call("deleteMessage", {
    chat_id: targetChatId,
    message_id: copied.message_id,
  });
  print("probe", { question: 3, copy_deleted: deletedCopy.payload.ok === true });
}

// Контроль: номер, которого в чате заведомо нет. Тот же текст отказа, что и у
// сообщения человека, значит «не найдено» не различает «нет» и «не видно».
const control = await call("copyMessage", {
  chat_id: targetChatId,
  from_chat_id: sourceChatId,
  message_id: 2_000_000_000,
});
print("probe", {
  question: 4,
  // Контроль что-то значит, только если чат-источник виден боту.
  source_chat_ok: chat.payload.ok === true,
  nonexistent_message_ok: control.payload.ok === true,
  description: control.payload.description,
});

// Обход соседей. `forwardMessage` отвечает полным `Message`, из него видно,
// что бот смог взять и что в нём. Поле `forward_origin` называет исходного
// автора, а не того, кто переслал: у сообщения бота, которое само было
// пересылкой, `sender_is_this_bot` будет ложным, поэтому печатается и тип
// origin. Пересылка тут же удаляется; сбой сети посреди обхода может оставить
// последнюю в чате цели.
if (scanRange !== null && targetChatId === sourceChatId) {
  process.stderr.write("SCAN_RANGE needs TARGET_CHAT_ID of another chat\n");
  process.exit(2);
}
if (scanRange !== null) {
  for (let id = Number(scanRange[1]); id <= Number(scanRange[2]); id += 1) {
    const peeked = await peek(sourceChatId, targetChatId, id);
    const sender = peeked.forwarded?.forward_origin?.sender_user;
    print("probe", {
      question: 5,
      message_id: id,
      ok: peeked.forward.ok === true,
      error_code: peeked.forward.error_code,
      description: peeked.forward.description,
      content: peeked.forwarded === undefined ? undefined : contentOf(peeked.forwarded),
      origin_type: peeked.forwarded?.forward_origin?.type,
      sender_is_bot: sender?.is_bot,
      sender_is_this_bot: sender === undefined ? undefined : sender.id === botId,
      forward_deleted: peeked.deleted === undefined ? undefined : peeked.deleted.ok === true,
    });
    // Лимит запросов: остаток диапазона ушёл бы одними отказами.
    if (peeked.forward.error_code === 429 || peeked.deleted?.error_code === 429) {
      process.stderr.write("SCAN_RANGE stopped: Telegram answered 429\n");
      break;
    }
  }
}
