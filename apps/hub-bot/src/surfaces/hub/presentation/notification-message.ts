import { Api, InlineKeyboard } from "grammy";
import { encodeAuctionCallback } from "../../../auction-ui/index.js";
import type { TelegramEnvironment } from "../../../core/config.js";
import {
  classifyTelegramFailure,
  type NotificationSender,
  type SendResult,
} from "../../../core/delivery/index.js";
import { registerChatCommands } from "../../../core/menu-commands.js";
import { renderAuctionAnnouncement } from "../../../core/notifications/auction-announcement-notice.js";
import { renderAuctionCancelledNotice } from "../../../core/notifications/auction-cancelled-notice.js";
import type { FinalNotice } from "../../../core/notifications/final-notice.js";
import type {
  InvoiceNotice,
  InvoiceNoticeView,
} from "../../../core/notifications/invoice-notice.js";
import type {
  LotNotice,
  LotNoticeView,
} from "../../../core/notifications/lot-notice.js";
import { renderPredictionResultsNotice } from "../../../core/notifications/prediction-results-notice.js";
import { renderRaffleNotice } from "../../../core/notifications/raffle-notice.js";
import type { StepWindowNotice } from "../../../core/notifications/step-window-notice.js";
import {
  admitLabel,
  declineLabel,
  marked,
  pictogram,
} from "../../../core/pictograms.js";
import type { CommunityDay } from "../community-time.js";
import type { AccessRequestView } from "../delivery/access-request.js";
import type {
  LocalDateTime,
  MeetupAspect,
  MeetupWhen,
  NotifiedMeetup,
  RenderableContent,
} from "../delivery/notification.js";
import { managerCommands } from "./commands.js";
import { uuidToToken } from "./meetup-deep-link.js";
import {
  cardCursorData,
  type NotifiedMeetupCategory,
  queueDomain,
  traceCallback,
} from "./parse-callback.js";
import { applicationCardBody, cursorOf } from "./screens/application.js";
import {
  escapeHtml,
  readableDay,
  readableMoment,
  toManage,
} from "./screens/kit.js";
import { releasePostData } from "./screens/release-notes.js";
import { screenMark } from "./screens/show.js";

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

// Заявка не привязана к сходке, а очередь у неё есть, и категория у каждой
// очереди своя: кнопка под оповещением выключает ту, из которой заявка пришла,
// а не обе сразу (PER-635). Данные — категория очереди, как в экране настроек.
export const disableAccessRequestPrefix = "v1:notify:off:access-";

