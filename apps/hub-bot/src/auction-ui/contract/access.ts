import { isDeepStrictEqual } from "node:util";
import { encodeAuctionCallback } from "../callback-data.js";
import { type AuctionSurface, applicationQueue } from "../gateway.js";
import type {
  AccessRight,
  AuctionBotPorts,
  EntryPort,
  RoleRequest,
  RoleRequestOutcome,
  TelegramUser,
} from "../ports.js";
import { AUCTION, CONTRACT_LOT, CONTRACT_USER, spyPorts } from "./check.js";

// Матрица доступа по правам (ADR-064, пункт 19), в редакции ADR-060.
// Как и ядро contract suite, она чистая: нарушения возвращаются значением.

export type AccessAction =
  // `sourceCode` — код канала из payload `s_<код>` без префикса.
  { kind: "start"; sourceCode?: string } | { kind: "callback"; data: string };

// Действие, каким его видит приложение до Identity: кто пришёл, с каким
// именем и что сделал. Типов Telegram здесь нет.
export type AccessMatrixInput = {
  from: TelegramUser;
  firstName: string;
  action: AccessAction;
};

// Что увидел человек. Приложение сводит к этому свой экран: матрица
// сравнивает ответы поверхностей, а не их тексты.
export type AccessAnswer =
  | "admitted"
  // «Заявка на рассмотрении».
  | "pending"
  | "declined"
  | "blocked"
  // «Ты в сообществе, аукцион у тебя в боте хаба» (ADR-064, пункт 2).
  | "in-community"
  // Сбой соседа: ни допуска, ни ответа о заявке.
  | "unavailable";

export type AccessMatrixPorts = AuctionBotPorts & { entry: EntryPort };

// Вход приложения целиком: от действия человека до ответа ему. Приложение
// получает порты-шпионы, само зовёт Identity и отдаёт то, что показало.
export type AccessMatrixApp = (
  ports: AccessMatrixPorts,
) => (input: AccessMatrixInput) => Promise<AccessAnswer>;

export type AccessMatrixCase = {
  name: string;
  surface: AuctionSurface["kind"];
  // Что Identity знает о человеке: права и отметку отдаёт разрешение личности,
  // права и исход — вход.
  person: {
    rights: readonly AccessRight[];
    blocked: boolean;
    outcome: RoleRequestOutcome;
  };
  action: AccessAction;
  answer: AccessAnswer;
};

export type AccessViolation = {
  case: string;
  kind:
    | "no-cases"
    | "app-threw"
    | "wrong-answer"
    // Identity спрошен не один раз, не тем вызовом или не о том человеке:
    // `/start` — один вход с очередью поверхности, остальное — одно разрешение.
    | "wrong-identity-calls"
    // До Auction дошёл человек, которого поверхность не пускает.
    | "auction-reached"
    // Допущенное нажатие до Auction не дошло.
    | "auction-not-reached";
  detail: string;
};

const FIRST_NAME = "Сова";
// Роли едут транзитом в Auction и в матрице ничего не решают.
const VIEWER = {
  identityId: "01929b7e-5c1d-7a3f-8e4b-000000000009",
  globalRoles: [],
} as const;

const LOT_BUTTON: AccessAction = {
  kind: "callback",
  data: encodeAuctionCallback({
    kind: "lot",
    lotId: CONTRACT_LOT.lotId,
    page: 0,
  }),
};
const START: AccessAction = { kind: "start" };
const START_FROM_CHANNEL: AccessAction = { kind: "start", sourceCode: "chat" };

type Person = AccessMatrixCase["person"];

const holder = (...rights: AccessRight[]): Person => ({
  rights,
  blocked: false,
  outcome: "already-held",
});
// Набор прав участника и администратора: матрице важны права, а не круг.
const MEMBER: Person = holder("hub", "auction");
const ADMIN: Person = holder(
  "hub",
  "auction",
  "manage-membership",
  "moderate-auction",
);
const NEWCOMER: Person = {
  rights: [],
  blocked: false,
  outcome: "pending",
};
const BLOCKED: Person = { rights: [], blocked: true, outcome: "blocked" };
const DECLINED: Person = {
  rights: [],
  blocked: false,
  outcome: "declined",
};

