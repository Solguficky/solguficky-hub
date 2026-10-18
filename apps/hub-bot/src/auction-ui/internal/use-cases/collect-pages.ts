// Обход серверных страниц перечисления целиком. Ленту и хронологию режет на
// страницы край, а не сервер, поэтому их выкачивают на каждое нажатие; повтор
// токена или перечисление длиннее, чем помещается в кнопки, — дефект соседа,
// а не повод крутиться.
//
// Страниц с запасом на всё перечисление при умолчании сервера в 50 строк на
// страницу: 200 × 50 покрывают 8000 строк, иначе предел страниц срабатывал бы
// раньше предела строк.
const MAX_SERVER_PAGES = 200;

export async function collectPages<T>(input: {
  // Чьи страницы: имя попадает в текст отказа.
  what: string;
  maxItems: number;
  fetch: (
    pageToken: string,
  ) => Promise<{ items: readonly T[]; nextPageToken: string }>;
}): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let pageToken = "";
  for (let pages = 0; pages < MAX_SERVER_PAGES; pages += 1) {
    const page = await input.fetch(pageToken);
    items.push(...page.items);
    if (items.length > input.maxItems) {
      throw new Error(`${input.what} exceeds ${input.maxItems} items`);
    }
    if (page.nextPageToken === "") return items;
    if (seen.has(page.nextPageToken)) {
      throw new Error(`${input.what} repeated a page token`);
    }
    seen.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }
  throw new Error(`${input.what} exceeds ${MAX_SERVER_PAGES} server pages`);
}
