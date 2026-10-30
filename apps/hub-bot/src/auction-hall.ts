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
// К базе дописывается идентификатор аукциона (UUID с чертой и запасом): адрес
// кнопки не должен перейти предел Bot API.
const BASE_LIMIT = URL_LIMIT - 64;

function isIpAddress(host: string): boolean {
  return host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

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
  const limit = base ? BASE_LIMIT : URL_LIMIT;
  if (raw.length > limit) {
    return { ok: false, error: `${name} exceeds ${limit} characters` };
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
  // Bot API отвергает кнопку-URL с локальным адресом или IP и отвечает на
  // весь экран `BUTTON_URL_INVALID`, поэтому такое значение — отказ старта, а
  // не пропавшая карточка лота.
  if (!url.hostname.includes(".") || isIpAddress(url.hostname)) {
    return {
      ok: false,
      error: `${name} must have a public host name, not an IP address or a local name`,
    };
  }
  // К базе дописывается идентификатор: запрос или фрагмент в ней увели бы его
  // не в путь.
  // Пустые «?» и «#» поля `search` и `hash` не заполняют, но остаются в адресе:
  // смотрим на сырое значение.
  if (base && /[?#]/.test(raw)) return refusal;
  const href = base ? url.href.replace(/\/+$/, "") : url.href;
  if (href.length > limit) {
    return { ok: false, error: `${name} exceeds ${limit} characters` };
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
