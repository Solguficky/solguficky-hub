import type { Api } from "grammy";

export type GroupCheck = { ok: true } | { ok: false; error: string };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Группа операторов годится боту поддержки: супергруппа с темами, где бот —
 * создатель или администратор с правом управлять темами (ADR-068, п. 4).
 * Без этого каждое первое сообщение человека получало бы «не дошло», поэтому
 * процесс проверяет группу до поллера и отказывает старту с причиной.
 */
export async function checkOperatorGroup(
  api: Pick<Api, "getMe" | "getChat" | "getChatMember">,
  groupId: number,
): Promise<GroupCheck> {
  try {
    const chat = await api.getChat(groupId);
    if (chat.type !== "supergroup" || chat.is_forum !== true) {
      return {
        ok: false,
        error: "BOT_SUPPORT_GROUP_ID is not a supergroup with topics enabled",
      };
    }
    const me = await api.getMe();
    const member = await api.getChatMember(groupId, me.id);
    const manages =
      member.status === "creator" ||
      (member.status === "administrator" && member.can_manage_topics === true);
    if (!manages) {
      return {
        ok: false,
        error:
          "support bot is not an administrator allowed to manage topics in BOT_SUPPORT_GROUP_ID",
      };
    }
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error: `BOT_SUPPORT_GROUP_ID is unavailable to the support bot: ${messageOf(cause)}`,
    };
  }
}
