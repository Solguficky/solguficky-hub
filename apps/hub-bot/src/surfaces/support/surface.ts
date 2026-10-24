import { Kvm } from "@nats-io/kv";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  type NatsDelivery,
  natsConnectOptions,
  watchBusStatus,
} from "../../core/delivery/index.js";
import { countFailure } from "../../core/failures.js";
import type { SurfaceDefinition } from "../../core/process.js";
import { createBot } from "./bot.js";
import { readSupportConfig } from "./config.js";
import { checkOperatorGroup } from "./group.js";
import { createIdentityClient } from "./identity.js";
import {
  createPairStore,
  type PairStore,
  supportTopicsBucket,
} from "./pairs.js";

// Поверхность поддержки (ADR-068, п. 1): процесс с `BOT_SURFACE=support`,
// своим токеном и поллером. Адресных фактов Notifications у неё нет, а вход
// процесса из шины она занимает соединением с bucket'ом пар: общий процесс
// открывает его до поллера и гасит первым — ровно то, что нужно хранилищу.
// Команд в кнопке меню клиента нет: у человека переписка, а не экраны.
export const supportSurface: SurfaceDefinition = ({
  env,
  config,
  logger,
  tracing,
}) => {
  const loaded = readSupportConfig(env);
  if (!loaded.ok) return loaded;
  const { groupId } = loaded.config;
  const identity = createIdentityClient({
    identityUrl: config.identityUrl,
    serviceToken: config.serviceToken,
    tracing,
  });
  // Хранилище появляется при старте шины, а бот собирается раньше. Update до
  // него не приходит: поллер стартует после шины (`src/core/process.ts`), —
  // поэтому пустое хранилище — нарушение порядка, а не ожидаемое состояние.
  let pairs: PairStore | undefined;
  const bot = createBot({
    token: config.token,
    environment: config.environment,
    tracing,
    logger,
    groupId,
    timeZone: config.communityTimeZone,
    standing: identity.standing,
    pairs: () => {
      if (pairs === undefined) {
        throw new Error("support pair store is not open yet");
      }
      return pairs;
    },
  });
  return {
    ok: true,
    config: {
      bot,
      commands: [],
      async startDelivery(options): Promise<NatsDelivery> {
        // Группа операторов проверяется здесь же, до поллера: группа без тем
        // или бот без права на них иначе всплыли бы только на первом
        // сообщении человека.
        const group = await checkOperatorGroup(bot.api, groupId);
        if (!group.ok) {
          options.logger.error(group.error);
          throw new Error(group.error);
        }
        // Переподключение без предела, как у доставки: рестарт NATS не должен
        // останавливать бота, а пара нужна на каждом сообщении.
        const nats: NatsConnection = await connect({
          ...natsConnectOptions(options.url),
          name: options.channel,
          maxReconnectAttempts: -1,
        });
        void watchBusStatus(nats.status(), {
          logger: options.logger,
          countFailure,
        }).catch(() => {});
        try {
          const store = await new Kvm(nats).open(
            supportTopicsBucket(options.channel),
          );
          // Bucket объявляет платформа (ADR-050): open его существования не
          // проверяет, и без этой проверки его отсутствие всплыло бы отказом
          // каждого сообщения, а не отказом старта.
          await store.status();
          pairs = createPairStore(store, groupId);
        } catch (cause) {
          await nats.close();
          throw cause;
        }
        let closing = false;
        const stop = async () => {
          closing = true;
          if (!nats.isClosed()) {
            await nats.drain().catch(() => nats.close());
          }
        };
        return {
          // Соединение закрылось не по остановке — процесс без пар молча
          // терял бы ответы операторов, поэтому общий процесс останавливается.
          done: nats.closed().then((cause) => {
            if (!closing) {
              throw cause ?? new Error("support bus connection closed");
            }
          }),
          stop,
          // Не бросает: закрытие идёт внутри общей остановки.
          close: () => stop().catch(() => {}),
        };
      },
      close() {
        identity.close();
      },
    },
  };
};