export const disableReleaseCallback = "v1:notify:off:release";

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
// отправлять её незачем. HTML — у вести, которая несёт чужой текст, уже
// экранированный тем же кодом, что экран.
export type NotificationMessage = {
  text: string;
  keyboard: InlineKeyboard | undefined;
  format?: "HTML";
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

export type ReleaseNote = {
  kind: "release-note";
  day: string;
  lines: readonly string[];
  hidden: number;
  summaryId: string;
};

// Что уходит отправителю. Вести хаба он рисует сам, а весть о лоте и анонс
// финала приходят уже собранными общими рендерами двух ботов (`lot-notice.ts`,
// PER-598; `final-notice.ts`, PER-478): им нужны право получателя и название
// лота у соседей, а соседей отправитель не зовёт.
export type OutgoingNotification =
  | Exclude<
      RenderableContent,
      | LotNotice
      | FinalNotice
      | StepWindowNotice
      | InvoiceNotice
      | { kind: "release-summary" }
    >
  | AccessRequestView
  | { kind: "lot-notice"; view: LotNoticeView }
  // Напоминание о счёте (PER-322) приходит собранным: название лота читается
  // у Auction до отправителя.
  | { kind: "invoice-notice"; view: InvoiceNoticeView }
  | ReleaseNote;

// Кадр по образцу P-11: заголовок называет повод и сходку, строки ниже — что
// нужно знать, не открывая карточку. Одно сообщение на повод, карточка целиком
// не повторяется: описание и ссылка на календарь только называются. `today` —
// день сообщества: дата сходки читается, как на карточке, и чужой год
// называется; без него год не называется.
export function renderNotification(
  content: OutgoingNotification,
  auctionBotUsername?: string,
  today?: CommunityDay,
  timeZone = "UTC",
): NotificationMessage {
  if (
    content.kind === "access-requested" ||
    content.kind === "access-request-card" ||
    content.kind === "access-request-decided"
  ) {
    return renderAccessRequest(content);
  }
  if (content.kind === "access-granted") {
    // Тот же текст, что слал экран состава до PER-442: сменился носитель, а
    // не обещание. Кнопка следа — корень «Сходки» придёт новым сообщением.
    return {
      text: "Доступ открыт: теперь тебе видны сходки сообщества.",
      keyboard: new InlineKeyboard().text(
        "Сходки",
        traceCallback("v1:nav:hub"),
      ),
    };
  }
  if (content.kind === "preset-granted") {
    // Кнопка следа — «Управление» придёт новым сообщением, а весть о правах
    // останется в истории. Команду `/manage` отправитель ставит в список
    // команд чата (решение владельца 10 октября 2026 года). Прежних прав
    // получателя факт не несёт, поэтому текст говорит, что есть, а не что
    // появилось: у мейнтейнера «Управление» было и до набора (прогон 14.10, №48).
    return {
      text: "Тебе выданы права администратора сообщества: заявки, состав и сходки. Они собраны в «Управлении» — кнопка ниже или команда /manage.",
      keyboard: new InlineKeyboard().text(
        toManage.name,
        traceCallback("v1:manage:menu"),
      ),
    };
  }
  if (content.kind === "circle-demoted") {
    // Понижение до гостя (PER-537): о смене круга сообщает прежний бот — хаб, и
    // вручает ссылку на новый, бот аукциона (RFC-015, С-12). Ссылка идёт
    // текстом, клавиатуры нет: вести внутрь хаба некуда, а url-кнопка к чужому
    // боту в уведомлении хаба была бы новым приёмом. Факт ссылку не несёт
    // (PER-536) — её даёт `BOT_AUCTION_BOT_USERNAME`; настройки нет, и текст
    // уходит без ссылки: о смене круга человеку всё равно сообщают.
    return {
      text:
        auctionBotUsername === undefined
          ? "Аукцион теперь в боте аукциона."
          : `Аукцион теперь в боте аукциона: https://t.me/${auctionBotUsername}`,
      keyboard: undefined,
    };
  }
  if (content.kind === "prediction-results") {
    const view = renderPredictionResultsNotice(content);
    return {
      text: view.text,
      keyboard: new InlineKeyboard().text(
        view.button.text,
        traceCallback(
          `v1:${encodeAuctionCallback({
            kind: "prediction-results",
            auctionId: view.button.auctionId,
          }).slice(3)}`,
        ),
      ),
    };
  }
  if (content.kind === "raffle-result") {
    // Итог розыгрыша (PER-620): кнопка следа — экран итога розыгрыша аукционного
    // дерева придёт новым сообщением, весть останется в истории.
    const view = renderRaffleNotice(content);
    return {
      text: view.text,
      keyboard: new InlineKeyboard().text(
        view.button.text,
        traceCallback(
          `v1:${encodeAuctionCallback({ kind: "raffle", auctionId: view.button.auctionId }).slice(3)}`,
        ),
      ),
    };
  }
  if (content.kind === "invoice-notice") {
    // Напоминание о счёте (PER-322): кнопка следа — экран счёта придёт новым
    // сообщением, весть останется в истории.
    const { button } = content.view;
    return {
      text: content.view.text,
      format: content.view.format,
      keyboard: new InlineKeyboard().text(
        button.text,
        traceCallback(
          `v1:${encodeAuctionCallback({ kind: "invoice", lotId: button.lotId, invoiceId: button.invoiceId }).slice(3)}`,
        ),
      ),
    };
  }
  if (content.kind === "auction-cancelled") {
    // Отмена аукциона (PER-606): кнопка следа — корень аукциона придёт новым
    // сообщением, весть останется в истории.
    const view = renderAuctionCancelledNotice(content);
    return {
      text: view.text,
      keyboard: new InlineKeyboard().text(
        view.button.text,
        traceCallback(
          `v1:${encodeAuctionCallback({ kind: "root", auctionId: view.button.auctionId }).slice(3)}`,
        ),
      ),
    };
  }
  if (content.kind === "new-auction" || content.kind === "trading-opened") {
    // Вести о новом аукционе и об открытии торгов (PER-646): кнопка следа —
    // корень аукциона или его лента, экран придёт новым сообщением.
    const view = renderAuctionAnnouncement(content, timeZone);
    return {
      text: view.text,
      keyboard: new InlineKeyboard().text(
        view.button.text,
        traceCallback(
          `v1:${encodeAuctionCallback(
            content.kind === "new-auction"
              ? { kind: "root", auctionId: view.button.auctionId }
              : { kind: "feed", auctionId: view.button.auctionId, page: 0 },
          ).slice(3)}`,
        ),
      ),
    };
  }
  if (content.kind === "lot-notice") {
    return {
      text: content.view.text,
      keyboard: lotKeyboard(content.view),
      ...(content.view.format === undefined
        ? {}
        : { format: content.view.format }),
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
  if (content.kind === "release-note") {
    const extra =
      content.hidden > 0
        ? `…и ещё записей: ${content.hidden} — в «Что нового».`
        : undefined;
    return {
      text: [
        `<b>Новое в боте · ${escapeHtml(content.day)}</b>`,
        [...content.lines.map((line) => `• ${escapeHtml(line)}`), extra]
          .filter((line) => line !== undefined)
          .join("\n"),
      ].join("\n\n"),
      keyboard: new InlineKeyboard()
        .text(
          "Что нового",
          traceCallback(
            releasePostData({ summaryId: content.summaryId, part: 1 }),
          ),
        )
        .row()
        .text("Не присылать новое в боте", disableReleaseCallback),
      format: "HTML",
    };
  }
  const meetup = content.meetup;
  const day = today ?? sameYearAs(meetup.when);
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
        text: [
          headline("Новая сходка", meetup),
          ...whenAndWhere(meetup, day),
        ].join("\n"),
        keyboard: open()
          .row()
          .text("Не присылать новые сходки", disablePublishedCallback),
      };
    // У отменённой сходки изменений больше не будет, и выключать нечего:
    // под отменой одна «Открыть сходку» (прогон 14.10, №105).
    case "meetup-changed":
      return {
        text: renderChange(content, day).join("\n"),
        keyboard: isCancellation(content)
          ? open()
          : open()
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
        text: [
          headline("Напоминание", meetup),
          ...whenAndWhere(meetup, day),
        ].join("\n"),
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
          whenLine(meetup.when, day),
        ].join("\n"),
        keyboard: undefined,
      };
    default: {
      const _exhaustive: never = content;
      return _exhaustive;
    }
  }
}

