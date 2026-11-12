// Чтения Achievements в словаре бота. Личная коллекция не принимает владельца
// из кнопки: его всегда приносит Viewer текущего update.
export type AchievementView = {
  code: string;
  title: string;
  description: string;
  imageVersion?: string;
  recipients: "one" | "many";
  manual: boolean;
};
export type HeldAchievementView = {
  grantId: string;
  auctionId: string;
  grantedAt: string;
  achievement: AchievementView;
};
export type EventAchievementView = {
  achievement: AchievementView;
  holderIds: readonly string[];
  erasedHolders: number;
};
export interface AchievementsPort {
  reportFailure?(cause: unknown): void;
  listMine(identityId: string): Promise<readonly HeldAchievementView[]>;
  getEvent(auctionId: string): Promise<readonly EventAchievementView[]>;
  getImage(code: string): Promise<{
    content: Uint8Array;
    mediaType: string;
    version: string;
  }>;
}

export type AchievementsIntent =
  | { kind: "achievements"; auctionId?: string; page: number }
  | {
      kind: "achievement";
      auctionId?: string;
      reference: string;
      page: number;
      holdersPage: number;
    };

export type AchievementScreen = {
  scope: "mine" | "event";
  auctionId?: string;
  page: number;
  pages: number;
  items: readonly { title: string; callbackData: string }[];
  // Кнопки списка, листания и возврата строит юзкейс, подписи — рендерер.
  previous?: string;
  next?: string;
  back: string;
} & (
  | { view: "list" }
  | {
      view: "card";
      achievement: AchievementView;
      grantedAt?: string;
      holderNames: readonly string[];
      erasedHolders: number;
      holdersPage: number;
      holderPages: number;
    }
  | { view: "unavailable"; retry: string; backToList?: true }
);