// Строку добавляет лист, который меняет политику поверхности. До Auction
// доходят только право хаба в хабе и право аукциона без права хаба в боте
// аукциона.
export const ACCESS_MATRIX_CASES: readonly AccessMatrixCase[] = [
  {
    name: "hub: hub right starts",
    surface: "hub",
    person: MEMBER,
    action: START,
    answer: "admitted",
  },
  {
    name: "hub: hub right presses",
    surface: "hub",
    person: MEMBER,
    action: LOT_BUTTON,
    answer: "admitted",
  },
  {
    name: "hub: allowlisted starts",
    surface: "hub",
    person: { ...MEMBER, outcome: "granted-by-allowlist" },
    action: START,
    answer: "admitted",
  },
  // Право аукциона хаб не открывает: вход ставит заявку на участника, и она
  // ложится в очередь сообщества (ADR-064, пункт 5).
  {
    name: "hub: auction right only starts",
    surface: "hub",
    person: { rights: ["auction"], blocked: false, outcome: "pending" },
    action: START_FROM_CHANNEL,
    answer: "pending",
  },
  {
    name: "hub: auction right only presses",
    surface: "hub",
    person: { rights: ["auction"], blocked: false, outcome: "pending" },
    action: LOT_BUTTON,
    answer: "pending",
  },
  // Повторный `/start` отвечает так же: Identity не различает заявку, которую
  // открыл этот вызов, и найденную открытой.
  {
    name: "hub: newcomer starts",
    surface: "hub",
    person: NEWCOMER,
    action: START_FROM_CHANNEL,
    answer: "pending",
  },
  {
    name: "hub: newcomer presses",
    surface: "hub",
    person: NEWCOMER,
    action: LOT_BUTTON,
    answer: "pending",
  },
  {
    name: "hub: declined starts",
    surface: "hub",
    person: DECLINED,
    action: START,
    answer: "declined",
  },
  // Разрешение личности исхода `declined` не несёт: на нажатии такой человек
  // неотличим от ожидающего.
  {
    name: "hub: declined presses",
    surface: "hub",
    person: DECLINED,
    action: LOT_BUTTON,
    answer: "pending",
  },
  {
    name: "hub: blocked starts",
    surface: "hub",
    person: BLOCKED,
    action: START,
    answer: "blocked",
  },
  {
    name: "hub: blocked presses",
    surface: "hub",
    person: BLOCKED,
    action: LOT_BUTTON,
    answer: "blocked",
  },
  {
    name: "hub: unknown outcome",
    surface: "hub",
    person: { ...MEMBER, outcome: "unspecified" },
    action: START,
    answer: "unavailable",
  },
  {
    name: "auction: auction right starts",
    surface: "auction",
    person: holder("auction"),
    action: START,
    answer: "admitted",
  },
  {
    name: "auction: auction right presses",
    surface: "auction",
    person: holder("auction"),
    action: LOT_BUTTON,
    answer: "admitted",
  },
  // Участнику и администратору бот аукциона отвечает только переходом в бот
  // хаба: торгов и списков нет, и подделанное нажатие до Auction не доходит
  // (ADR-064, пункт 2).
  {
    name: "auction: hub right starts",
    surface: "auction",
    person: MEMBER,
    action: START,
    answer: "in-community",
  },
  {
    name: "auction: hub right presses",
    surface: "auction",
    person: MEMBER,
    action: LOT_BUTTON,
    answer: "in-community",
  },
  {
    name: "auction: all rights start",
    surface: "auction",
    person: ADMIN,
    action: START,
    answer: "in-community",
  },
  {
    name: "auction: all rights press",
    surface: "auction",
    person: ADMIN,
    action: LOT_BUTTON,
    answer: "in-community",
  },
  // Право хаба без права аукциона Identity не отдаёт; строка держит, что
  // переход решает право хаба, а не пара прав.
  {
    name: "auction: hub right only starts",
    surface: "auction",
    person: { rights: ["hub"], blocked: false, outcome: "pending" },
    action: START,
    answer: "in-community",
  },
  {
    name: "auction: allowlisted starts",
    surface: "auction",
    person: {
      rights: ["auction"],
      blocked: false,
      outcome: "granted-by-allowlist",
    },
    action: START_FROM_CHANNEL,
    answer: "admitted",
  },
  {
    name: "auction: newcomer starts",
    surface: "auction",
    person: NEWCOMER,
    action: START_FROM_CHANNEL,
    answer: "pending",
  },
  {
    name: "auction: newcomer presses",
    surface: "auction",
    person: NEWCOMER,
    action: LOT_BUTTON,
    answer: "pending",
  },
  // Отказ по очереди аукциона — исход `declined` только этой очереди
  // (ADR-064, пункт 15).
  {
    name: "auction: declined starts",
    surface: "auction",
    person: DECLINED,
    action: START,
    answer: "declined",
  },
  {
    name: "auction: blocked starts",
    surface: "auction",
    person: BLOCKED,
    action: START,
    answer: "blocked",
  },
  {
    name: "auction: blocked presses",
    surface: "auction",
    person: BLOCKED,
    action: LOT_BUTTON,
    answer: "blocked",
  },
  {
    name: "auction: unknown outcome",
    surface: "auction",
    person: { rights: ["auction"], blocked: false, outcome: "unspecified" },
    action: START,
    answer: "unavailable",
  },
];

