import { Api, InlineKeyboard } from "grammy";
import {
  classifyTelegramFailure,
  type NotificationSender,
  type SendResult,
} from "../core/delivery/index.js";
import type {
  LocalDate,
  LocalDateTime,
  MeetupAspect,
  MeetupWhen,
  NotifiedMeetup,
  RenderableContent,
} from "../delivery/notification.js";
import type { TelegramEnvironment } from "./bot.js";
import { uuidToToken } from "./meetup-deep-link.js";
import {
  type NotifiedMeetupCategory,
  traceCallback,
} from "./parse-callback.js";

// Кнопка отключения несёт целевое состояние, как переключатель P-09: повторное
// нажатие даёт то же «выключено», а не включает категорию обратно.
export const disablePublishedCallback = "v1:notify:off:published";

// Напоминание выключает общую категорию, а не категорию сходки: по сходке оно
// приходит один раз, и второе бывает только после переноса. Сходки, у которых
// напоминание включено отдельно, это не остановит, и подтверждение говорит об
// этом прямо.
export const disableReminderCallback = "v1:notify:off:reminder";

// Предел текста сообщения Telegram в UTF-16-единицах; длина строки JavaScript
// считается в тех же единицах. Предел тела рассылки сегодня совпадает с ним
// (docs/architecture/integration.md), но это разные величины: сужение тела не
// должно сужать кадр, в который тело вставляется.
export const telegramTextLimit = 4096;

// Объявление ни к какой сходке не привязано, и категория у него только общая.
export const disableAnnouncementCallback = "v1:notify:off:announcement";

// Заявка тоже не привязана к сходке. Категория одна на оба круга, поэтому
// кнопка стоит и под заявкой в хаб, и под заявкой в аукцион.
export const disableAccessRequestCallback = "v1:notify:off:access";

// Вызов Bot API обязан уложиться в ack_wait durable (30 с): иначе шина выдаст то
// же сообщение второй раз, пока первая отправка ещё висит. Умолчание клиента
// grammY рассчитано на long polling и измеряется минутами, поэтому у доставки
// свой клиент со своим таймаутом, а не общий с поллером.
const sendTimeoutSeconds = 10;

export function createNotificationApi(
  token: string,
  environment: TelegramEnvironment,
): Api {
  return new Api(token, { environment, timeoutSeconds: sendTimeoutSeconds });
}

// Клавиатуры нет, когда вести некуда: пустая разметка — тоже разметка, и
// отправлять её незачем.
export type NotificationMessage = {
  text: string;
  keyboard: InlineKeyboard | undefined;
};

// Изменения и материалы получают подписчики конкретной сходки, и настройка у
// сходки перекрывает общую. Поэтому кнопка выключает категорию у этой сходки:
// общий выключатель не остановил бы уведомления, если у сходки категория
// включена явно, а подтверждение под сообщением обещало бы обратное.
export function disableMeetupCategoryCallback(
  meetupId: string,
  category: NotifiedMeetupCategory,
): string {
  return `v1:notify:moff:${uuidToToken(meetupId)}:${category}`;
}

