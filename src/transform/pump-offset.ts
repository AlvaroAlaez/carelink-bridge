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

function normalizeEpoch(value: number): number {
  return value > 100_000_000_000 ? value : value * 1000;
}

function sgClockValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const sg = value as Record<string, unknown>;
  for (const key of ['timestamp', 'date', 'datetime', 'dateTime', 'sgTimestamp']) {
    if (sg[key] !== undefined && sg[key] !== null && sg[key] !== '') return sg[key];
  }
  return undefined;
}

function parseSgClockAsIfUtc(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return normalizeEpoch(value);
  if (typeof value !== 'string') return NaN;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) return normalizeEpoch(numeric);

  const hasZone = /(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(value);
  if (hasZone) return Date.parse(value);

  // v13 timestamps are local wall-clock ISO strings without a timezone.
  // Parse them as if they were UTC first; the calculated pump offset below
  // then converts that wall clock to the real UTC instant.
  if (/^\\d{4}-\\d{2}-\\d{2}T/.test(value)) {
    return Date.parse(value + 'Z');
  }

  return Date.parse(value);
}

export function guessPumpOffsetMilliseconds(data: CareLinkData): number {
  // v13 patientData responses can omit sMedicalDeviceTime and use timestamp
  // instead of legacy datetime. Prefer lastSG, then fall back to an SG item.
  const lastSgClock = sgClockValue(data.lastSG);
  const fallbackCandidates = Array.isArray(data.sgs)
    ? data.sgs
      .map(sgClockValue)
      .map(value => ({ value, parsed: parseSgClockAsIfUtc(value) }))
      .filter(item => Number.isFinite(item.parsed))
      .sort((a, b) => b.parsed - a.parsed)
    : [];
  const fallbackSgClock = fallbackCandidates[0]?.value;

  const usingMedicalDeviceClock = !!data.sMedicalDeviceTime;
  const pumpClock = data.sMedicalDeviceTime || lastSgClock || fallbackSgClock;
  const pumpTimeAsIfUTC = usingMedicalDeviceClock
    ? Date.parse(data.sMedicalDeviceTime)
    : parseSgClockAsIfUtc(pumpClock);
  const serverTimeUTC = usingMedicalDeviceClock
    ? data.currentServerTime
    : (data.lastMedicalDeviceDataUpdateServerTime || data.currentServerTime);

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
