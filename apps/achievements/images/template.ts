// SVG-шаблон картинки ачивки (docs/product/future/achievements-auction.md,
// «Картинки»): рамка по ценности, знак ачивки в рамке и подпись охвата под
// ней. Шаблон — чистая функция строки: одни и те же данные дают те же байты
// SVG, а значит и PNG.

export type Rarity = "common" | "rare" | "epic" | "legendary";
export type Reach = "one_per_event" | "few" | "many";
export type Sign =
  | "flag"
  | "gear"
  | "comeback"
  | "cards"
  | "ticket"
  | "crystal_ball";

export type Badge = {
  code: string;
  rarity: Rarity;
  reach: Reach;
  sign: Sign;
};

export const width = 512;
export const height = 600;

// Рамка показывает ценность, а не число получивших.
const frames: Record<Rarity, string> = {
  common: "#8a94a6",
  rare: "#3f82e8",
  epic: "#a05ee0",
  legendary: "#e3a72a",
};

// Охват — обычная фраза, без ступеней и сравнений с другими.
const captions: Record<Reach, string> = {
  one_per_event: "один на аукцион",
  few: "немногие",
  many: "многие",
};

const ink = "#f4f1ea";
const ground = "#1b1f2a";

export function svg(badge: Badge): string {
  const frame = frames[badge.rarity];

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${ground}"/>`,
    `<rect x="28" y="28" width="456" height="456" rx="56" fill="none" stroke="${frame}" stroke-width="24"/>`,
    `<g fill="${ink}" stroke="none">${sign(badge.sign, frame)}</g>`,
    `<text x="256" y="560" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="40" fill="${frame}">${captions[badge.reach]}</text>`,
    "</svg>",
  ].join("");
}

// Знаки рисуются в квадрате рамки с центром (256, 256).
function sign(name: Sign, accent: string): string {
  switch (name) {
    case "flag":
      return flag();
    case "gear":
      return gear();
    case "comeback":
      return comeback();
    case "cards":
      return cards(accent);
    case "ticket":
      return ticket(accent);
    case "crystal_ball":
      return crystalBall(accent);
  }
}

// Стартовый флажок: древко и клетчатое полотнище.
function flag(): string {
  const cells: string[] = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      if ((row + col) % 2 === 0) {
        cells.push(
          `<rect x="${200 + col * 36}" y="${140 + row * 32}" width="36" height="32"/>`,
        );
      }
    }
  }
  return [
    `<rect x="176" y="128" width="20" height="260" rx="6"/>`,
    `<rect x="196" y="136" width="188" height="136" fill="none" stroke="${ink}" stroke-width="8"/>`,
    ...cells,
  ].join("");
}

// Шестерёнка: зубцы по кругу и отверстие.
function gear(): string {
  const teeth: string[] = [];
  for (let i = 0; i < 8; i++) {
    teeth.push(
      `<rect x="232" y="104" width="48" height="64" rx="8" transform="rotate(${i * 45} 256 256)"/>`,
    );
  }
  return [
    ...teeth,
    `<circle cx="256" cy="256" r="112"/>`,
    `<circle cx="256" cy="256" r="44" fill="${ground}"/>`,
  ].join("");
}

// Круговая стрелка: дуга почти в полный круг и наконечник.
function comeback(): string {
  return [
    `<path d="M 256 136 A 120 120 0 1 1 152 196" fill="none" stroke="${ink}" stroke-width="36" stroke-linecap="round"/>`,
    `<path d="M 112 148 L 196 160 L 148 236 Z"/>`,
  ].join("");
}

// Три карточки веером.
function cards(accent: string): string {
  const card = (angle: number, fill: string) =>
    `<rect x="196" y="136" width="120" height="176" rx="16" fill="${fill}" stroke="${ground}" stroke-width="8" transform="rotate(${angle} 256 376)"/>`;
  return [card(-24, ink), card(0, ink), card(24, accent)].join("");
}

// Билет с вырезами по бокам и звездой.
function ticket(accent: string): string {
  return [
    `<path d="M 104 176 H 408 V 224 A 32 32 0 0 0 408 288 V 336 H 104 V 288 A 32 32 0 0 0 104 224 Z"/>`,
    `<polygon points="${star(256, 256, 64, 26)}" fill="${accent}"/>`,
  ].join("");
}

// Хрустальный шар на подставке, с бликом.
function crystalBall(accent: string): string {
  return [
    `<circle cx="256" cy="228" r="112"/>`,
    `<circle cx="216" cy="188" r="28" fill="${accent}"/>`,
    `<path d="M 176 340 H 336 L 360 392 H 152 Z"/>`,
  ].join("");
}

// Пятиконечная звезда: вершины через одну на внешнем и внутреннем радиусе.
// Координаты округлены: одинаковые данные дают одинаковую строку на любой
// машине.
function star(cx: number, cy: number, outer: number, inner: number): string {
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const x = Math.round(cx + radius * Math.cos(angle));
    const y = Math.round(cy + radius * Math.sin(angle));
    points.push(`${x},${y}`);
  }
  return points.join(" ");
}