// Кнопки общего рендера — следы хаба: лот — кнопка лота аукционного дерева,
// частота — «Аукцион» в «Настройки» → «Расширения» (PER-605). Карточка и
// экран приходят новым сообщением, уведомление остаётся в истории. У анонса
// финала без своих лотов и у старта финала рядов нет — и клавиатуры тоже.
function lotKeyboard(view: LotNoticeView): InlineKeyboard | undefined {
  if (view.rows.length === 0) return undefined;
  return InlineKeyboard.from(
    view.rows.map((row) =>
      row.map((button) =>
        InlineKeyboard.text(
          button.text,
          traceCallback(
            button.kind === "lot"
              ? `v1:${encodeAuctionCallback({ kind: "lot", lotId: button.lotId, page: 0 }).slice(3)}`
              : "v1:notify:outbid",
          ),
        ),
      ),
    ),
  );
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

function isCancellation(content: ChangeContent): boolean {
  return (
    content.aspects.includes("lifecycle") && content.lifecycle === "cancelled"
  );
}

// Старых значений контракт не несёт, поэтому текст говорит, что изменилось, и
// показывает, как стало. Смена состояния, о которой заголовок говорит сам, —
// отмена, проведение, возврат в публикацию — в перечень не повторяется.
function renderChange(content: ChangeContent, today: CommunityDay): string[] {
  const { meetup, aspects } = content;
  const cancelled = isCancellation(content);
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
  if (!cancelled) lines.push(...whenAndWhere(meetup, today));
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

// Дата и место — тем же видом и с теми же знаками, что на карточке сходки
// («📅 Когда: 14 октября, ср, 12:00», «📍 Где: …»): весть и карточка, куда она
// ведёт, читаются одинаково (прогон 14.10, №60).
function whenAndWhere(meetup: NotifiedMeetup, today: CommunityDay): string[] {
  const venue = meetup.venue.trim();
  return venue === ""
    ? [whenLine(meetup.when, today)]
    : [whenLine(meetup.when, today), marked(pictogram.where, `Где: ${venue}`)];
}

function whenLine(when: MeetupWhen, today: CommunityDay): string {
  return marked(pictogram.when, `Когда: ${formatWhen(when, today)}`);
}

function formatWhen(when: MeetupWhen, today: CommunityDay): string {
  switch (when.kind) {
    case "no-date":
      return "дата пока не назначена";
    case "day":
      return tentative(when.tentative, readableDay(when.date, today));
    case "day-start":
      return tentative(when.tentative, readableMoment(when.at, today));
    case "interval": {
      const sameDay =
        when.start.year === when.end.year &&
        when.start.month === when.end.month &&
        when.start.day === when.end.day;
      const end = sameDay
        ? formatTime(when.end)
        : readableMoment(when.end, today);
      return tentative(
        when.tentative,
        `${readableMoment(when.start, today)}–${end}`,
      );
    }
    default: {
      const _exhaustive: never = when;
      return _exhaustive;
    }
  }
}

// День сообщества без отправителя — год самой сходки: тогда год не называется.
function sameYearAs(when: MeetupWhen): CommunityDay {
  const year =
    when.kind === "no-date"
      ? 0
      : when.kind === "day"
        ? when.date.year
        : when.kind === "day-start"
          ? when.at.year
          : when.start.year;
  return { year, month: 1, day: 1 };
}

// Оповещение о заявке (PER-634). Кнопки под ним — следы: экран по ним
// приходит новым сообщением, а оповещение остаётся в истории как было.
// Выключатель категории стоит под каждым видом и называет очередь заявки
// (PER-635).
function renderAccessRequest(content: AccessRequestView): NotificationMessage {
  const disable = (keyboard: InlineKeyboard) =>
    keyboard.text(
      content.queue === "auction"
        ? "Не присылать запросы в аукцион"
        : "Не присылать запросы в сообщество",
      disableAccessRequestPrefix + content.queue,
    );
  // Аукционная заявка — в очередь аукциона, где допуск выдаёт право ставить,
  // а не круг участника (PER-534).
  const title =
    content.queue === "auction"
      ? "Новая заявка на участие в аукционе"
      : "Новая заявка на доступ в сообщество";
  const domain = queueDomain(content.queue);
  const openQueue = () =>
    new InlineKeyboard().text("Открыть заявки", traceCallback(`${domain}:q`));
  switch (content.kind) {
    // Тело заявки и решение тем же путём, что карточка очереди: те же данные
    // кнопок «Допустить» и «Отказать», те же проверки права и исхода.
    // Решённую с тех пор заявку кнопка не решает: Identity отвечает «уже
    // решено», и бот говорит это так же, как под карточкой очереди.
    case "access-request-card": {
      const { application } = content;
      const data = cardCursorData(cursorOf(application));
      const keyboard = new InlineKeyboard()
        .text(admitLabel, traceCallback(`${domain}:qa:${data}`))
        .text(declineLabel, traceCallback(`${domain}:qd:${data}`))
        .row();
      if (application.telegramUsername !== undefined) {
        keyboard
          .url("Профиль ↗", `https://t.me/${application.telegramUsername}`)
          .row();
      }
      return {
        text: `${title}\n\n${applicationCardBody(application, content.shownAtMs)}`,
        keyboard: disable(keyboard),
        format: "HTML",
      };
    }
    // Заявку решил другой администратор, пока факт шёл: решать нечего, а
    // очередь, где лежат остальные, — по кнопке.
    case "access-request-decided":
      return {
        text: `${title}\n\nЭту заявку уже решили.`,
        keyboard: disable(openQueue().row()),
      };
    // Без права очереди или без курсора в факте — один повод и переход в
    // очередь с начала, как до PER-634.
    case "access-requested":
      return { text: title, keyboard: disable(openQueue().row()) };
    default: {
      const _exhaustive: never = content;
      return _exhaustive;
    }
  }
}

function tentative(isTentative: boolean, value: string): string {
  return isTentative ? `предварительно ${value}` : value;
}

function formatTime(value: LocalDateTime): string {
  return `${pad(value.hours)}:${pad(value.minutes)}`;
}

function pad(part: number): string {
  return String(part).padStart(2, "0");
}

export type SendMessageApi = Pick<
  Api,
  "sendMessage" | "setMyCommands" | "deleteMyCommands"
>;

// Содержимое рисуется здесь же, при отправке: соседи для текста хабу не
// нужны, и рендер пакета доставки отдаёт содержимое как есть. `auctionBotUsername`
// нужен одному сообщению — вести о понижении, которая вручает ссылку на бот
// аукциона (PER-537); `today` — день сообщества для дат сходки.
export function createNotificationSender(
  api: SendMessageApi,
  auctionBotUsername?: string,
  today?: () => CommunityDay,
  timeZone = "UTC",
): NotificationSender<OutgoingNotification> {
  return {
    async send({ telegramUserId, message: content }) {
      const message = renderNotification(
        content,
        auctionBotUsername,
        today?.(),
        timeZone,
      );
      try {
        // Личный чат с человеком имеет id самого человека. Telegram держит id в
        // 52 битах, поэтому переход из bigint в number точен. Метка каталога —
        // чтобы линтер test kit видел и эту отправку: весть идёт мимо
        // адаптера экранов.
        await api.sendMessage(Number(telegramUserId), message.text, {
          ...screenMark("notification"),
          ...(message.keyboard === undefined
            ? {}
            : { reply_markup: message.keyboard }),
          ...(message.format === undefined
            ? {}
            : { parse_mode: message.format }),
          link_preview_options: { is_disabled: true },
        });
        // Назначенному администратором — команда `/manage` в списке его чата
        // (PER-468; решение владельца 10 октября 2026 года). Отказ записи
        // доставку не отменяет: вход `/start` поставит список снова.
        if (content.kind === "preset-granted") {
          await registerChatCommands(
            api,
            Number(telegramUserId),
            managerCommands,
          );
        }
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
