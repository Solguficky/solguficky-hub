#!/usr/bin/env node

const token = process.env["TELEGRAM_BOT_TOKEN"];
const privateChatId = process.env["PRIVATE_CHAT_ID"];
const groupChatId = process.env["GROUP_CHAT_ID"];
const receiverUserId = process.env["RECEIVER_USER_ID"];

if (token === undefined || token === "" || privateChatId === undefined || privateChatId === "") {
  process.stderr.write("TELEGRAM_BOT_TOKEN and PRIVATE_CHAT_ID are required\n");
  process.exit(2);
}

const apiRoot = `https://api.telegram.org/bot${token}`;

async function call(method, body) {
  const response = await fetch(`${apiRoot}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  const result = {
    method,
    http_status: response.status,
    ok: payload.ok === true,
  };
  if (payload.ok === true) {
    const value = payload.result;
    if (value !== undefined && typeof value === "object" && !Array.isArray(value)) {
      if (typeof value.username === "string") {
        result.username = value.username;
        result.is_bot = value.is_bot === true;
      }
      result.message_id = value.message_id;
      result.ephemeral_message_id = value.ephemeral_message_id;
      result.has_rich_message = value.rich_message !== undefined;
      result.has_reply_markup = value.reply_markup !== undefined;
    } else {
      result.result = value;
    }
  } else {
    result.error_code = payload.error_code;
    result.description = payload.description;
  }
  return result;
}

const inlineKeyboard = {
  inline_keyboard: [[{ text: "PER-20 ping", callback_data: "per20:ping" }]],
};

const meetupCard = {
  blocks: [
    { type: "heading", text: "Сходка PER-20", size: 2 },
    { type: "paragraph", text: "Карточка для проверки блоков Rich Messages." },
    {
      type: "table",
      is_bordered: true,
      cells: [
        [
          { text: "Когда", align: "left", valign: "middle", is_header: true },
          { text: "6 сентября, 19:00", align: "left", valign: "middle" },
        ],
        [
          { text: "Где", align: "left", valign: "middle", is_header: true },
          { text: "Тестовая точка", align: "left", valign: "middle" },
        ],
      ],
    },
    {
      type: "details",
      summary: "Материалы",
      blocks: [{ type: "paragraph", text: "Ссылка на сообщение живёт здесь как текст." }],
    },
    {
      type: "buttons",
      buttons: [{ text: "Открыть", callback_data: "per20:open" }],
    },
  ],
};

const report = {
  skipped: [],
  steps: [],
};

const me = await call("getMe");
report.steps.push({ name: "getMe", ...me });
if (me.ok !== true) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(1);
}

const withKeyboard = await call("sendRichMessage", {
  chat_id: privateChatId,
  rich_message: { markdown: "## PER-20\nПроверка `reply_markup` на rich-сообщении." },
  reply_markup: inlineKeyboard,
});
report.steps.push({ name: "sendRichMessage_reply_markup", ...withKeyboard });

const withBlocks = await call("sendRichMessage", {
  chat_id: privateChatId,
  rich_message: meetupCard,
});
report.steps.push({ name: "sendRichMessage_blocks", ...withBlocks });

if (withKeyboard.ok === true && withKeyboard.message_id !== undefined) {
  const edited = await call("editMessageText", {
    chat_id: privateChatId,
    message_id: withKeyboard.message_id,
    rich_message: { markdown: "## PER-20\nДокумент отредактирован целиком." },
    reply_markup: inlineKeyboard,
  });
  report.steps.push({ name: "editMessageText_rich_message", ...edited });
} else {
  report.skipped.push("editMessageText_rich_message");
}

if (groupChatId !== undefined && groupChatId !== "" && receiverUserId !== undefined && receiverUserId !== "") {
  const ephemeral = await call("sendRichMessage", {
    chat_id: groupChatId,
    rich_message: { markdown: "Эфемерный ответ PER-20." },
    ephemeral_message_parameters: {
      receiver_user_id: Number(receiverUserId),
    },
    reply_markup: inlineKeyboard,
  });
  report.steps.push({ name: "sendRichMessage_ephemeral", ...ephemeral });
} else {
  report.skipped.push("sendRichMessage_ephemeral");
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
const failed = report.steps.some((step) => step.ok !== true);
process.exit(failed ? 1 : 0);
