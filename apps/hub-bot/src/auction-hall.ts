// Экран зала и стрим (PER-825, дополнение ADR-040 от 2026-10-29): кнопки-URL
// на карточке лота и в «Расширениях» сходки. Адреса — конфигурация среды, как
// ссылки FAQ; нет адреса — нет кнопки, и бот работает без неё.
export type HallLinks = {
  // База страницы экрана зала: к ней через «/» дописывается `auction_id`.
  screenUrl?: string;
  streamUrl?: string;
};

export type HallLinksResult =
  | { ok: true; links: HallLinks }
  | { ok: false; error: string };

const linkSign = " ↗";

export const hallScreenLabel = `Экран зала${linkSign}`;
export const hallStreamLabel = `Стрим${linkSign}`;

const URL_LIMIT = 2048;

function readHttpsUrl(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  base: boolean,
): { ok: true; url?: string } | { ok: false; error: string } {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return { ok: true };
  const refusal = {
    ok: false,
    error: `${name} must be an HTTPS URL without credentials${base ? ", query or fragment" : ""}`,
  } as const;
  if (raw.length > URL_LIMIT) {
    return { ok: false, error: `${name} exceeds ${URL_LIMIT} characters` };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refusal;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return refusal;
  }
  // К базе дописывается идентификатор: запрос или фрагмент в ней увели бы его
  // не в путь.
  if (base && (url.search !== "" || url.hash !== "")) return refusal;
  const href = base ? url.href.replace(/\/+$/, "") : url.href;
  if (href.length > URL_LIMIT) {
    return { ok: false, error: `${name} exceeds ${URL_LIMIT} characters` };
  }
  return { ok: true, url: href };
}

// Оба адреса необязательны. Значение не из HTTPS или с credentials — отказ
// старта с именем переменной: молчаливо пропавшая кнопка искалась бы в зале.
export function readHallLinks(
  env: Readonly<Record<string, string | undefined>>,
): HallLinksResult {
  const screen = readHttpsUrl(env, "BOT_HALL_SCREEN_URL", true);
  if (!screen.ok) return screen;
  const stream = readHttpsUrl(env, "BOT_STREAM_URL", false);
  if (!stream.ok) return stream;
  return {
    ok: true,
    links: {
      ...(screen.url === undefined ? {} : { screenUrl: screen.url }),
      ...(stream.url === undefined ? {} : { streamUrl: stream.url }),
    },
  };
}

export type HallButton = { text: string; url: string };

// Кнопки-URL ряда: «Экран зала ↗» адресом аукциона и «Стрим ↗» — по одной в
// ряд, как кнопки ссылок FAQ. Без настройки — пусто.
export function hallButtons(
  links: HallLinks | undefined,
  auctionId: string,
): HallButton[] {
  const buttons: HallButton[] = [];
  if (links?.screenUrl !== undefined) {
    buttons.push({
      text: hallScreenLabel,
      url: `${links.screenUrl}/${encodeURIComponent(auctionId)}`,
    });
  }
  if (links?.streamUrl !== undefined) {
    buttons.push({ text: hallStreamLabel, url: links.streamUrl });
  }
  return buttons;
}
