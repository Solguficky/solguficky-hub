// Граница пакета глазами потребителя. Файл входит в `npm run typecheck` и
// импортирует пакет по его имени — тем же разрешением через `exports`, каким
// пойдёт приложение. Сырой юзкейс и диспетчер стоят под `@ts-expect-error`:
// откроет их кто-нибудь в `exports` — директива станет лишней, и typecheck
// покраснеет.
//
// Положительные импорты нужны, чтобы `@ts-expect-error` не выполнялся
// впустую: без них директиву закрыла бы и сломанная ссылка пакета на себя.

import { handleAuctionUpdate } from "@solguficky/auction-bot-ui";
import { describeAuctionContract } from "@solguficky/auction-bot-ui/contract";
// @ts-expect-error диспетчер проверку доступа не делает и закрыт так же
import { dispatchAuctionIntent } from "@solguficky/auction-bot-ui/dist/src/dispatcher.js";
// @ts-expect-error и по пути собранного файла тоже
import { openLot as builtOpenLot } from "@solguficky/auction-bot-ui/dist/src/internal/use-cases/open-lot.js";
// @ts-expect-error сырой юзкейс не входит в exports
import { openFeed } from "@solguficky/auction-bot-ui/internal/use-cases/open-feed";
// @ts-expect-error сырой юзкейс не входит в exports
import { openLot } from "@solguficky/auction-bot-ui/internal/use-cases/open-lot";

export const reachable = [handleAuctionUpdate, describeAuctionContract];
export const unreachable = [
  openFeed,
  openLot,
  builtOpenLot,
  dispatchAuctionIntent,
];
