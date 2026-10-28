import type { AchievementScreen } from "./auction-ui/index.js";
import type { LotPhotoKey } from "./core/auction/lot-photos.js";

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const short = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

// Оба бота показывают один набор одним текстом и одной навигацией.
export function achievementScreen(screen: AchievementScreen, rich = false) {
  const id =
    screen.view === "unavailable"
      ? ("achievements-unavailable" as const)
      : screen.scope === "mine"
        ? screen.view === "list"
          ? ("my-achievements" as const)
          : ("my-achievement" as const)
        : screen.view === "list"
          ? ("auction-achievements" as const)
          : ("auction-achievement" as const);
  const keyboard: { text: string; callback_data: string }[][] = [];
  const backName =
    screen.view === "card"
      ? "Ачивки"
      : screen.scope === "mine"
        ? "Меню"
        : "Аукцион";
  let text = "<b>Ачивки</b>";
  let photos: readonly LotPhotoKey[] = [];
  if (screen.view === "unavailable") {
    text =
      "<b>Ачивки недоступны</b>\n\nНе получилось загрузить ачивки. Попробуй ещё раз.";
    keyboard.push([{ text: "Повторить", callback_data: screen.retry }]);
  } else if (screen.view === "list") {
    if (screen.pages > 1) text += ` · ${screen.page + 1} из ${screen.pages}`;
    text +=
      screen.items.length === 0
        ? screen.scope === "mine"
          ? "\n\nЗдесь появятся твои ачивки аукционов."
          : "\n\nУ этого аукциона пока нет набора ачивок."
        : "\n\nВыбери ачивку.";
    if (screen.items.length > 0)
      text += `\n\n${screen.items.map((item) => `• ${escapeHtml(short(item.title, 200))}`).join("\n")}`;
    for (const item of screen.items)
      keyboard.push([
        {
          text: short(item.title.replaceAll(/\s+/g, " ").trim(), 56),
          callback_data: item.callbackData,
        },
      ]);
  } else {
    const a = screen.achievement;
    text = `<b>Ачивка</b>\n\n<b>${escapeHtml(short(a.title, 200))}</b>\n\n${escapeHtml(short(a.description, 1600))}`;
    text += `\n\n${a.manual ? "Выдаёт организатор." : "Выдаётся по критерию."} ${a.recipients === "one" ? "Один получатель на аукцион." : "Получает каждый, кто выполнит условие."}`;
    if (screen.scope === "mine") {
      // ISO-дата не зависит от локали процесса; время выдачи не сравнивает людей.
      text += `\n\nПолучена: ${escapeHtml(screen.grantedAt?.slice(0, 10) ?? "дата неизвестна")}.`;
    } else {
      text += "\n\nПолучившие:";
      text +=
        screen.holderNames.length === 0
          ? " пока никого."
          : `\n${screen.holderNames.map((name) => `• ${escapeHtml(short(name, 100))}`).join("\n")}`;
      if (screen.holderPages > 1)
        text += `\n${screen.holdersPage + 1} из ${screen.holderPages}`;
      if (screen.erasedHolders > 0)
        text += `\nЕщё получивших без имени: ${screen.erasedHolders}.`;
    }
    if (a.imageVersion !== undefined)
      photos = [
        {
          lotId: `achievement:${a.code}`,
          version: a.imageVersion,
          achievementCode: a.code,
        },
      ];
  }
  const paging = [
    ...(screen.previous === undefined
      ? []
      : [{ text: "←", callback_data: screen.previous }]),
    ...(screen.next === undefined
      ? []
      : [{ text: "→", callback_data: screen.next }]),
  ];
  if (paging.length > 0) keyboard.push(paging);
  keyboard.push([{ text: `‹ ${backName}`, callback_data: screen.back }]);
  if (rich) {
    const [heading = "", ...paragraphs] = text.split("\n\n");
    text =
      heading.replace(/^<b>(.*?)<\/b>(.*)$/, "<h1>$1$2</h1>") +
      paragraphs
        .map((p) => `<p>${p.replaceAll("\n", "<br>")}</p>`)
        .join("");
  }
  return { id, text, keyboard, photos };
}
