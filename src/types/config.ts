export type LogFormat = 'json' | 'pretty';

export interface Config {
  username: string;
  password: string;
  nsHost?: string;
  nsBaseUrl?: string;
  nsSecret: string;
  interval: number;
  sgvLimit: number;
  verbose: boolean;
  logFormat: LogFormat;
  patientId?: string;
  countryCode: string;
  language: string;
  staleThresholdMs: number;
  staleWebhookUrl?: string;
  stateFile?: string;
  circuitThreshold: number;
  circuitCooldownMs: number;
  /** Opt-in because a CareLink re-login may invalidate a CareLink Connect mobile session. */
  autoRelogin: boolean;
  /** Minimum interval between automatic re-login attempts. */
  autoReloginCooldownMs: number;
  /** 0 = disabled (default, no inbound port). >0 = loopback-only /healthz + /metrics. */
  metricsPort: number;
}
