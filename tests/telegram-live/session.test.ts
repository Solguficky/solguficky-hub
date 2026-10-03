import { describe, expect, it } from "../../apps/hub-bot/testkit/index.js";
import {
  parseSecretsListing,
  pickLiveSecrets,
  pickMeetupPayloads,
  SecretError,
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

  it("не цитирует секрет из неразобранного JSON", () => {
    const listing = '//BEGIN\n{ "k": secret-value }\n//END';

    expect(() => parseSecretsListing(listing)).toThrow(/не разбирается/);
    expect(() => parseSecretsListing(listing)).not.toThrow(/secret-value/);
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

    expect(() => pickLiveSecrets(withoutSession)).toThrow(SecretError);
    expect(() => pickLiveSecrets(withoutSession)).toThrow(secretKeys.session);
  });

  it("отвергает нечисловой api_id", () => {
    expect(() =>
      pickLiveSecrets({ ...complete, [secretKeys.apiId]: "abc" }),
    ).toThrow(secretKeys.apiId);
  });
});

describe("pickMeetupPayloads", () => {
  const token = "AAECAwQFBgcICQoLDA0ODw";

  it("берёт payload из ссылки для чата и из голого payload", () => {
    expect(
      pickMeetupPayloads({
        [secretKeys.publishedMeetup]: `https://t.me/solguficky_test_bot?start=m_${token}`,
        [secretKeys.hiddenMeetup]: ` m_${token}
`,
      }),
    ).toEqual({ published: `m_${token}`, hidden: `m_${token}` });
  });

  it("отвергает сырой UUID: бот принял бы его за чистый /start", () => {
    expect(() =>
      pickMeetupPayloads({
        [secretKeys.publishedMeetup]: `m_${token}`,
        [secretKeys.hiddenMeetup]: "m_00010203-0405-0607-0809-0a0b0c0d0e0f",
      }),
    ).toThrow(secretKeys.hiddenMeetup);
  });

  it("называет отсутствующую сходку", () => {
    expect(() =>
      pickMeetupPayloads({ [secretKeys.hiddenMeetup]: `m_${token}` }),
    ).toThrow(secretKeys.publishedMeetup);
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
