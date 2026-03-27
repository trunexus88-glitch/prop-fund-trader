/**
 * TRU-NEXUS Session Manager
 * ═══════════════════════════════════════════════════════════════════════════
 * Handles market hours, news blackout windows, weekend position rules,
 * and minimum trading day requirements per firm profile.
 */

import type { FirmProfile } from './types.js';
import { eventBus } from '../utils/event-bus.js';
import { riskLogger } from '../utils/logger.js';

export interface SessionState {
  is_trading_allowed: boolean;
  is_news_blackout: boolean;
  is_weekend: boolean;
  current_session: string;               // 'asian' | 'london' | 'newyork' | 'closed'
  next_session_open: string;
  blackout_until: string | null;
  trading_days_completed: number;
  min_trading_days_required: number;
  days_remaining_in_eval: number | null;
}

interface NewsEvent {
  time: string;        // ISO timestamp
  currency: string;
  impact: 'high' | 'medium' | 'low';
  title: string;
}

export class SessionManager {
  private newsBlackoutMins: number;
  private weekendHolding: boolean;
  private minTradingDays: number;
  private maxTradingDays: number | null;
  private tradingDaysCompleted: number = 0;
  private evalStartDate: Date;
  private newsCalendar: NewsEvent[] = [];
  private dailyResetUtc: string;

  // Forex market sessions (UTC)
  private readonly SESSIONS = {
    asian:    { open: 0,  close: 9 },   // 00:00 - 09:00 UTC
    london:   { open: 7,  close: 16 },  // 07:00 - 16:00 UTC  
    newyork:  { open: 13, close: 22 },  // 13:00 - 22:00 UTC
  };

  constructor(profile: FirmProfile) {
    this.newsBlackoutMins = profile.news_blackout_mins;
    this.weekendHolding = profile.weekend_holding;
    this.minTradingDays = profile.min_trading_days;
    this.maxTradingDays = profile.max_trading_days;
    this.dailyResetUtc = profile.daily_reset_utc;
    this.evalStartDate = new Date();

    riskLogger.info('Session manager initialized', {
      newsBlackoutMins: this.newsBlackoutMins,
      weekendHolding: this.weekendHolding,
      minTradingDays: this.minTradingDays,
      maxTradingDays: this.maxTradingDays
    });
  }

  /**
   * Load news calendar events for blackout enforcement.
   */
  setNewsCalendar(events: NewsEvent[]): void {
    this.newsCalendar = events.filter(e => e.impact === 'high');
    riskLogger.info(`Loaded ${this.newsCalendar.length} high-impact news events`);
  }

  /**
   * Check if trading is currently allowed.
   */
  isTradingAllowed(): boolean {
    const now = new Date();
    
    // Weekend check (Friday 22:00 UTC to Sunday 22:00 UTC)
    if (this.isWeekend(now)) {
      return false;
    }

    // News blackout check
    if (this.isInNewsBlackout(now)) {
      return false;
    }

    return true;
  }

  /**
   * Check if we're currently in a weekend market closure.
   */
  isWeekend(now: Date = new Date()): boolean {
    const day = now.getUTCDay();
    const hour = now.getUTCHours();

    // Saturday (6) or Sunday (0) except Sunday after 22:00
    if (day === 6) return true;
    if (day === 0 && hour < 22) return true;
    if (day === 5 && hour >= 22) return true; // Friday after 22:00

    return false;
  }

  /**
   * Check if we're in a news blackout window.
   */
  isInNewsBlackout(now: Date = new Date()): boolean {
    if (this.newsBlackoutMins === 0) return false;

    const blackoutMs = this.newsBlackoutMins * 60 * 1000;

    for (const event of this.newsCalendar) {
      const eventTime = new Date(event.time).getTime();
      const windowStart = eventTime - blackoutMs;
      const windowEnd = eventTime + blackoutMs;
      const currentTime = now.getTime();

      if (currentTime >= windowStart && currentTime <= windowEnd) {
        eventBus.emitEngine({
          type: 'SESSION_BLACKOUT',
          reason: `News blackout: ${event.title} (${event.currency})`,
          until: new Date(windowEnd).toISOString()
        });
        return true;
      }
    }

    return false;
  }

