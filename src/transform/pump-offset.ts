import * as logger from '../logger.js';
import type { CareLinkData } from '../types/carelink.js';

// Real-world UTC offsets are all multiples of 15 minutes (+05:30 India,
// +09:30 central Australia, +05:45 Nepal, -03:30 Newfoundland). Rounding
// the pump/server clock difference to the nearest quarter hour supports
// those zones while still absorbing up to ±7.5 minutes of pump clock
// drift. Rounding to whole hours (the previous behaviour) skewed every
// SGV timestamp by up to 30 minutes for users in those zones — see #15.
const QUARTER_HOUR_MS = 15 * 60 * 1000;

let lastGuess: string | undefined;

export function guessPumpOffset(data: CareLinkData): string {
  const offsetMs = guessPumpOffsetMilliseconds(data);
  const totalMinutes = Math.abs(offsetMs) / (60 * 1000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const offset =
    (offsetMs >= 0 ? '+' : '-') +
    String(hours).padStart(2, '0') +
    String(minutes).padStart(2, '0');

  if (offset !== lastGuess) {
    logger.log(
      'Guessed pump timezone ' + offset +
      ' (pump time: "' + data.sMedicalDeviceTime +
      '"; server time: ' + new Date(data.currentServerTime) + ')'
    );
  }
  lastGuess = offset;
  return offset;
}

export function guessPumpOffsetMilliseconds(data: CareLinkData): number {
  // v13 patientData responses can omit sMedicalDeviceTime. In that case,
  // infer the pump clock from the most recent SG timestamp; if that is also
  // unavailable, fall back to zero offset rather than returning NaN and
  // dropping every SGV in the recency filter.
  const pumpClock =
    data.sMedicalDeviceTime ||
    data.lastSG?.datetime ||
    data.sgs?.[data.sgs.length - 1]?.datetime;

  const pumpTimeAsIfUTC = pumpClock ? Date.parse(pumpClock) : NaN;
  const serverTimeUTC = data.currentServerTime;

  if (!Number.isFinite(pumpTimeAsIfUTC) || !Number.isFinite(serverTimeUTC)) {
    logger.warn('Unable to infer pump timezone; using zero offset', {
      component: 'transform',
      hasPumpClock: !!pumpClock,
      hasServerTime: Number.isFinite(serverTimeUTC),
    });
    return 0;
  }

  const raw = pumpTimeAsIfUTC - serverTimeUTC;
  return Math.round(raw / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
}
