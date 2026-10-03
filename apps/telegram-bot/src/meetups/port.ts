import type { Person } from "../application/types.js";
import type { RpcMetadata } from "../rpc-metadata.js";

export type MeetupSchedule = {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
};

// Вид файла — то, чем Telegram его прислал (PER-443): `file_id` фото нельзя
// отправить документом и наоборот. `document` — любой файл, который не фото,
// в том числе прикреплённый до появления вида: его вид не записан.
export type MaterialFileKind = "photo" | "document";

export type MeetupMaterialSource =
  | { kind: "message-link"; url: string }
  | { kind: "file"; fileId: string; fileKind: MaterialFileKind };

export type MeetupMaterial = {
  id: string;
  title: string;
  source: MeetupMaterialSource;
};

export type MeetupSnapshot = {
  id: string;
  // Внутренний идентификатор автора в Identity, а не Telegram-атрибут: ник
  // карточка спрашивает у Identity отдельно (PER-404).
  author: string;
  title: string;
  description: string;
  venue: string;
  schedule?: MeetupSchedule;
  lifecycle: "planned" | "held" | "cancelled";
  visibility: "hidden" | "visible";
  // Версия агрегата, из которой принято решение: команда изменения или перехода
  // несёт её обратно как `expected_version`, и Meetups сравнивает её в предикате
  // записи (PER-78).
  version: number;
  materials: readonly MeetupMaterial[];
  // Назначенный момент отложенной публикации в часовом поясе сообщества.
  // Meetups отдаёт мгновение UTC, а адаптер переводит его в местное время
  // сообщества: человек вводит момент в этом поясе и должен увидеть его тем же,
  // а не сдвинутым на разницу поясов. Отсутствие — «публикация не назначена».
  publishAt?: MeetupSchedule;
};

export type MeetupSummary = {
  id: string;
  title: string;
  schedule?: { year: number; month: number; day: number };
  // Скрытую сходку Meetups отдаёт только автору и администратору (ADR-022):
  // по этому полю бот помечает её в списке и собирает раздел «Скрытые»,
  // не повторяя само правило видимости.
  visibility: "hidden" | "visible";
};

// Архив различает три исхода вручную (Archive.fs, PER-229): "held"/"cancelled"
// приходят как есть, а "past" — это lifecycle "planned" внутри архивного
// ответа, где само присутствие в списке уже означает, что дата прошла.
export type ArchivedMeetupSummary = MeetupSummary & {
  status: "held" | "cancelled" | "past";
};

export type MeetupFailure =
  | { kind: "forbidden" }
  // `precondition` отмечает FAILED_PRECONDITION: запрос корректен, но домен
  // не позволяет действие в текущем состоянии сходки. Без флага это
  // INVALID_ARGUMENT — неисполнимо само значение. Коды разведены контрактом
  // намеренно (integration.md), и кадр отказа выбирается по ним, а не по тексту.
  // Текст отказа лежит только в `cause` и уходит в запись границы, а не
  // человеку: строки, которую экран мог бы подставить в ответ, нет (PER-397).
  | { kind: "invalid"; cause: unknown; precondition?: true }
  | { kind: "conflict" }
  | { kind: "timeout"; cause: unknown }
  | { kind: "unavailable"; cause: unknown };

export type MeetupResult =
  | { kind: "ok"; meetup: MeetupSnapshot }
  | MeetupFailure;

export type MeetupGetResult = MeetupResult | { kind: "not-found" };

export type MeetupListResult =
  | { kind: "ok"; meetups: readonly MeetupSummary[] }
  | MeetupFailure;

export type ArchivedMeetupListResult =
  | { kind: "ok"; meetups: readonly ArchivedMeetupSummary[] }
  | MeetupFailure;

// `expectedVersion` — версия карточки, которую человек видел, когда начал
// действие, а не перечитанная перед командой: иначе устаревший экран не давал
// бы конфликта вовсе (integration.md, PER-393).
export type AttachMaterialRequest = {
  person: Person;
  meetupId: string;
  material: MeetupMaterial;
  expectedVersion: number;
  meta?: RpcMetadata;
};

export type RemoveMaterialRequest = {
  person: Person;
  meetupId: string;
  materialId: string;
  expectedVersion: number;
  meta?: RpcMetadata;
};

export type Meetups = {
  listVisible(person: Person, meta?: RpcMetadata): Promise<MeetupListResult>;
  listArchived(
    person: Person,
    meta?: RpcMetadata,
  ): Promise<ArchivedMeetupListResult>;
  createDraft(
    person: Person,
    id: string,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
  get(person: Person, id: string, meta?: RpcMetadata): Promise<MeetupGetResult>;
  changeAttributes(
    person: Person,
    meetup: MeetupSnapshot,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
  setSchedule(
    person: Person,
    meetup: MeetupSnapshot,
    schedule: MeetupSchedule,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
  publish(
    person: Person,
    meetup: MeetupSnapshot,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
  unpublish(
    person: Person,
    meetup: MeetupSnapshot,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
  cancel(
    person: Person,
    meetup: MeetupSnapshot,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
  markHeld(
    person: Person,
    meetup: MeetupSnapshot,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
  // Момент — местная дата и время сообщества; в мгновение его переводит Meetups.
  schedulePublication(
    person: Person,
    meetup: MeetupSnapshot,
    moment: MeetupSchedule,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
  cancelPublication(
    person: Person,
    meetup: MeetupSnapshot,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
  attachMaterial(request: AttachMaterialRequest): Promise<MeetupResult>;
  removeMaterial(request: RemoveMaterialRequest): Promise<MeetupResult>;
};