  /**
   * Get the current trading session name.
   */
  getCurrentSession(now: Date = new Date()): string {
    if (this.isWeekend(now)) return 'closed';

    const hour = now.getUTCHours();

    // Check overlapping sessions
    const sessions: string[] = [];
    if (hour >= this.SESSIONS.newyork.open && hour < this.SESSIONS.newyork.close) {
      sessions.push('newyork');
    }
    if (hour >= this.SESSIONS.london.open && hour < this.SESSIONS.london.close) {
      sessions.push('london');
    }
    if (hour >= this.SESSIONS.asian.open && hour < this.SESSIONS.asian.close) {
      sessions.push('asian');
    }

    return sessions.length > 0 ? sessions.join('+') : 'inter-session';
  }

  /**
   * Increment the trading days counter.
   */
  recordTradingDay(): void {
    this.tradingDaysCompleted++;
    riskLogger.info('Trading day recorded', {
      completed: this.tradingDaysCompleted,
      required: this.minTradingDays
    });
  }

  /**
   * Check if minimum trading days requirement is met.
   */
  hasMetMinTradingDays(): boolean {
    return this.tradingDaysCompleted >= this.minTradingDays;
  }

  /**
   * Check if positions need to be closed before weekend.
   */
  shouldCloseForWeekend(now: Date = new Date()): boolean {
    if (this.weekendHolding) return false;

    const day = now.getUTCDay();
    const hour = now.getUTCHours();

    // Close positions on Friday after 21:00 UTC (1 hour before market close)
    return day === 5 && hour >= 21;
  }

  /**
   * Get the full session state snapshot.
   */
  getState(now: Date = new Date()): SessionState {
    const daysRemaining = this.maxTradingDays !== null
      ? Math.max(0, this.maxTradingDays - Math.floor(
          (now.getTime() - this.evalStartDate.getTime()) / (1000 * 60 * 60 * 24)
        ))
      : null;

    return {
      is_trading_allowed: this.isTradingAllowed(),
      is_news_blackout: this.isInNewsBlackout(now),
      is_weekend: this.isWeekend(now),
      current_session: this.getCurrentSession(now),
      next_session_open: this.getNextSessionOpen(now),
      blackout_until: null, // Populated by isInNewsBlackout
      trading_days_completed: this.tradingDaysCompleted,
      min_trading_days_required: this.minTradingDays,
      days_remaining_in_eval: daysRemaining
    };
  }

  /**
   * Get the daily reset time as a Date for the current or next day.
   */
  getDailyResetTime(now: Date = new Date()): Date {
    const [hours, minutes] = this.dailyResetUtc.split(':').map(Number);
    const resetTime = new Date(now);
    resetTime.setUTCHours(hours, minutes, 0, 0);

    if (resetTime <= now) {
      resetTime.setUTCDate(resetTime.getUTCDate() + 1);
    }

    return resetTime;
  }

  private getNextSessionOpen(now: Date): string {
    // Simple implementation — returns next major session open
    const hour = now.getUTCHours();
    
    if (this.isWeekend(now)) {
      const sunday = new Date(now);
      while (sunday.getUTCDay() !== 0) {
        sunday.setUTCDate(sunday.getUTCDate() + 1);
      }
      sunday.setUTCHours(22, 0, 0, 0);
      return sunday.toISOString();
    }

    if (hour < 7) {
      const nextLondon = new Date(now);
      nextLondon.setUTCHours(7, 0, 0, 0);
      return nextLondon.toISOString();
    }

    if (hour < 13) {
      const nextNY = new Date(now);
      nextNY.setUTCHours(13, 0, 0, 0);
      return nextNY.toISOString();
    }

    // Next Asian session (next day 00:00)
    const nextAsian = new Date(now);
    nextAsian.setUTCDate(nextAsian.getUTCDate() + 1);
    nextAsian.setUTCHours(0, 0, 0, 0);
    return nextAsian.toISOString();
  }
}
