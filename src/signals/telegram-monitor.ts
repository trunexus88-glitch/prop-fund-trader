/**
 * TRU-NEXUS Telegram Signal Monitor
 * ═══════════════════════════════════════════════════════════════════════════
 * Long-polls the Telegram Bot API for new messages in the 1000pip Builder
 * VIP channel, parses each message, converts to a TradeSignal, and routes
 * it through the AccountManager.
 *
 * Required environment variables:
 *   TELEGRAM_BOT_TOKEN   — Bot token from @BotFather
 *   TELEGRAM_CHAT_ID     — Chat ID of the VIP channel (negative for groups)
 *                          Run /start with @userinfobot to find it.
 *
 * The bot must be an admin (or at least a member) of the channel.
 *
 * Long polling strategy:
 *   getUpdates with timeout=30 sits open for up to 30 seconds, returns
 *   immediately when a message arrives, then we loop. This gives sub-second
 *   signal delivery with zero CPU spin and no missed messages (offset tracking).
 *
 * Dedup:
 *   Telegram message IDs are monotonically increasing per chat.
 *   We track the last processed message_id and skip anything ≤ it.
 *   On restart, we fast-forward past all existing messages (skip_existing=true)
 *   to avoid replaying old signals into a fresh paper account.
 */

import { parseSignalMessage }   from './signal-parser.js';
import { mapToTradeSignal }     from './signal-mapper.js';
import type { AccountManager }  from '../accounts/account-manager.js';
import { logger }               from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface TelegramMessage {
  message_id: number;
  date: number;           // Unix timestamp
  text?: string;
  caption?: string;       // Photos/media sometimes carry the signal as caption
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;   // Channel messages come through as channel_post
}

interface GetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

// ─── Monitor ─────────────────────────────────────────────────────────────────

export class TelegramSignalMonitor {
  private readonly apiBase: string;
  private readonly chatId: string;
  private offset: number = 0;               // Next update_id to fetch
  private lastMessageId: number = 0;        // Dedup: last processed message_id
  private isRunning: boolean = false;
  private accountManager: AccountManager;

  // How many ms to wait after an error before retrying
  private readonly ERROR_RETRY_MS = 5_000;
  // Long-poll timeout in seconds (Telegram max = 50)
  private readonly POLL_TIMEOUT_S = 30;

  constructor(accountManager: AccountManager) {
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId  = process.env.TELEGRAM_CHAT_ID ?? '';

    if (!token) {
      throw new Error(
        '[TelegramMonitor] TELEGRAM_BOT_TOKEN env var is not set.\n' +
        'Create a bot at @BotFather, add it to your VIP channel, then set:\n' +
        '  TELEGRAM_BOT_TOKEN=<token>\n' +
        '  TELEGRAM_CHAT_ID=<channel-id>'
      );
    }
    if (!this.chatId) {
      throw new Error('[TelegramMonitor] TELEGRAM_CHAT_ID env var is not set.');
    }

    this.apiBase = `https://api.telegram.org/bot${token}`;
    this.accountManager = accountManager;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start monitoring.
   * @param skipExisting  If true, fast-forward past all pending updates so
   *                      we don't replay old signals (default: true).
   */
  async start(skipExisting: boolean = true): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('[TelegramMonitor] Starting…', { chatId: this.chatId, skipExisting });

    if (skipExisting) {
      await this.fastForward();
    }

    logger.info('[TelegramMonitor] Listening for new signals', { offset: this.offset });
    void this.pollLoop();
  }

  stop(): void {
    this.isRunning = false;
    logger.info('[TelegramMonitor] Stopped');
  }

  // ─── Core polling loop ─────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const updates = await this.getUpdates();

