import type { RpcMetadata } from "../rpc-metadata.js";

// Категории, которые сходка может нести. Отдельный тип, а не фильтр по списку:
// `SetMeetupCategoryPreference` отвергает глобальную категорию с
// `INVALID_ARGUMENT`, и этот отказ дешевле не получить вовсе, чем отобразить.
export type MeetupCategory = "changes" | "material" | "reminder" | "organizer";

// Две глобальные категории поверх тех же четырёх: подписаться на ещё не
// созданную сходку нельзя, а объявление не привязано ни к одной.
export type GlobalOnlyCategory = "published" | "announcement";

export type NotificationCategory = MeetupCategory | GlobalOnlyCategory;

export type CategoryState<C extends NotificationCategory> = {
  category: C;
  enabled: boolean;
};

// Снимок тотален по словарю: категория, которой человек не касался, приезжает
// со значением продукта, а не отсутствующей записью.
export type GlobalPreferences = {
  categories: readonly CategoryState<NotificationCategory>[];
};

// Признак подписки лежит рядом со списком, а не вместо него: подписка, у
// которой выключены все категории, — законное состояние, а не отписка.
export type MeetupPreferences = {
  meetupId: string;
  subscribed: boolean;
  categories: readonly CategoryState<MeetupCategory>[];
};

export type NotificationFailure =
  | { kind: "forbidden" }
  | { kind: "invalid"; message: string }
  | { kind: "conflict" }
  | { kind: "timeout"; cause: unknown }
  | { kind: "unavailable"; cause: unknown };

export type GlobalPreferencesResult =
  | { kind: "ok"; preferences: GlobalPreferences }
  | NotificationFailure;

export type MeetupPreferencesResult =
  | { kind: "ok"; preferences: MeetupPreferences }
  | NotificationFailure;

// Каждая команда несёт целевое состояние, а не переворот текущего, и возвращает
// снимок области, к которой относится. Операции снятия переопределения в
// контракте нет: «наследовать глобальное» на проводе не выражается
// (contracts/proto/notifications/v1/notifications_service.proto).
export type Notifications = {
  getGlobalPreferences(
    identityId: string,
    meta?: RpcMetadata,
  ): Promise<GlobalPreferencesResult>;
  getMeetupPreferences(
    identityId: string,
    meetupId: string,
    meta?: RpcMetadata,
  ): Promise<MeetupPreferencesResult>;
  setSubscription(
    identityId: string,
    meetupId: string,
    subscribed: boolean,
    meta?: RpcMetadata,
  ): Promise<MeetupPreferencesResult>;
  setGlobalCategory(
    identityId: string,
    category: NotificationCategory,
    enabled: boolean,
    meta?: RpcMetadata,
  ): Promise<GlobalPreferencesResult>;
  setMeetupCategory(
    identityId: string,
    meetupId: string,
    category: MeetupCategory,
    enabled: boolean,
    meta?: RpcMetadata,
  ): Promise<MeetupPreferencesResult>;
};
