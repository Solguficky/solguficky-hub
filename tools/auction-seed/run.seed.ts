import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { noopTracing } from "../../apps/hub-bot/src/core/tracing.js";
import { createUuidV7 } from "../../apps/hub-bot/src/core/uuid-v7.js";
import { createAuctionClient } from "../../apps/hub-bot/src/surfaces/hub/auction/client.js";
import { createIdentityClient } from "../../apps/hub-bot/src/surfaces/hub/identity/client.js";
import { createMeetupsClient } from "../../apps/hub-bot/src/surfaces/hub/meetups/client.js";
import { parseCatalog } from "./catalog.js";
import { readSeedEnvironment } from "./environment.js";
import { seedAuction } from "./seed.js";

// Точка входа наполнения (PER-613): `just auction-seed <каталог>`. Не тест и не
// набор: файл назван `*.seed.ts`, его гоняет только `vitest.seed.config.ts`, а
// vitest здесь — загрузчик TypeScript, как у пульта провода. Клиенты —
// продакшн-код бота хаба без подмен: транспорт, токен вызывающего и перевод
// отказов те же, что у формы сходки и формы лота.

// Фото через туннель до stage грузится дольше бюджета действия бота; команда
// не держит человека в чате, поэтому дедлайн вызова длиннее.
const callTimeoutMs = 30_000;

describe("auction seed", () => {
  it("seeds the catalog", async () => {
    // Переменные и каталог проверяются до первого соединения: отказ здесь не
    // оставляет ни сходки, ни аукциона.
    const environment = readSeedEnvironment();
    const catalog = await parseCatalog(
      await readFile(environment.catalogPath, "utf8"),
      environment.catalogPath,
    );
    const options = {
      tracing: noopTracing(),
      serviceToken: environment.serviceToken,
      timeoutMs: callTimeoutMs,
    };
    const identity = createIdentityClient(environment.identityUrl, {
      ...options,
      communityTimeZone: environment.communityTimeZone,
    });
    const meetups = createMeetupsClient(environment.meetupsUrl, {
      ...options,
      communityTimeZone: environment.communityTimeZone,
    });
    const auctions = createAuctionClient(environment.auctionUrl, options);
    try {
      const result = await seedAuction(
        catalog,
        environment.administratorTelegramUserId,
        {
          identity,
          meetups,
          auctions,
          newId: () => createUuidV7(),
          log: (line) => console.log(`auction-seed: ${line}`),
        },
      );
      console.log(
        `auction-seed: готово — сходка ${result.meetupId}, аукцион ${result.auctionId}, лотов ${result.lots.length}`,
      );
    } finally {
      identity.close();
      meetups.close();
      auctions.close();
    }
  });
});