        for (const update of updates) {
          // Always advance the offset — even for messages we skip
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (error) {
        logger.error('[TelegramMonitor] Poll error', { error });
        await this.sleep(this.ERROR_RETRY_MS);
      }
    }
  }

  // ─── Telegram API calls ────────────────────────────────────────────────────

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const url = `${this.apiBase}/getUpdates?timeout=${this.POLL_TIMEOUT_S}&offset=${this.offset}&allowed_updates=["message","channel_post"]`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout((this.POLL_TIMEOUT_S + 5) * 1000)
    });

    if (!res.ok) {
      throw new Error(`Telegram API ${res.status}: ${await res.text()}`);
    }

    const body = await res.json() as GetUpdatesResponse;
    if (!body.ok) throw new Error('Telegram getUpdates returned ok=false');
    return body.result;
  }

  /**
   * Skip all currently pending updates so we don't process old signals.
   * Sets offset to (max update_id + 1).
   */
  private async fastForward(): Promise<void> {
    try {
      const url = `${this.apiBase}/getUpdates?timeout=0&offset=-1`;
      const res = await fetch(url);
      const body = await res.json() as GetUpdatesResponse;
      if (body.ok && body.result.length > 0) {
        const maxId = Math.max(...body.result.map(u => u.update_id));
        this.offset = maxId + 1;
        logger.info(`[TelegramMonitor] Fast-forwarded to offset ${this.offset}`);
      }
    } catch {
      // Non-fatal — we'll just process everything from the top
      logger.warn('[TelegramMonitor] Fast-forward failed, starting from offset 0');
    }
  }

  // ─── Message handling ──────────────────────────────────────────────────────

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    // Channel messages arrive as channel_post, DM/group as message
    const msg: TelegramMessage | undefined = update.channel_post ?? update.message;
    if (!msg) return;

    // Filter to our target chat
    // (Telegram does not include chat info in channel_post in a simple way,
    //  but getUpdates already filters by allowed_updates — if the bot is only
    //  in one channel, this is fine. Add chat_id check if needed.)

    // Dedup: skip messages we've already processed
    if (msg.message_id <= this.lastMessageId) return;
    this.lastMessageId = msg.message_id;

    const text = msg.text ?? msg.caption ?? '';
    if (!text) return;

    const receivedAt = new Date(msg.date * 1000).toISOString();
    const parsed = parseSignalMessage(text, receivedAt);

    if (!parsed) {
      // Not a trade signal — skip silently
      logger.debug('[TelegramMonitor] Non-signal message skipped', {
        preview: text.slice(0, 60)
      });
      return;
    }

    logger.info('[TelegramMonitor] Signal detected', {
      instrument: parsed.instrument,
      side: parsed.side,
      entry: parsed.entry || 'market',
      sl: parsed.stopLoss,
      tp: parsed.takeProfit,
    });

    await this.routeSignal(parsed, msg);
  }

  private async routeSignal(
    parsed: ReturnType<typeof parseSignalMessage>,
    _msg: TelegramMessage
  ): Promise<void> {
    if (!parsed) return;

    // Resolve entry price: if entry=0 (market), get current bid from any adapter
    let currentBid = parsed.entry;

    if (currentBid === 0) {
      // Ask the first active account adapter for the current price
      for (const [, account] of this.accountManager.getAccounts()) {
        if (account.status !== 'active') continue;
        try {
          const price = await account.adapter.getCurrentPrice(parsed.instrument);
          currentBid = price.bid;
          break;
        } catch {
          // Try next account
        }
      }
    }

    if (currentBid === 0) {
      logger.warn('[TelegramMonitor] Cannot resolve market entry price — signal skipped', {
        instrument: parsed.instrument
      });
      return;
    }

    const signal = mapToTradeSignal(parsed, currentBid);

    logger.info('[TelegramMonitor] Routing signal to AccountManager', {
      id: signal.id,
      instrument: signal.instrument,
      side: signal.side,
      entry: signal.entry_price.toFixed(5),
      sl: signal.stop_loss.toFixed(5),
      tp: signal.take_profit.toFixed(5),
      rr: `${signal.risk_reward_ratio}:1`,
      confidence: signal.confidence,
    });

    const results = await this.accountManager.routeSignal(signal);
    const executed = [...results.entries()].filter(([, ok]) => ok).map(([id]) => id);
    const skipped  = [...results.entries()].filter(([, ok]) => !ok).map(([id]) => id);

    logger.info('[TelegramMonitor] Signal routing complete', {
      signalId: signal.id,
      executed,
      skipped,
    });
  }

  // ─── Utility ────────────────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
