/**
 * TRU-NEXUS Firm Profile Schema & Loader
 * Loads prop firm configurations from JSON profiles.
 */

import { z } from 'zod';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { FirmProfile } from '../engine/types.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Zod schema for validation
export const FirmProfileSchema = z.object({
  firm_id: z.string(),
  firm_name: z.string(),
  account_size: z.number().positive(),
  max_drawdown_pct: z.number().min(0).max(1),
  drawdown_model: z.enum(['static', 'trailing_eod', 'trailing_realtime']),
  daily_loss_pct: z.number().min(0).max(1).nullable(),
  daily_loss_basis: z.enum(['initial_balance', 'current_balance', 'equity_at_reset']),
  daily_reset_utc: z.string().regex(/^\d{2}:\d{2}$/),
  profit_target_pct: z.number().min(0).max(1),
  min_trading_days: z.number().int().min(0),
  max_trading_days: z.number().int().positive().nullable(),
  consistency_rule_pct: z.number().min(0).max(1).nullable(),
  news_blackout_mins: z.number().int().min(0),
  weekend_holding: z.boolean(),
  ea_allowed: z.boolean(),
  platform: z.enum(['mt4', 'mt5', 'ctrader', 'tradovate', 'rithmic', 'tradelocker']),
  profit_split_pct: z.number().min(0).max(1),
  scaling_cap: z.string(),
  min_hold_time_seconds: z.number().int().min(0),
  max_daily_trades: z.number().int().positive().nullable(),
  eval_fee: z.number().min(0),
  tier: z.enum(['tier1', 'tier2', 'futures'])
});

/**
 * Load a single firm profile from a JSON file.
 */
export function loadFirmProfile(filePath: string): FirmProfile {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  const validated = FirmProfileSchema.parse(parsed);
  
  logger.info(`Loaded firm profile: ${validated.firm_id}`, {
    firm: validated.firm_name,
    accountSize: validated.account_size,
    drawdownModel: validated.drawdown_model
  });

  return validated as FirmProfile;
}

/**
 * Load all firm profiles from the profiles directory.
 */
export function loadAllFirmProfiles(): Map<string, FirmProfile> {
  const profilesDir = join(__dirname, 'profiles');
  const profiles = new Map<string, FirmProfile>();

  try {
    const files = readdirSync(profilesDir).filter(f => f.endsWith('.json'));
    
    for (const file of files) {
      try {
        const profile = loadFirmProfile(join(profilesDir, file));
        profiles.set(profile.firm_id, profile);
      } catch (error) {
        logger.error(`Failed to load firm profile: ${file}`, { error });
      }
    }
  } catch (error) {
    logger.warn('No profiles directory found, using defaults');
  }

  logger.info(`Loaded ${profiles.size} firm profiles`);
  return profiles;
}

/**
 * Get a specific firm profile by ID.
 */
export function getFirmProfile(firmId: string): FirmProfile | undefined {
  const profiles = loadAllFirmProfiles();
  return profiles.get(firmId);
}
