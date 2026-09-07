#!/usr/bin/env node

const token = process.env["TELEGRAM_BOT_TOKEN"];
const privateChatId = process.env["PRIVATE_CHAT_ID"];
const groupChatId = process.env["GROUP_CHAT_ID"];
const receiverUserId = process.env["RECEIVER_USER_ID"];
const presentation = process.env["TELEGRAM_BOT_PRESENTATION"] ?? "rich";

if (token === undefined || token === "" || privateChatId === undefined || privateChatId === "") {
  process.stderr.write("TELEGRAM_BOT_TOKEN and PRIVATE_CHAT_ID are required\n");
  process.exit(2);
}

if (presentation !== "rich" && presentation !== "plain") {
  process.stderr.write("TELEGRAM_BOT_PRESENTATION must be rich or plain\n");
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

const meetupCard = {
  title: "Сходка PER-20",
  lead: "Карточка для проверки представления.",
  when: "6 сентября, 19:00",
  where: "Тестовая точка",
  materials: "Ссылка на сообщение живёт здесь как текст.",
  documentAction: { text: "Открыть", callback_data: "per20:open" },
  hubAction: { text: "PER-20 ping", callback_data: "per20:ping" },
};

function renderRich(card) {
  return {
    rich_message: {
      blocks: [
        { type: "heading", text: card.title, size: 2 },
        { type: "paragraph", text: card.lead },
        {
          type: "table",
          is_bordered: true,
          cells: [
            [
              { text: "Когда", align: "left", valign: "middle", is_header: true },
              { text: card.when, align: "left", valign: "middle" },
            ],
            [
              { text: "Где", align: "left", valign: "middle", is_header: true },
              { text: card.where, align: "left", valign: "middle" },
            ],
          ],
        },
        {
          type: "details",
          summary: "Материалы",
          blocks: [{ type: "paragraph", text: card.materials }],
        },
        {
          type: "buttons",
          buttons: [{ text: card.documentAction.text, callback_data: card.documentAction.callback_data }],
        },
      ],
    },
    reply_markup: {
      inline_keyboard: [[{ text: card.hubAction.text, callback_data: card.hubAction.callback_data }]],
    },
  };
}

function renderPlain(card) {
  return {
    text: [
      card.title,
      "",
      card.lead,
      "",
      `Когда: ${card.when}`,
      `Где: ${card.where}`,
      "",
      "Материалы",
      card.materials,
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [
        [{ text: card.documentAction.text, callback_data: card.documentAction.callback_data }],
        [{ text: card.hubAction.text, callback_data: card.hubAction.callback_data }],
      ],
    },
  };
}

function sendCard(chatId, card, extra) {
  if (presentation === "plain") {
    return call("sendMessage", { chat_id: chatId, ...renderPlain(card), ...extra });
  }
  return call("sendRichMessage", { chat_id: chatId, ...renderRich(card), ...extra });
}

function editCard(chatId, messageId, card) {
  if (presentation === "plain") {
    const rendered = renderPlain(card);
    return call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `${rendered.text}\n\nДокумент отредактирован целиком.`,
      reply_markup: rendered.reply_markup,
    });
  }
  const rendered = renderRich(card);
  return call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    rich_message: { markdown: "## PER-20\nДокумент отредактирован целиком." },
    reply_markup: rendered.reply_markup,
  });
}

const report = {
  presentation,
  skipped: [],
  steps: [],
};

const me = await call("getMe");
report.steps.push({ name: "getMe", ...me });
if (me.ok !== true) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(1);
}

const productCard = await sendCard(privateChatId, meetupCard);
report.steps.push({ name: "product_card", ...productCard });

if (productCard.ok === true && productCard.message_id !== undefined) {
  const edited = await editCard(privateChatId, productCard.message_id, meetupCard);
  report.steps.push({ name: "edit_product_card", ...edited });
} else {
  report.skipped.push("edit_product_card");
}

if (groupChatId !== undefined && groupChatId !== "" && receiverUserId !== undefined && receiverUserId !== "") {
  const ephemeral = await sendCard(groupChatId, meetupCard, {
    ephemeral_message_parameters: {
      receiver_user_id: Number(receiverUserId),
    },
  });
  report.steps.push({ name: "ephemeral_card", ...ephemeral });
} else {
  report.skipped.push("ephemeral_card");
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
const failed = report.steps.some((step) => step.ok !== true);
process.exit(failed ? 1 : 0);
