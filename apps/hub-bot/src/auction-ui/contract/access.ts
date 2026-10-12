import { isDeepStrictEqual } from "node:util";
import { encodeAuctionCallback } from "../callback-data.js";
import { type AuctionSurface, applicationQueue } from "../gateway.js";
import type {
  AccessRequest,
  AccessRequestOutcome,
  AccessRight,
  AuctionBotPorts,
  EntryPort,
  TelegramUser,
} from "../ports.js";
import { AUCTION, CONTRACT_LOT, CONTRACT_USER, spyPorts } from "./check.js";

// Матрица доступа по правам (ADR-064, пункт 19), в редакции ADR-060.
// Как и ядро contract suite, она чистая: нарушения возвращаются значением.

export type AccessAction =
  // `sourceCode` — код канала из payload `s_<код>` без префикса.
  | { kind: "start"; sourceCode?: string }
  | { kind: "callback"; data: string }
  // «Подать заявку» под приветствием (PER-592, дополнение ADR-060): код
  // канала едет в кнопке, и приложение само кладёт его в свои данные.
  | { kind: "apply"; sourceCode?: string };

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
  // Приветствие с кнопкой «Подать заявку»: права нет, а есть ли заявка,
  // разрешение личности не знает (PER-592).
  | "welcome"
  // «Заявка на рассмотрении».
  | "pending"
  | "declined"
  | "blocked"
  // «Ты уже участник сообщества солегуфиков. Аукционы для тебя — в основном боте сообщества: открой сходку и нажми „🧩 Расширения“» (ADR-064, пункт 2; PER-605).
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
  // права и исход — заявка.
  person: {
    rights: readonly AccessRight[];
    blocked: boolean;
    outcome: AccessRequestOutcome;
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
    // «Подать заявку» — одна заявка с очередью поверхности, остальное, и
    // `/start` тоже, — одно разрешение.
    | "wrong-identity-calls"
    // До Auction дошёл человек, которого поверхность не пускает.
    | "auction-reached"
    // Допущенное нажатие до Auction не дошло.
    | "auction-not-reached";
  detail: string;
};

const FIRST_NAME = "Сова";
const VIEWER_ID = "01929b7e-5c1d-7a3f-8e4b-000000000009";

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
const APPLY: AccessAction = { kind: "apply" };
const APPLY_FROM_CHANNEL: AccessAction = { kind: "apply", sourceCode: "chat" };

type Person = AccessMatrixCase["person"];

