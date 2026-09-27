import { MtTimeoutError, TransportError, tl } from "@mtcute/node";
import { describe, expect, it } from "../../apps/telegram-bot/testkit/index.js";
import { classifyFailure, TelegramLiveFailure } from "./failure.js";
import { MissingSecretError } from "./session.js";

// Классификатор проверяется на настоящих объектах ошибок mtcute: живой прогон
// редок, и разобранная не так ошибка иначе всплыла бы только у владельца.

function rpcError(code: number, message: string): tl.RpcError {
  return tl.RpcError.fromTl({
    _: "error",
    errorCode: code,
    errorMessage: message,
  });
}

describe("classifyFailure", () => {
  it("называет флуд-лимит и срок ожидания", () => {
    const failure = classifyFailure(rpcError(420, "FLOOD_WAIT_37"));

    expect(failure.kind).toBe("flood-wait");
    expect(failure.message).toContain("37 с");
  });

  it("отличает отозванную сессию", () => {
    expect(classifyFailure(rpcError(401, "AUTH_KEY_UNREGISTERED")).kind).toBe(
      "session-invalid",
    );
    expect(classifyFailure(rpcError(401, "SESSION_REVOKED")).kind).toBe(
      "session-invalid",
    );
  });

  it("считает транспортный отказ недоступностью Telegram", () => {
    expect(classifyFailure(new TransportError(404)).kind).toBe(
      "telegram-unreachable",
    );
  });

  it("находит сетевой код в цепочке причин", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });

    expect(classifyFailure(new Error("wrapped", { cause: refused })).kind).toBe(
      "telegram-unreachable",
    );
  });

  it("считает таймаут запроса недоступностью Telegram", () => {
    expect(classifyFailure(new MtTimeoutError(5000)).kind).toBe(
      "telegram-unreachable",
    );
  });

  it("передаёт отсутствующий секрет с именем ключа", () => {
    const failure = classifyFailure(
      new MissingSecretError("TelegramLive:Session"),
    );

    expect(failure.kind).toBe("missing-secret");
    expect(failure.message).toContain("TelegramLive:Session");
  });

  it("не переклассифицирует уже названный отказ", () => {
    const named = new TelegramLiveFailure("bot-no-reply", "молчит");

    expect(classifyFailure(named)).toBe(named);
  });

  it("не теряет неизвестную ошибку RPC", () => {
    const failure = classifyFailure(rpcError(400, "PEER_ID_INVALID"));

    expect(failure.kind).toBe("unknown");
    expect(failure.message).toContain("PEER_ID_INVALID");
  });
});