// Кадр по образцу P-11: заголовок называет повод и сходку, строки ниже — что
// нужно знать, не открывая карточку. Одно сообщение на повод, карточка целиком
// не повторяется: описание и ссылка на календарь только называются.
export function renderNotification(
  content: RenderableContent,
): NotificationMessage {
  if (content.kind === "access-requested") {
    // Повод и переход в очередь, где заявку решают, и выключатель категории.
    const disable = (keyboard: InlineKeyboard) =>
      keyboard.text(
        "Не присылать запросы доступа",
        disableAccessRequestCallback,
      );
    if (content.circle === "public") {
      // Очередь «Ожидают допуска» решает допуск в хаб: «Допустить» там выдаёт
      // member. Вести туда аукционную заявку значило бы дать заявителю больше,
      // чем он просил, поэтому кнопки перехода нет. Карточка заявки с кругом
      // (PER-439) уже есть, но след к ней — часть оповещения, а не карточки.
      return {
        text: "Новая заявка на участие в аукционе",
        keyboard: disable(new InlineKeyboard()),
      };
    }
    return {
      text: "Новая заявка на доступ в сообщество",
      keyboard: disable(
        new InlineKeyboard()
          .text(
            "Открыть очередь",
            // Кнопка следа: очередь придёт новым сообщением, а уведомление
            // останется в истории.
            traceCallback("v1:cm:p"),
          )
          .row(),
      ),
    };
  }
  if (content.kind === "access-granted") {
    // Тот же текст и та же кнопка, что слал экран состава до PER-442: сменился
    // носитель, а не обещание. Кнопка следа — список придёт новым сообщением.
    return {
      text: "Доступ открыт: теперь тебе видны сходки сообщества.",
      keyboard: new InlineKeyboard().text(
        "Ближайшие сходки",
        traceCallback("v1:nav:hub"),
      ),
    };
  }
  if (content.kind === "role-granted") {
    // Кнопка следа — стартовый экран придёт новым сообщением, а весть о
    // правах останется в истории; «Управление» человек находит на нём сам.
    return {
      text: "Тебе выданы права администратора сообщества. На стартовом экране появилось «Управление».",
      keyboard: new InlineKeyboard().text(
        "Меню",
        traceCallback("v1:nav:start"),
      ),
    };
  }
  if (content.kind === "community-announcement") {
    return {
      text: withHeadline("Объявление сообщества", content.body),
      keyboard: new InlineKeyboard().text(
        "Не присылать объявления",
        disableAnnouncementCallback,
      ),
    };
  }
  const meetup = content.meetup;
  const open = () =>
    new InlineKeyboard().text(
      "Открыть сходку",
      // Кнопка следа: карточка придёт новым сообщением, а уведомление — и
      // слова организатора в нём — останется в истории.
      traceCallback(`v1:view:${uuidToToken(meetup.id)}`),
    );
  switch (content.kind) {
    case "meetup-published":
      return {
        text: [headline("Новая сходка", meetup), ...whenAndWhere(meetup)].join(
          "\n",
        ),
        keyboard: open()
          .row()
          .text("Не присылать новые сходки", disablePublishedCallback),
      };
    case "meetup-changed":
      return {
        text: renderChange(content).join("\n"),
        keyboard: open()
          .row()
          .text(
            "Не присылать изменения этой сходки",
            disableMeetupCategoryCallback(meetup.id, "changes"),
          ),
      };
    // Материал бывает и ссылкой, и файлом, поэтому повод назван материалом, а
    // не сообщением. Название сходки стоит в кавычках: через двоеточие оно
    // читалось как название материала, стоящего строкой ниже.
    case "meetup-material": {
      const material = content.materialTitle.trim();
      const title = meetup.title.trim();
      return {
        text: [
          title === ""
            ? "Новый материал у сходки"
            : `Новый материал у сходки «${title}»`,
          ...(material === "" ? [] : [material]),
        ].join("\n"),
        keyboard: open()
          .row()
          .text(
            "Не присылать материалы этой сходки",
            disableMeetupCategoryCallback(meetup.id, "material"),
          ),
      };
    }
    case "meetup-reminder":
      return {
        text: [headline("Напоминание", meetup), ...whenAndWhere(meetup)].join(
          "\n",
        ),
        keyboard: open()
          .row()
          .text("Не присылать напоминания", disableReminderCallback),
      };
    // Сообщение организатора получают подписчики сходки, поэтому кнопка, как у
    // изменений, выключает категорию у этой сходки, а не общую. «Этой сходки» в
    // подписи нет: с ним кнопка шире экрана телефона и обрезается, а что
    // выключено только здесь, говорит ответ на нажатие.
    case "organizer-message":
      return {
        text: withHeadline(
          headline("Сообщение организатора", meetup),
          content.body,
        ),
        keyboard: open()
          .row()
          .text(
            "Не присылать сообщения организатора",
            disableMeetupCategoryCallback(meetup.id, "organizer"),
          ),
      };
    // Сходка скрыта: кнопка «Открыть» упёрлась бы в «не найдено», а отключать
    // уже нечего — снятие последний повод, пока сходку не вернут. Поэтому
    // клавиатуры нет, а текст называет сходку и дату, чтобы её узнать.
    case "meetup-unpublished":
      return {
        text: [
          headline("Сходка снята с публикации", meetup),
          formatWhen(meetup.when),
        ].join("\n"),
        keyboard: undefined,
      };
    default: {
      const _exhaustive: never = content;
      return _exhaustive;
    }
  }
}

type ChangeContent = Extract<RenderableContent, { kind: "meetup-changed" }>;

const aspectLabels: Record<MeetupAspect, string> = {
  title: "название",
  description: "описание",
  venue: "место",
  kind: "вид сходки",
  "calendar-link": "ссылка на календарь",
  schedule: "дата и время",
  lifecycle: "статус",
  visibility: "видимость",
  other: "другие сведения",
};

