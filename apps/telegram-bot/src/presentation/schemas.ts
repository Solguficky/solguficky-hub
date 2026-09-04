import { z } from "zod";

export const TelegramDeepLinkPayloadSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/);

export const MeetupDeepLinkPayloadSchema = z
  .string()
  .regex(/^m_[A-Za-z0-9_-]{22}$/);

export type TelegramDeepLinkPayload = z.infer<
  typeof TelegramDeepLinkPayloadSchema
>;
export type MeetupDeepLinkPayload = z.infer<typeof MeetupDeepLinkPayloadSchema>;

const TelegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string(),
  username: z.string().optional(),
});

export const IncomingUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      date: z.number().int(),
      chat: z.object({
        id: z.number().int(),
        type: z.string(),
      }),
      from: TelegramUserSchema.optional(),
      text: z.string().optional(),
    })
    .optional(),
});

export type IncomingUpdate = z.infer<typeof IncomingUpdateSchema>;
