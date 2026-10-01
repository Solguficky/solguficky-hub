import { isDeepStrictEqual } from "node:util";
import type { AuctionResult, AuctionUpdate } from "../gateway.js";
import type {
  AuctionBotPorts,
  LotView,
  ResolvedIdentity,
  TelegramUser,
} from "../ports.js";
import type { AuctionScreenBody } from "../screen.js";

// Ядро contract suite из ADR-044, «Проверка общего поведения». Оно чистое и от
// раннера не зависит: возвращает нарушения значением, поэтому самопроверка
// suite над заведомо неверной заглушкой — обычный тест, а не падение vitest
// внутри vitest.

// Нажатие, каким его видит приложение до разрешения личности: кто нажал и
// какую кнопку. Типов Telegram здесь нет — их разбирает приложение.
export type AuctionContractInput = {
  from: TelegramUser;
  input: AuctionUpdate["input"];
};

// Вход приложения, доведённый до `handleAuctionUpdate`: приложение получает
// порты-шпионы, связывает ими свою поверхность, само разрешает личность через
// порт Identity и отдаёт результат шлюза до того, как обернуть тело в свою
// оболочку.
export type AuctionContractApp = (
  ports: AuctionBotPorts,
) => (pressed: AuctionContractInput) => Promise<AuctionResult>;

export type PortCall =
  | { port: "identity"; method: "resolveIdentity"; request: TelegramUser }
  | {
      port: "auction";
      method: "getLot";
      request: Parameters<AuctionBotPorts["auction"]["getLot"]>[0];
    };

export type AuctionContractCase = {
  intent: string;
  callbackData: string;
  // Вызовы Auction по порядку. Identity сравнивается отдельно — числом
  // разрешений личности, одинаковым для всех намерений.
  auctionCalls: readonly PortCall[];
  body: AuctionScreenBody;
};

export type ContractViolation = {
  intent: string;
  kind:
    | "no-cases"
    | "not-a-screen"
    | "wrong-port-call"
    | "wrong-body"
    | "wrong-callback-data"
    | "identity-not-resolved-once";
  detail: string;
};

// Одна установленная личность и один снимок Auction для обеих фабрик. Роли
// пускают её на обе поверхности: `member` — в хаб, `public` — в бот аукциона.
export const CONTRACT_USER: TelegramUser = { telegramUserId: 424242 };

export const CONTRACT_IDENTITY: ResolvedIdentity = {
  identityId: "01929b7e-5c1d-7a3f-8e4b-000000000001",
  globalRoles: ["member", "public"],
  blocked: false,
};

export const CONTRACT_LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c",
  auctionId: "01929b7e-5c1d-7a3f-8e4b-0000000000a1",
  version: 3,
};

const VIEWER = {
  identityId: CONTRACT_IDENTITY.identityId,
  globalRoles: CONTRACT_IDENTITY.globalRoles,
};

// Таблица аукционных намерений. Строку добавляет лист, который вводит
// намерение, — вместе с юзкейсом.
export const AUCTION_CONTRACT_CASES: readonly AuctionContractCase[] = [
  {
    intent: "lot",
    callbackData: "v1:auc:lot:AZKbflwdej-OSy1snwobPA",
    auctionCalls: [
      {
        port: "auction",
        method: "getLot",
        request: { viewer: VIEWER, lotId: CONTRACT_LOT.lotId },
      },
    ],
    body: {
      blocks: [
        {
          kind: "lot",
          lotId: CONTRACT_LOT.lotId,
          auctionId: CONTRACT_LOT.auctionId,
          version: CONTRACT_LOT.version,
        },
      ],
      keyboard: [
        [
          {
            action: "lot.refresh",
            callbackData: "v1:auc:lot:AZKbflwdej-OSy1snwobPA",
          },
        ],
      ],
    },
  },
];

function spyPorts(calls: PortCall[]): AuctionBotPorts {
  return {
    identity: {
      async resolveIdentity(request) {
        calls.push({ port: "identity", method: "resolveIdentity", request });
        return CONTRACT_IDENTITY;
      },
    },
    auction: {
      async getLot(request) {
        calls.push({ port: "auction", method: "getLot", request });
        return CONTRACT_LOT;
      },
    },
  };
}

function callbackDataOf(body: AuctionScreenBody): string[] {
  return body.keyboard.flat().map((button) => button.callbackData);
}

export async function checkAuctionContractCase(
  createApp: AuctionContractApp,
  contractCase: AuctionContractCase,
): Promise<ContractViolation[]> {
  const calls: PortCall[] = [];
  const handle = createApp(spyPorts(calls));
  const result = await handle({
    from: CONTRACT_USER,
    input: { kind: "callback", data: contractCase.callbackData },
  });
  const violation = (
    kind: ContractViolation["kind"],
    detail: unknown,
  ): ContractViolation => ({
    intent: contractCase.intent,
    kind,
    detail: JSON.stringify(detail),
  });

  const violations: ContractViolation[] = [];
  // Личность разрешается ровно один раз на update: приложение — для своей
  // оболочки, а шлюз берёт тот же ответ из update и Identity не зовёт.
  const identityCalls = calls.filter((call) => call.port === "identity");
  if (identityCalls.length !== 1) {
    violations.push(
      violation("identity-not-resolved-once", { calls: identityCalls.length }),
    );
  }
  const auctionCalls = calls.filter((call) => call.port === "auction");
  if (!isDeepStrictEqual(auctionCalls, contractCase.auctionCalls)) {
    violations.push(
      violation("wrong-port-call", {
        expected: contractCase.auctionCalls,
        actual: auctionCalls,
      }),
    );
  }
  if (result.kind !== "screen") {
    violations.push(violation("not-a-screen", result));
    return violations;
  }
  const expectedButtons = callbackDataOf(contractCase.body);
  const actualButtons = callbackDataOf(result.body);
  if (!isDeepStrictEqual(actualButtons, expectedButtons)) {
    violations.push(
      violation("wrong-callback-data", {
        expected: expectedButtons,
        actual: actualButtons,
      }),
    );
  }
  if (!isDeepStrictEqual(result.body, contractCase.body)) {
    violations.push(
      violation("wrong-body", {
        expected: contractCase.body,
        actual: result.body,
      }),
    );
  }
  return violations;
}

// Пустая таблица — нарушение, а не зелёный прогон: suite без намерений не
// проверяет подключение ничем.
export async function checkAuctionContract(
  createApp: AuctionContractApp,
  cases: readonly AuctionContractCase[] = AUCTION_CONTRACT_CASES,
): Promise<ContractViolation[]> {
  if (cases.length === 0) {
    return [{ intent: "*", kind: "no-cases", detail: "intent table is empty" }];
  }
  const perCase = await Promise.all(
    cases.map((contractCase) =>
      checkAuctionContractCase(createApp, contractCase),
    ),
  );
  return perCase.flat();
}