type IdentityCall =
  | { method: "resolveIdentity"; request: TelegramUser }
  | { method: "requestRole"; request: RoleRequest };

function expectedIdentityCalls(matrixCase: AccessMatrixCase): IdentityCall[] {
  const { action, surface } = matrixCase;
  if (action.kind === "callback") {
    return [{ method: "resolveIdentity", request: CONTRACT_USER }];
  }
  return [
    {
      method: "requestRole",
      request: {
        user: CONTRACT_USER,
        queue: applicationQueue(surface),
        ...(action.sourceCode === undefined
          ? {}
          : { sourceCode: action.sourceCode }),
        firstName: FIRST_NAME,
      },
    },
  ];
}

export async function checkAccessMatrixCase(
  createApp: AccessMatrixApp,
  matrixCase: AccessMatrixCase,
): Promise<AccessViolation[]> {
  const { person } = matrixCase;
  const identityCalls: IdentityCall[] = [];
  const auctionCalls: Parameters<typeof spyPorts>[0] = [];
  const spy = spyPorts(auctionCalls, AUCTION);
  const act = createApp({
    identity: {
      async resolveIdentity(request) {
        identityCalls.push({ method: "resolveIdentity", request });
        return {
          viewer: VIEWER,
          rights: person.rights,
          blocked: person.blocked,
        };
      },
    },
    entry: {
      async requestRole(request) {
        identityCalls.push({ method: "requestRole", request });
        return {
          viewer: VIEWER,
          rights: person.rights,
          outcome: person.outcome,
        };
      },
    },
    auction: spy.auction,
    operations: spy.operations,
  });
  const expectedCalls = expectedIdentityCalls(matrixCase);

  // Действие идёт дважды, и второй раз обязан пройти как первый: Identity
  // отвечает то же, значит и человек видит то же. Так строка держит и
  // повторный `/start` — он не даёт отказа там, где первый его не дал, — и
  // правило «один вызов Identity на update», а не на разговор.
  for (const attempt of [1, 2]) {
    identityCalls.length = 0;
    auctionCalls.length = 0;
    const violation = (
      kind: AccessViolation["kind"],
      detail: unknown,
    ): AccessViolation => ({
      case: matrixCase.name,
      kind,
      detail: JSON.stringify({ attempt, detail }),
    });
    let answer: AccessAnswer | undefined;
    let thrown: unknown;
    try {
      answer = await act({
        from: CONTRACT_USER,
        firstName: FIRST_NAME,
        action: matrixCase.action,
      });
    } catch (cause) {
      thrown = cause;
    }

    const violations: AccessViolation[] = [];
    if (!isDeepStrictEqual(identityCalls, expectedCalls)) {
      violations.push(
        violation("wrong-identity-calls", {
          expected: expectedCalls,
          actual: identityCalls,
        }),
      );
    }
    const admitted = matrixCase.answer === "admitted";
    if (!admitted && auctionCalls.length > 0) {
      violations.push(violation("auction-reached", auctionCalls));
    }
    // Допущенное нажатие обязано дойти до Auction: приложение, которое
    // отвечает «пустили» и ничего не читает, матрицу не проходит.
    if (
      admitted &&
      matrixCase.action.kind === "callback" &&
      auctionCalls.length === 0
    ) {
      violations.push(violation("auction-not-reached", matrixCase.action));
    }
    if (answer === undefined) {
      violations.push(violation("app-threw", String(thrown)));
    } else if (answer !== matrixCase.answer) {
      violations.push(
        violation("wrong-answer", {
          expected: matrixCase.answer,
          actual: answer,
        }),
      );
    }
    if (violations.length > 0) return violations;
  }
  return [];
}

// Пустой набор строк — нарушение, а не зелёный прогон: поверхность без строк
// матрицей не проверена.
export async function checkAccessMatrix(
  surface: AuctionSurface["kind"],
  createApp: AccessMatrixApp,
  cases: readonly AccessMatrixCase[] = ACCESS_MATRIX_CASES,
): Promise<AccessViolation[]> {
  const own = cases.filter((each) => each.surface === surface);
  if (own.length === 0) {
    return [{ case: "*", kind: "no-cases", detail: `no cases for ${surface}` }];
  }
  const perCase = await Promise.all(
    own.map((matrixCase) => checkAccessMatrixCase(createApp, matrixCase)),
  );
  return perCase.flat();
}
