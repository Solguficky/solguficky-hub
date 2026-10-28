import type { Client } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import type { Achievement } from "../../../gen/achievements/v1/achievements_pb.js";
import {
  IssueMethod,
  Recipients,
} from "../../../gen/achievements/v1/achievements_pb.js";
import { AchievementsService } from "../../../gen/achievements/v1/achievements_service_pb.js";
import type { AchievementsPort } from "../../auction-ui/index.js";
import type { RpcMetadata } from "../rpc-metadata.js";
import {
  callHeaders,
  callTimeoutMs,
  presentServiceToken,
} from "../rpc-metadata.js";
import type { Tracing } from "../tracing.js";
import { traceRpc } from "../tracing.js";

export type AchievementsRpc = Pick<
  Client<typeof AchievementsService>,
  "listMyAchievements" | "getEventAchievements" | "getAchievementImage"
>;

export function achievementsPort(
  rpc: AchievementsRpc,
  meta?: RpcMetadata,
): AchievementsPort {
  const options = (timeout = 3000) => ({
    ...callHeaders(meta),
    timeoutMs: callTimeoutMs(meta, timeout),
  });
  return {
    async listMine(identityId) {
      const result = await rpc.listMyAchievements({ identityId }, options());
      if (result.identityId !== identityId)
        throw new Error("achievements collection identity mismatch");
      return result.achievements.flatMap((row) => {
        if (row.grant === undefined || row.achievement === undefined)
          throw new Error("incomplete held achievement");
        const grant = row.grant;
        if (grant.identityId !== identityId)
          throw new Error("achievement holder identity mismatch");
        if (grant.event?.kind.case !== "auctionId") return [];
        if (grant.achievementCode !== row.achievement.code)
          throw new Error("achievement grant code mismatch");
        return [
          {
            grantId: grant.id,
            auctionId: grant.event.kind.value,
            grantedAt: grant.grantedAt,
            achievement: definition(row.achievement),
          },
        ];
      });
    },
    async getEvent(auctionId) {
      const result = await rpc.getEventAchievements(
        { event: { kind: { case: "auctionId", value: auctionId } } },
        options(),
      );
      if (
        result.event?.kind.case !== "auctionId" ||
        result.event.kind.value !== auctionId
      )
        throw new Error("achievement event mismatch");
      return result.achievements.map((row) => {
        if (row.achievement === undefined)
          throw new Error("incomplete event achievement");
        return {
          achievement: definition(row.achievement),
          holderIds: row.holderIdentityIds,
          erasedHolders: row.erasedHolders,
        };
      });
    },
    async getImage(code) {
      const image = await rpc.getAchievementImage(
        { achievementCode: code },
        options(10000),
      );
      return {
        content: image.content,
        mediaType: image.mediaType,
        version: image.version,
      };
    },
  };
}

function definition(value: Achievement) {
  return {
    code: value.code,
    title: value.title,
    description: value.description,
    recipients:
      value.recipients === Recipients.ONE
        ? ("one" as const)
        : ("many" as const),
    manual: value.issueMethod === IssueMethod.MANUAL,
    ...(value.image === undefined ? {} : { imageVersion: value.image.version }),
  };
}

export function createAchievementsClient(
  url: string,
  options: {
    serviceToken: string;
    tracing: Tracing;
    onFailure?: (cause: unknown, meta?: RpcMetadata) => void;
  },
) {
  const session = new Http2SessionManager(url);
  const rpc = createClient(
    AchievementsService,
    createGrpcTransport({
      baseUrl: url,
      sessionManager: session,
      interceptors: [
        presentServiceToken(options.serviceToken),
        traceRpc(options.tracing),
      ],
    }),
  );
  return {
    port: (meta?: RpcMetadata): AchievementsPort => ({
      ...achievementsPort(rpc, meta),
      reportFailure: (cause) => options.onFailure?.(cause, meta),
    }),
    close: () => session.abort(),
  };
}
