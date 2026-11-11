import { answerQuery, markDecision, reply, send } from "../replies";
import {
  ALREADY_USER,
  ALREADY_USER_MARK,
  APPROVE_BUTTON,
  APPROVED,
  APPROVED_MARK,
  createFailed,
  NOT_OWNER,
  REJECT_BUTTON,
  REJECTED,
  REJECTED_MARK,
  REQUEST_PENDING,
  REQUEST_SENT,
  requestText,
  WELCOME_BACK,
} from "../texts";
import { PENDING_TTL_SECONDS, pendingKey, rejectedKey, type CallbackQuery, type Deps, type User } from "../types";

export async function start(chatId: number, user: User, deps: Deps): Promise<void> {
  if (await deps.github.userExists(user.id)) {
    return reply(chatId, WELCOME_BACK, deps);
  }
  if ((await deps.kv.get(rejectedKey(user.id))) !== null) {
    return reply(chatId, REJECTED, deps);
  }
  if ((await deps.kv.get(pendingKey(user.id))) !== null) {
    return reply(chatId, REQUEST_PENDING, deps);
  }
  await send(
    deps.ownerId,
    {
      text: requestText(user),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: APPROVE_BUTTON, callback_data: `approve:${user.id}` },
            { text: REJECT_BUTTON, callback_data: `reject:${user.id}` },
          ],
        ],
      },
    },
    deps,
  );
  await deps.kv.put(pendingKey(user.id), "1", { expirationTtl: PENDING_TTL_SECONDS });
  await reply(chatId, REQUEST_SENT, deps);
}

export async function decide(query: CallbackQuery, approve: boolean, userId: number, deps: Deps): Promise<void> {
  if (query.from.id !== deps.ownerId) {
    return answerQuery(query, deps, NOT_OWNER);
  }
  if (!approve) {
    await deps.kv.put(rejectedKey(userId), "1");
    await deps.kv.delete(pendingKey(userId));
    await answerQuery(query, deps);
    await markDecision(query, REJECTED_MARK, deps);
    await reply(userId, REJECTED, deps);
    return;
  }
  let result: "created" | "exists";
  try {
    result = await deps.github.createUser(userId);
  } catch (error) {
    await answerQuery(query, deps);
    await reply(deps.ownerId, createFailed(userId, error), deps);
    return;
  }
  await deps.kv.delete(pendingKey(userId));
  await deps.kv.delete(rejectedKey(userId));
  if (result === "exists") {
    await answerQuery(query, deps, ALREADY_USER);
    await markDecision(query, ALREADY_USER_MARK, deps);
    return;
  }
  await answerQuery(query, deps);
  await markDecision(query, APPROVED_MARK, deps);
  await reply(userId, APPROVED, deps);
}
