// Грамматика `callback_data` материалов сходки — одна на оба входа (PER-913).
// Материалы открывают с карточки сходки и с черновика формы создания, и экран
// один: различается только возврат «‹ Сходка» или «‹ Черновик». Признак входа
// живёт в самом `callback_data` (ADR-030, «Состояние в сообщении»): у кнопки
// подтверждения прикрепления свободных байт нет — `v1:mm:ca` с двумя токенами
// и версией занимает ровно 64, — поэтому вход задаёт домен: `mm` — карточка,
// `md` — черновик. Сборка и разбор домена здесь одни, второй копии нет.

export type MaterialsOrigin = "card" | "draft";

const domains: Readonly<Record<MaterialsOrigin, string>> = {
  card: "mm",
  draft: "md",
};

/** Домен `callback_data` материалов для входа: карточка или черновик. */
export function materialsDomainOf(origin: MaterialsOrigin): string {
  return domains[origin];
}

/** Вход материалов по домену `callback_data`; чужой домен — не материалы. */
export function materialsOriginOf(domain: string): MaterialsOrigin | undefined {
  if (domain === domains.card) return "card";
  if (domain === domains.draft) return "draft";
  return undefined;
}

function materialsData(
  origin: MaterialsOrigin,
  action: string,
  ...parts: string[]
): string {
  return ["v1", materialsDomainOf(origin), action, ...parts].join(":");
}

export function materialsListData(
  origin: MaterialsOrigin,
  token: string,
  page?: number,
): string {
  return materialsData(
    origin,
    "list",
    ...(page === undefined ? [token] : [token, String(page)]),
  );
}

export function materialsAddData(
  origin: MaterialsOrigin,
  token: string,
): string {
  return materialsData(origin, "add", token);
}

export function materialsEdgeData(
  origin: MaterialsOrigin,
  token: string,
): string {
  return materialsData(origin, "e", token);
}

export function materialsMoveData(
  origin: MaterialsOrigin,
  token: string,
  materialToken: string,
  direction: "up" | "down",
  version: number,
): string {
  return materialsData(
    origin,
    direction === "up" ? "u" : "d",
    token,
    materialToken,
    String(version),
  );
}

export function materialsRemoveData(
  origin: MaterialsOrigin,
  token: string,
  materialToken: string,
): string {
  return materialsData(origin, "rm", token, materialToken);
}

export function materialsDeclineData(
  origin: MaterialsOrigin,
  token: string,
): string {
  return materialsData(origin, "no", token);
}

export function materialsFileData(
  origin: MaterialsOrigin,
  token: string,
  materialToken: string,
): string {
  return materialsData(origin, "file", token, materialToken);
}

export function materialsConfirmAttachData(
  origin: MaterialsOrigin,
  token: string,
  materialToken: string,
  version: number,
): string {
  return materialsData(origin, "ca", token, materialToken, String(version));
}

export function materialsConfirmRemoveData(
  origin: MaterialsOrigin,
  token: string,
  materialToken: string,
  version: number,
): string {
  return materialsData(origin, "cr", token, materialToken, String(version));
}
