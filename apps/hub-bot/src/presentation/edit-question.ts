import type { MessageEntity } from "grammy/types";
import { z } from "zod";
import type { FormField } from "../application/types.js";
import { parseCallback } from "./parse-callback.js";

// Вопрос с ForceReply не несёт callback_data, поэтому шаг, который переживает
// рестарт, лежит в самом сообщении: скрытой text_link-сущностью на символе
// нулевой ширины в начале текста. Сущности возвращаются в reply_to_message, а
// человек служебной строки не видит. Шаг — во фрагменте ссылки, а не в
// ?start=: случайное нажатие открывает профиль бота, а не команду /start.
const carrier = String.fromCharCode(0x200b);

export interface QuestionMessage {
  text: string;
  entities: MessageEntity[];
}

interface QuestionStep {
  prompt: string;
  botUsername: string;
  token: string;
}

// Вопрос без шага: форма создания рестарт не переживает, и восстанавливать
// в нём нечего.
export function plainQuestion(text: string): QuestionMessage {
  return { text, entities: [] };
}

function withStep(
  { prompt, botUsername }: QuestionStep,
  step: string,
): QuestionMessage {
  return {
    text: `${carrier}${prompt}`,
    entities: [
      {
        type: "text_link",
        offset: 0,
        length: carrier.length,
        url: `https://t.me/${botUsername}#${step}`,
      },
    ],
  };
}

const EntitiesSchema = z.array(
  z.object({ type: z.string(), url: z.string().optional() }),
);

function stepOf(entities: unknown) {
  const parsed = EntitiesSchema.safeParse(entities);
  if (!parsed.success) return undefined;
  for (const entity of parsed.data) {
    if (entity.type !== "text_link" || entity.url === undefined) continue;
    const step = stepFromUrl(entity.url);
    if (step !== undefined) return parseCallback(step);
  }
  return undefined;
}

// Битый URL или процент-кодирование дают «шага нет», а не исключение в
// обработчике ответа.
function stepFromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.hostname !== "t.me" || url.hash.length < 2) return undefined;
    return decodeURIComponent(url.hash.slice(1));
  } catch {
    return undefined;
  }
}

export function editQuestion(
  question: QuestionStep & { field: FormField },
): QuestionMessage {
  return withStep(
    question,
    `v1:manage:field:${question.token}:${question.field}`,
  );
}

export function parseEditQuestion(
  entities: unknown,
): { token: string; field: FormField } | undefined {
  const action = stepOf(entities);
  return action?.kind === "manage-field"
    ? { token: action.token, field: action.field }
    : undefined;
}

// Шаг вопроса о моменте публикации — кнопка, которая этот вопрос задаёт.
export function publishMomentQuestion(question: QuestionStep): QuestionMessage {
  return withStep(question, `v1:manage:publish-later:${question.token}`);
}

export function parsePublishMomentQuestion(
  entities: unknown,
): { token: string } | undefined {
  const action = stepOf(entities);
  return action?.kind === "manage-publish-later"
    ? { token: action.token }
    : undefined;
}
