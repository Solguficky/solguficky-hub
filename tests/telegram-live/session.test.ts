import { describe, expect, it } from "../../apps/telegram-bot/testkit/index.js";
import {
  MissingSecretError,
  parseSecretsListing,
  pickLiveSecrets,
  secretKeys,
  syntheticLoginCode,
} from "./session.js";

const complete = {
  [secretKeys.apiId]: "12345",
  [secretKeys.apiHash]: "hash",
  [secretKeys.session]: "c2Vzc2lvbg==",
  [secretKeys.botUsername]: "@solguficky_test_bot",
};

describe("parseSecretsListing", () => {
  it("читает JSON между маркерами dotnet user-secrets", () => {
    const listing = `//BEGIN\n{\n  "${secretKeys.session}": "a=b=="\n}\n//END\n`;

    expect(parseSecretsListing(listing)).toEqual({
      [secretKeys.session]: "a=b==",
    });
  });

  it("падает без маркеров, не печатая вывод", () => {
    expect(() => parseSecretsListing("secret-value")).toThrow(/маркеров/);
    expect(() => parseSecretsListing("secret-value")).not.toThrow(
      /secret-value/,
    );
  });
});

describe("pickLiveSecrets", () => {
  it("собирает секреты и снимает @ с имени бота", () => {
    expect(pickLiveSecrets(complete)).toEqual({
      apiId: 12345,
      apiHash: "hash",
      session: "c2Vzc2lvbg==",
      botUsername: "solguficky_test_bot",
    });
  });

  it("называет отсутствующий ключ", () => {
    const { [secretKeys.session]: _, ...withoutSession } = complete;

    expect(() => pickLiveSecrets(withoutSession)).toThrow(MissingSecretError);
    expect(() => pickLiveSecrets(withoutSession)).toThrow(secretKeys.session);
  });

  it("отвергает нечисловой api_id", () => {
    expect(() =>
      pickLiveSecrets({ ...complete, [secretKeys.apiId]: "abc" }),
    ).toThrow(secretKeys.apiId);
  });
});

describe("syntheticLoginCode", () => {
  it("повторяет цифру дата-центра пять раз", () => {
    expect(syntheticLoginCode("9996621234")).toBe("22222");
  });

  it("отвергает номер вне тестовой среды", () => {
    expect(() => syntheticLoginCode("79991234567")).toThrow(/99966XYYYY/);
  });
});