// Старых значений контракт не несёт, поэтому текст говорит, что изменилось, и
// показывает, как стало. Смена состояния, о которой заголовок говорит сам, —
// отмена, проведение, возврат в публикацию — в перечень не повторяется.
function renderChange(content: ChangeContent): string[] {
  const { meetup, aspects } = content;
  const cancelled =
    aspects.includes("lifecycle") && content.lifecycle === "cancelled";
  const held = aspects.includes("lifecycle") && content.lifecycle === "held";
  const returned =
    aspects.includes("visibility") && content.visibility === "visible";
  const lead = cancelled
    ? "Сходка отменена"
    : held
      ? "Сходка состоялась"
      : returned
        ? "Сходка снова опубликована"
        : "Изменения в сходке";
  const named = aspects.filter(
    (aspect) =>
      !(aspect === "lifecycle" && (cancelled || held)) &&
      !(aspect === "visibility" && returned),
  );
  const lines = [headline(lead, meetup)];
  if (named.length > 0) {
    lines.push(
      `Изменилось: ${named.map((aspect) => aspectLabels[aspect]).join(", ")}`,
    );
  }
  if (aspects.includes("lifecycle") && !cancelled && !held) {
    lines.push("Статус: запланирована");
  }
  const kind = meetup.kind.trim();
  if (aspects.includes("kind") && kind !== "") lines.push(`Вид: ${kind}`);
  // Отменённой сходке дата и место уже ни к чему: главное сказано заголовком.
  if (!cancelled) lines.push(...whenAndWhere(meetup));
  return lines;
}

// Тело рассылки ограничено тем же пределом, что и сообщение Telegram, и
// заголовок канала над телом предельной длины получил бы 400 — сообщение
// снялось бы без повтора. Поэтому заголовок ставится, только когда помещается,
// а иначе уходит одно тело: текст автора дороже конверта, а у сообщения
// организатора сходку по-прежнему называет кнопка. Тело не обрезается — его
// обещано доставить дословно.
function withHeadline(lead: string, body: string): string {
  const framed = `${lead}\n\n${body}`;
  return framed.length <= telegramTextLimit ? framed : body;
}

function headline(lead: string, meetup: NotifiedMeetup): string {
  const title = meetup.title.trim();
  return title === "" ? lead : `${lead}: ${title}`;
}

function whenAndWhere(meetup: NotifiedMeetup): string[] {
  const venue = meetup.venue.trim();
  return venue === ""
    ? [formatWhen(meetup.when)]
    : [formatWhen(meetup.when), `Место: ${venue}`];
}

function formatWhen(when: MeetupWhen): string {
  switch (when.kind) {
    case "no-date":
      return "Дата пока не назначена";
    case "day":
      return tentative(when.tentative, formatDate(when.date));
    case "day-start":
      return tentative(when.tentative, formatDateTime(when.at));
    case "interval": {
      const sameDay =
        when.start.year === when.end.year &&
        when.start.month === when.end.month &&
        when.start.day === when.end.day;
      const end = sameDay ? formatTime(when.end) : formatDateTime(when.end);
      return tentative(when.tentative, `${formatDateTime(when.start)}–${end}`);
    }
    default: {
      const _exhaustive: never = when;
      return _exhaustive;
    }
  }
}

function tentative(isTentative: boolean, value: string): string {
  return isTentative ? `Предварительно: ${value}` : value;
}

// Тот же вид `ДД.ММ.ГГГГ ЧЧ:ММ`, что у карточки и формы сходки: дата в
// уведомлении и в карточке, куда оно ведёт, читается одинаково.
function formatDate(value: LocalDate): string {
  return `${pad(value.day)}.${pad(value.month)}.${value.year}`;
}

function formatTime(value: LocalDateTime): string {
  return `${pad(value.hours)}:${pad(value.minutes)}`;
}

function formatDateTime(value: LocalDateTime): string {
  return `${formatDate(value)} ${formatTime(value)}`;
}

function pad(part: number): string {
  return String(part).padStart(2, "0");
}

export type SendMessageApi = Pick<Api, "sendMessage">;

// Содержимое рисуется здесь же, при отправке: соседи для текста хабу не
// нужны, и рендер пакета доставки отдаёт содержимое как есть.
export function createNotificationSender(
  api: SendMessageApi,
): NotificationSender<RenderableContent> {
  return {
    async send({ telegramUserId, message: content }) {
      const message = renderNotification(content);
      try {
        // Личный чат с человеком имеет id самого человека. Telegram держит id в
        // 52 битах, поэтому переход из bigint в number точен.
        await api.sendMessage(Number(telegramUserId), message.text, {
          ...(message.keyboard === undefined
            ? {}
            : { reply_markup: message.keyboard }),
          link_preview_options: { is_disabled: true },
        });
        return { kind: "sent" };
      } catch (cause) {
        return classifySendFailure(cause);
      }
    },
  };
}

// Классы отказов Bot API общие у обоих ботов и живут в пакете доставки:
// правка правила одна на два канала.
export function classifySendFailure(cause: unknown): SendResult {
  return classifyTelegramFailure(cause);
}
