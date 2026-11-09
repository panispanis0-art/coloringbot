import type { Context } from 'telegraf';
import { config } from './config.ts';

/**
 * A status line that only appears when work is slow: nothing is sent if everything finishes within
 * config.progressDelayMs; otherwise one message shows the current step, is edited in place, and is
 * deleted when done.
 */
export class Progress {
  private text: string;
  private msg?: { chat: { id: number }; message_id: number };
  private timer?: NodeJS.Timeout;
  private sending?: Promise<void>;
  private closed = false;

  constructor(
    private ctx: Context,
    first: string,
  ) {
    this.text = first;
    this.timer = setTimeout(() => this.show(), config.progressDelayMs);
  }

  private show() {
    if (this.closed || this.msg || this.sending) return;
    this.sending = this.ctx
      .reply(this.text)
      .then((m) => {
        this.msg = m;
      })
      .catch(() => {});
  }

  /** Move to the next step. */
  async step(text: string) {
    if (this.closed || text === this.text) return;
    this.text = text;
    if (this.sending) await this.sending;
    if (this.msg) await this.ctx.telegram.editMessageText(this.msg.chat.id, this.msg.message_id, undefined, text).catch(() => {});
  }

  /** Remove the status line (if it was ever shown). */
  async done() {
    this.closed = true;
    clearTimeout(this.timer);
    if (this.sending) await this.sending;
    if (this.msg) await this.ctx.telegram.deleteMessage(this.msg.chat.id, this.msg.message_id).catch(() => {});
  }
}

/** React to the user's message with an emoji (👀 received, 👍 done, 😢 failed). Silent if not supported. */
export async function react(ctx: Context, emoji: '👀' | '👍' | '😢', messageId?: number) {
  const id = messageId ?? (ctx.message as { message_id?: number } | undefined)?.message_id;
  if (!id || !ctx.chat) return;
  await ctx.telegram
    .callApi('setMessageReaction' as never, { chat_id: ctx.chat.id, message_id: id, reaction: [{ type: 'emoji', emoji }] } as never)
    .catch(() => {});
}
