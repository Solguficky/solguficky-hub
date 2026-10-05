import { isDeepStrictEqual } from "node:util";
import { encodeAuctionCallback } from "../callback-data.js";
import { type AuctionSurface, requestedRole } from "../gateway.js";
import type {
  AuctionBotPorts,
  EntryPort,
  GlobalRole,
  RoleRequest,
  RoleRequestOutcome,
  TelegramUser,
} from "../ports.js";
import { AUCTION, CONTRACT_LOT, CONTRACT_USER, spyPorts } from "./check.js";

// Матрица доступа из ADR-044, «Проверка общего поведения», в редакции ADR-060.
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
  // Что Identity знает о человеке: роли и отметку отдаёт разрешение личности,
  // роли и исход — вход.
  person: {
    globalRoles: readonly GlobalRole[];
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
    // `/start` — один вход с кругом поверхности, остальное — одно разрешение.
    | "wrong-identity-calls"
    // До Auction дошёл человек, которого поверхность не пускает.
    | "auction-reached";
  detail: string;
};

const FIRST_NAME = "Сова";
const IDENTITY_ID = "01929b7e-5c1d-7a3f-8e4b-000000000009";

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

const holder = (...globalRoles: GlobalRole[]): Person => ({
  globalRoles,
  blocked: false,
  outcome: "already-held",
});
const NEWCOMER: Person = {
  globalRoles: [],
  blocked: false,
  outcome: "pending",
};
const BLOCKED: Person = { globalRoles: [], blocked: true, outcome: "blocked" };
const DECLINED: Person = {
  globalRoles: [],
  blocked: false,
  outcome: "declined",
};

// Строку добавляет лист, который меняет политику поверхности. До Auction
// доходят только `member` в хабе и человек с `public` в боте аукциона.
export const ACCESS_MATRIX_CASES: readonly AccessMatrixCase[] = [
  {
    name: "hub: member starts",
    surface: "hub",
    person: holder("member", "public"),
    action: START,
    answer: "admitted",
  },
  {
    name: "hub: member presses",
    surface: "hub",
    person: holder("member", "public"),
    action: LOT_BUTTON,
    answer: "admitted",
  },
  {
    name: "hub: allowlisted starts",
    surface: "hub",
    person: {
      globalRoles: ["member", "public"],
      blocked: false,
      outcome: "granted-by-allowlist",
    },
    action: START,
    answer: "admitted",
  },
  // Один `public` хаб не открывает: вход ставит заявку на `member`.
  {
    name: "hub: public only starts",
    surface: "hub",
    person: { globalRoles: ["public"], blocked: false, outcome: "pending" },
    action: START,
    answer: "pending",
  },
  {
    name: "hub: public only presses",
    surface: "hub",
    person: { globalRoles: ["public"], blocked: false, outcome: "pending" },
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
    person: {
      globalRoles: ["member", "public"],
      blocked: false,
      outcome: "unspecified",
    },
    action: START,
    answer: "unavailable",
  },
  {
    name: "auction: public starts",
    surface: "auction",
    person: holder("public"),
    action: START,
    answer: "admitted",
  },
  {
    name: "auction: public presses",
    surface: "auction",
    person: holder("public"),
    action: LOT_BUTTON,
    answer: "admitted",
  },
  {
    name: "auction: member starts",
    surface: "auction",
    person: holder("member", "public"),
    action: START,
    answer: "admitted",
  },
  {
    name: "auction: allowlisted starts",
    surface: "auction",
    person: {
      globalRoles: ["public"],
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
  // Отказ в `public` — блокировка (ADR-060, пункт 12), поэтому Identity этот
  // исход боту аукциона не отдаёт. Строка держит ответ на случай, если отдаст.
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
    person: { globalRoles: ["public"], blocked: false, outcome: "unspecified" },
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
        requestedRole: requestedRole(surface),
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
  const act = createApp({
    identity: {
      async resolveIdentity(request) {
        identityCalls.push({ method: "resolveIdentity", request });
        return {
          identityId: IDENTITY_ID,
          globalRoles: person.globalRoles,
          blocked: person.blocked,
        };
      },
    },
    entry: {
      async requestRole(request) {
        identityCalls.push({ method: "requestRole", request });
        return {
          identityId: IDENTITY_ID,
          globalRoles: person.globalRoles,
          outcome: person.outcome,
        };
      },
    },
    auction: spyPorts(auctionCalls, AUCTION).auction,
  });
  const violation = (
    kind: AccessViolation["kind"],
    detail: unknown,
  ): AccessViolation => ({
    case: matrixCase.name,
    kind,
    detail: JSON.stringify(detail),
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
  const expectedCalls = expectedIdentityCalls(matrixCase);
  if (!isDeepStrictEqual(identityCalls, expectedCalls)) {
    violations.push(
      violation("wrong-identity-calls", {
        expected: expectedCalls,
        actual: identityCalls,
      }),
    );
  }
  if (matrixCase.answer !== "admitted" && auctionCalls.length > 0) {
    violations.push(violation("auction-reached", auctionCalls));
  }
  if (answer === undefined) {
    violations.push(violation("app-threw", String(thrown)));
    return violations;
  }
  if (answer !== matrixCase.answer) {
    violations.push(
      violation("wrong-answer", {
        expected: matrixCase.answer,
        actual: answer,
      }),
    );
  }
  return violations;
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