const holder = (...rights: AccessRight[]): Person => ({
  rights,
  blocked: false,
  outcome: "already-held",
});
// Набор прав участника и администратора: матрице важны права, а не круг.
const MEMBER: Person = holder("access-hub", "place-bids");
const ADMIN: Person = holder(
  "access-hub",
  "place-bids",
  "manage-members",
  "admit-bidders",
  "manage-meetups",
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
const AUCTION_ONLY: Person = {
  rights: ["place-bids"],
  blocked: false,
  outcome: "pending",
};

// Строку добавляет лист, который меняет политику поверхности. До Auction
// доходят только право хаба в хабе и право аукциона без права хаба в боте
// аукциона. `/start` заявку не ставит (PER-592, дополнение ADR-060): без права
// он отвечает приветствием, и только «Подать заявку» зовёт заявку — её исход
// и видит человек.
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
  // Белый список, сработавший между приветствием и нажатием, пускает сразу.
  {
    name: "hub: allowlisted applies",
    surface: "hub",
    person: { ...MEMBER, outcome: "granted-by-allowlist" },
    action: APPLY,
    answer: "admitted",
  },
  // Право аукциона хаб не открывает: заявка — на участника, и она ложится в
  // очередь сообщества (ADR-064, пункт 5).
  {
    name: "hub: auction right only starts",
    surface: "hub",
    person: AUCTION_ONLY,
    action: START_FROM_CHANNEL,
    answer: "welcome",
  },
  {
    name: "hub: auction right only presses",
    surface: "hub",
    person: AUCTION_ONLY,
    action: LOT_BUTTON,
    answer: "welcome",
  },
  {
    name: "hub: auction right only applies",
    surface: "hub",
    person: AUCTION_ONLY,
    action: APPLY_FROM_CHANNEL,
    answer: "pending",
  },
  {
    name: "hub: newcomer starts",
    surface: "hub",
    person: NEWCOMER,
    action: START_FROM_CHANNEL,
    answer: "welcome",
  },
  {
    name: "hub: newcomer presses",
    surface: "hub",
    person: NEWCOMER,
    action: LOT_BUTTON,
    answer: "welcome",
  },
  // Повторное нажатие отвечает так же: Identity не различает заявку, которую
  // открыл этот вызов, и найденную открытой.
  {
    name: "hub: newcomer applies",
    surface: "hub",
    person: NEWCOMER,
    action: APPLY_FROM_CHANNEL,
    answer: "pending",
  },
  // Разрешение личности исхода `declined` не несёт: на `/start` и нажатии
  // такой человек неотличим от нового, а отказ видит, нажав «Подать заявку».
  {
    name: "hub: declined starts",
    surface: "hub",
    person: DECLINED,
    action: START,
    answer: "welcome",
  },
  {
    name: "hub: declined presses",
    surface: "hub",
    person: DECLINED,
    action: LOT_BUTTON,
    answer: "welcome",
  },
  {
    name: "hub: declined applies",
    surface: "hub",
    person: DECLINED,
    action: APPLY,
    answer: "declined",
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
    name: "hub: blocked applies",
    surface: "hub",
    person: BLOCKED,
    action: APPLY,
    answer: "blocked",
  },
  {
    name: "hub: unknown outcome",
    surface: "hub",
    person: { ...MEMBER, outcome: "unspecified" },
    action: APPLY,
    answer: "unavailable",
  },
  {
    name: "auction: auction right starts",
    surface: "auction",
    person: holder("place-bids"),
    action: START,
    answer: "admitted",
  },
  {
    name: "auction: auction right presses",
    surface: "auction",
    person: holder("place-bids"),
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
    name: "auction: hub right applies",
    surface: "auction",
    person: MEMBER,
    action: APPLY,
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
    person: { rights: ["access-hub"], blocked: false, outcome: "pending" },
    action: START,
    answer: "in-community",
  },
  {
    name: "auction: allowlisted applies",
    surface: "auction",
    person: {
      rights: ["place-bids"],
      blocked: false,
      outcome: "granted-by-allowlist",
    },
    action: APPLY_FROM_CHANNEL,
    answer: "admitted",
  },
  {
    name: "auction: newcomer starts",
    surface: "auction",
    person: NEWCOMER,
    action: START_FROM_CHANNEL,
    answer: "welcome",
  },
  {
    name: "auction: newcomer presses",
    surface: "auction",
    person: NEWCOMER,
    action: LOT_BUTTON,
    answer: "welcome",
  },
  {
    name: "auction: newcomer applies",
    surface: "auction",
    person: NEWCOMER,
    action: APPLY_FROM_CHANNEL,
    answer: "pending",
  },
  // Отказ по очереди аукциона — исход `declined` только этой очереди
  // (ADR-064, пункт 15); виден он после «Подать заявку».
  {
    name: "auction: declined starts",
    surface: "auction",
    person: DECLINED,
    action: START,
    answer: "welcome",
  },
  {
    name: "auction: declined applies",
    surface: "auction",
    person: DECLINED,
    action: APPLY,
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
    name: "auction: blocked applies",
    surface: "auction",
    person: BLOCKED,
    action: APPLY,
    answer: "blocked",
  },
  {
    name: "auction: unknown outcome",
    surface: "auction",
    person: { rights: ["place-bids"], blocked: false, outcome: "unspecified" },
    action: APPLY,
    answer: "unavailable",
  },
];

type IdentityCall =
  | { method: "resolveIdentity"; request: TelegramUser }
  | { method: "requestAccess"; request: AccessRequest };

function expectedIdentityCalls(matrixCase: AccessMatrixCase): IdentityCall[] {
  const { action, surface } = matrixCase;
  if (action.kind !== "apply") {
    return [{ method: "resolveIdentity", request: CONTRACT_USER }];
  }
  return [
    {
      method: "requestAccess",
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
          viewer: { identityId: VIEWER_ID, rights: person.rights },
          blocked: person.blocked,
        };
      },
    },
    entry: {
      async requestAccess(request) {
        identityCalls.push({ method: "requestAccess", request });
        return {
          viewer: { identityId: VIEWER_ID, rights: person.rights },
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
  // повторную заявку — она не даёт отказа там, где первая его не дала, — и
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
