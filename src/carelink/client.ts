import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import axios, { type AxiosInstance } from 'axios';
import * as logger from '../logger.js';
import { loadLoginData, writeLoginDataAtomic, isTokenExpired, refreshToken, decodeTokenPayload } from './token.js';
import { CircuitBreaker, DEFAULT_CIRCUIT_THRESHOLD, DEFAULT_CIRCUIT_COOLDOWN_MS } from '../circuit-breaker.js';
import { isPermanentRefreshFailure, isRefreshCredentialRejected } from '../refresh-failure.js';
import { login } from '../login.js';
import * as metrics from '../metrics.js';
import { decideRetry } from '../retry-policy.js';
import { resolveServerName, buildUrls, type CareLinkUrls } from './urls.js';
import type { CareLinkData, CareLinkUserInfo, CareLinkPatientLink, CareLinkCountrySettings } from '../types/carelink.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_REQUESTS_PER_FETCH = 30;

function safeAxiosResponseSummary(err: unknown): Record<string, unknown> | undefined {
  if (!axios.isAxiosError(err) || !err.response) return undefined;
  const data = err.response.data;

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const out: Record<string, unknown> = { responseKeys: Object.keys(obj).slice(0, 20) };
    for (const key of ['error', 'error_description', 'message', 'code', 'status']) {
      const value = obj[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out[key] = typeof value === 'string' ? value.slice(0, 300) : value;
      }
    }
    return out;
  }

  if (typeof data === 'string') {
    const compact = data
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { responseText: compact.slice(0, 300) };
  }

  return { responseType: typeof data };
}

export interface CareLinkClientOptions {
  username: string;
  password: string;
  server?: string;
  serverName?: string;
  countryCode?: string;
  lang?: string;
  patientId?: string;
  circuitThreshold?: number;
  circuitCooldownMs?: number;
  autoRelogin?: boolean;
  autoReloginCooldownMs?: number;
}

export class CareLinkClient {
  private axiosInstance: AxiosInstance;
  private urls: CareLinkUrls;
  private loginDataPath: string;
  private serverName: string;
  private options: CareLinkClientOptions;
  private requestCount = 0;
  private circuitBreaker: CircuitBreaker;
  private lastRefreshAt: number | null = null;
  private nextScheduledRefresh: number | null = null;
  private lastAutoReloginAt: number | null = null;

  constructor(options: CareLinkClientOptions) {
    this.options = options;

    const countryCode = options.countryCode || process.env['MMCONNECT_COUNTRYCODE'] || 'gb';
    const lang = options.lang || process.env['MMCONNECT_LANGCODE'] || 'en';

    this.serverName = resolveServerName(
      options.server || process.env['MMCONNECT_SERVER'],
      options.serverName || process.env['MMCONNECT_SERVERNAME'],
    );
    this.urls = buildUrls(this.serverName, countryCode, lang);
    this.loginDataPath = path.join(__dirname, '..', '..', 'data', 'logindata.json');
    this.circuitBreaker = new CircuitBreaker(
      options.circuitThreshold ?? DEFAULT_CIRCUIT_THRESHOLD,
      options.circuitCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS,
    );

    // Set up axios
    this.axiosInstance = axios.create({
      maxRedirects: 0,
      timeout: 15_000,
    });

    // Response interceptor: treat 2xx/3xx as success
    this.axiosInstance.interceptors.response.use(
      response => response,
      error => {
        if (error.response?.status >= 200 && error.response?.status < 400) {
          return error.response;
        }
        return Promise.reject(error);
      },
    );

    // Request interceptor: count requests and set headers
    this.axiosInstance.interceptors.request.use(config => {
      this.requestCount++;
      if (this.requestCount > MAX_REQUESTS_PER_FETCH) {
        throw new Error('Request count exceeds the maximum in one fetch!');
      }

      config.headers['User-Agent'] = USER_AGENT;
      config.headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
      config.headers['Accept-Language'] = 'en-US,en;q=0.9';
      config.headers['Accept-Encoding'] = 'gzip, deflate';
      config.headers['Connection'] = 'keep-alive';
      return config;
    });
  }

  /** Circuit-breaker + refresh introspection for main.ts persistence and tests. */
  isCircuitOpen(now = Date.now()): boolean {
    return this.circuitBreaker.isOpen(now);
  }

  getConsecutiveFailures(): number {
    return this.circuitBreaker.getConsecutiveFailures();
  }

  getCircuitOpenUntil(): number {
    return this.circuitBreaker.getOpenUntil();
  }

  getLastRefreshAt(): number | null {
    return this.lastRefreshAt;
  }

  getNextScheduledRefresh(): number | null {
    return this.nextScheduledRefresh;
  }

  restoreCircuitState(state: { consecutiveFailures?: number; circuitOpenUntil?: number }): void {
    this.circuitBreaker.restore(state);
  }

  setRefreshTracking(lastRefreshAt: number | null, nextScheduledRefresh: number | null): void {
    this.lastRefreshAt = lastRefreshAt;
    this.nextScheduledRefresh = nextScheduledRefresh;
  }

  setAutoReloginTracking(lastAutoReloginAt: number | null): void {
    this.lastAutoReloginAt = lastAutoReloginAt;
  }

  getLastAutoReloginAt(): number | null {
    return this.lastAutoReloginAt;
  }

  private canAutoRelogin(now = Date.now()): boolean {
    if (!this.options.autoRelogin) return false;
    const cooldown = this.options.autoReloginCooldownMs ?? 6 * 60 * 60 * 1000;
    return this.lastAutoReloginAt === null || now - this.lastAutoReloginAt >= cooldown;
  }

  private async autoRelogin(): Promise<void> {
    if (!this.canAutoRelogin()) {
      const cooldown = this.options.autoReloginCooldownMs ?? 6 * 60 * 60 * 1000;
      const remainingMs = this.lastAutoReloginAt === null
        ? 0
        : Math.max(0, cooldown - (Date.now() - this.lastAutoReloginAt));
      throw new Error(
        this.options.autoRelogin
          ? `CareLink refresh token rejected; automatic re-login cooldown active for another ${Math.ceil(remainingMs / 60000)} min.`
          : 'CareLink refresh token rejected; automatic re-login is disabled.',
      );
    }

    // Record the attempt before network I/O so a failing login cannot spin.
    this.lastAutoReloginAt = Date.now();
    logger.warn('Refresh token rejected — attempting controlled CareLink re-login', {
      component: 'token',
      cooldownMinutes: Math.round((this.options.autoReloginCooldownMs ?? 6 * 60 * 60 * 1000) / 60000),
    });

    const isUS = (process.env['MMCONNECT_SERVER'] || 'EU').toUpperCase() !== 'EU';
    const loginData = await login(isUS, this.options.username, this.options.password, false);
    this.lastRefreshAt = Date.now();
    this.updateNextScheduledRefresh(loginData.access_token);
    this.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer ' + loginData.access_token;
    logger.warn('Automatic CareLink re-login succeeded', { component: 'token' });
  }

  private updateNextScheduledRefresh(accessToken: string): void {
    try {
      const payload = decodeTokenPayload(accessToken);
      const exp = payload?.['exp'];
      if (typeof exp === 'number') {
        // Proactive refresh target: exp minus the same 600s margin
        // isTokenExpired() uses, so the next refresh fires before failure.
        this.nextScheduledRefresh = exp * 1000 - 600 * 1000;
      }
    } catch {
      // Malformed token — leave nextScheduledRefresh as-is.
    }
  }

  // Returns `true` if this iteration actually performed a refresh, `false`
  // if it just loaded existing tokens. The fetch() loop uses the return
  // value to keep the `forceRefresh` flag set across successive 401s — a
  // 401 immediately after a successful refresh+401 must still trigger
  // another refresh.
  private async authenticate(forceRefresh = false): Promise<boolean> {
    let loginData = loadLoginData(this.loginDataPath);
    if (!loginData) {
      throw new Error(
        'No logindata.json found. Run "npm run login" first to authenticate with CareLink.',
      );
    }

    if (forceRefresh || isTokenExpired(loginData.access_token)) {
      try {
        loginData = await refreshToken(loginData);
        metrics.incTokenRefresh('success');
        this.lastRefreshAt = Date.now();
        this.updateNextScheduledRefresh(loginData.access_token);
      } catch (e) {
        metrics.incTokenRefresh('failure');

        // CareLink/Auth0 may return either the OAuth-standard
        // 400 + invalid_grant/invalid_client or a bare HTTP 403 after the
        // CareLink Connect app has invalidated this refresh token.
        if (isRefreshCredentialRejected(e)) {
          if (this.options.autoRelogin) {
            await this.autoRelogin();
            return true;
          }

          if (isPermanentRefreshFailure(e)) {
            try { fs.unlinkSync(this.loginDataPath); } catch { /* ignore */ }
          }
          throw new Error(
            'CareLink refresh token rejected. Re-login required; automatic re-login is disabled.',
          );
        }

        // Transport, 5xx, 429, and local exceptions remain recoverable.
        throw e;
      }
      try {
        writeLoginDataAtomic(this.loginDataPath, loginData);
      } catch (e) {
        // Local disk failure (EACCES, ENOSPC, ENOENT) — refresh succeeded
        // but the new tokens can't be persisted. NEVER delete the file
        // here: the prior tokens are still good and a retry of
        // writeLoginDataAtomic on the next fetch may succeed. Rethrow
        // so the operator sees the real error.
        throw e;
      }
      this.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer ' + loginData.access_token;
      logger.info('Using token-based auth from logindata.json', { component: 'token' });
      return true;
    }

    this.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer ' + loginData.access_token;
    this.updateNextScheduledRefresh(loginData.access_token);
    logger.info('Using token-based auth from logindata.json', { component: 'token' });
    return false;
  }

  // The username CareLink knows the account by. CARELINK_USERNAME in .env
  // may be an email while the actual CareLink username differs, and the
  // data endpoints expect the latter — so prefer what /users/me reports
  // (the same source nightscout-connect and carelink-python-client use).
  private currentUser?: CareLinkUserInfo;

  private accountUsername(): string {
    return this.currentUser?.username || this.options.username;
  }

  private async getConnectData(): Promise<CareLinkData> {
    const resp = await this.axiosInstance.get<CareLinkUserInfo>(this.urls.me);
    this.currentUser = resp.data;
    const role = resp.data?.role?.toUpperCase() ?? '';
    logger.log('getConnectData - currentRole:', role);
    if (this.currentUser?.username && this.currentUser.username !== this.options.username) {
      logger.log(
        'CareLink reports username "' + this.currentUser.username +
        '" (differs from CARELINK_USERNAME) — using the server-reported one',
      );
    }

    if (role === 'CARE_PARTNER_OUS' || role === 'CARE_PARTNER') {
      return this.fetchAsCarepartner(role);
    }
    return this.fetchAsPatient();
  }

  private async fetchAsCarepartner(_role: string): Promise<CareLinkData> {
    let patientId = this.options.patientId;

    if (!patientId) {
      const patientsResp = await this.axiosInstance.get<CareLinkPatientLink[]>(this.urls.linkedPatients);
      if (patientsResp.data?.length > 0) {
        patientId = patientsResp.data[0].username;
        logger.log('Using linked patient:', patientId);
      } else {
        throw new Error('No linked patients found for care partner account');
      }
    }

    // Check if patient has a BLE device by fetching monitor data first
    try {
      const monitorResp = await this.axiosInstance.get<CareLinkData>(this.urls.monitorData);
      if (monitorResp.data && this.isBleDevice(monitorResp.data.deviceFamily || monitorResp.data.medicalDeviceFamily)) {
        logger.log('BLE device detected for carepartner, using BLE endpoint');
        return this.fetchBleDeviceData(patientId, 'carepartner');
      }
    } catch {
      // Fall through to standard carepartner flow
    }

    // Standard carepartner flow: BLE endpoint with multi-version fallback
    logger.log('Fetching country settings from:', this.urls.countrySettings);
    const settingsResp = await this.axiosInstance.get<CareLinkCountrySettings>(this.urls.countrySettings);
    const dataRetrievalUrl = settingsResp.data?.blePereodicDataEndpoint;

    if (!dataRetrievalUrl) {
      throw new Error('Unable to retrieve data retrieval URL for care partner account');
    }

    logger.log('Data retrieval URL:', dataRetrievalUrl);

    const endpoints = buildEndpointCandidates(dataRetrievalUrl);

    const body: Record<string, string> = {
      username: this.accountUsername(),
      role: 'carepartner',
      patientId,
    };

    for (const endpoint of endpoints) {
      try {
        logger.log('Trying carepartner endpoint:', endpoint);
        const resp = await this.axiosInstance.post<CareLinkData>(endpoint, body, {
          headers: { 'Content-Type': 'application/json' },
        });
        if (resp.status === 200) {
          logger.log('GET data (as carepartner)', endpoint);
          return resp.data;
        }
      } catch {
        logger.log('Endpoint failed:', endpoint);
      }
    }

    throw new Error('All carepartner data endpoints failed');
  }

  private isBleDevice(deviceFamily: string | undefined): boolean {
    return isBleDevice(deviceFamily);
  }

  private async fetchBleDeviceData(patientId?: string, role: string = 'patient'): Promise<CareLinkData> {
    logger.log('Fetching BLE device data');

    const settingsResp = await this.axiosInstance.get<CareLinkCountrySettings>(this.urls.countrySettings);
    const bleEndpoint = settingsResp.data?.blePereodicDataEndpoint;

    if (!bleEndpoint) {
      throw new Error('No BLE endpoint found in country settings');
    }

    if (!patientId) {
      const userResp = await this.axiosInstance.get<CareLinkUserInfo>(this.urls.me);
      patientId = userResp.data?.id;
    }

    const body: Record<string, string> = {
      username: this.accountUsername(),
      role,
    };

    if (patientId) {
      body.patientId = patientId;
    }

    const endpoints = buildEndpointCandidates(bleEndpoint);
    let lastError: unknown;

    // Newer CareLink clients send appVersion on v13 and personal accounts
    // have historically accepted both patient-scoped and unscoped bodies.
    // Try those first, then fall back to the endpoint/version matrix.
    const preferredV13 = endpoints.find(endpoint => /\/v13\//.test(endpoint));
    if (preferredV13) {
      const v13Bodies: Record<string, string>[] = [];

      const scopedBody: Record<string, string> = {
        ...body,
        appVersion: '3.8.0',
      };
      v13Bodies.push(scopedBody);

      if (role === 'patient') {
        const unscopedBody: Record<string, string> = {
          username: this.accountUsername(),
          role,
          appVersion: '3.8.0',
        };
        v13Bodies.push(unscopedBody);
      }

      for (const candidateBody of v13Bodies) {
        try {
          logger.log(
            'Trying BLE v13 body:',
            preferredV13,
            candidateBody.patientId ? 'with patientId' : 'without patientId',
          );
          const resp = await this.axiosInstance.post<CareLinkData>(preferredV13, candidateBody, {
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Accept': 'application/json, text/plain, */*',
              'Accept-Language': 'en;q=0.9, *;q=0.8',
              'Sec-Ch-Ua': '"Google Chrome";v="117", "Not;A=Brand";v="8", "Chromium";v="117"',
            },
          });

          if (resp.data && resp.status === 200) {
            logger.log('GET data (BLE)', preferredV13);
            return resp.data;
          }

          lastError = new Error('BLE v13 endpoint returned empty data');
        } catch (err) {
          lastError = err;
          const status = axios.isAxiosError(err) ? err.response?.status : undefined;
          logger.log(
            'BLE v13 body failed:',
            preferredV13,
            candidateBody.patientId ? 'with patientId' : 'without patientId',
            status ? `HTTP ${status}` : (err as Error).message,
            safeAxiosResponseSummary(err),
          );
        }
      }
    }

    for (const endpoint of endpoints) {
      try {
        logger.log('Trying BLE endpoint:', endpoint);
        const resp = await this.axiosInstance.post<CareLinkData>(endpoint, body, {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
          },
        });

        if (resp.data && resp.status === 200) {
          logger.log('GET data (BLE)', endpoint);
          return resp.data;
        }

        lastError = new Error('BLE endpoint returned empty data');
      } catch (err) {
        lastError = err;
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        logger.log(
          'BLE endpoint failed:',
          endpoint,
          status ? `HTTP ${status}` : (err as Error).message,
          safeAxiosResponseSummary(err),
        );
      }
    }

    throw lastError instanceof Error ? lastError : new Error('All BLE data endpoints failed');
  }

  private async fetchAsPatient(): Promise<CareLinkData> {
    // Try the monitor endpoint first (works for 7xxG pumps)
    try {
      const resp = await this.axiosInstance.get<CareLinkData>(this.urls.monitorData);

      if (resp.data && this.isBleDevice(resp.data.deviceFamily || resp.data.medicalDeviceFamily)) {
        logger.log('BLE device detected, using BLE endpoint');
        return this.fetchBleDeviceData(this.accountUsername());
      }

      if (resp.status === 200 && resp.data && Object.keys(resp.data).length > 1) {
        logger.log('GET data', this.urls.monitorData);
        return resp.data;
      }
    } catch {
      // Fall through to legacy endpoint
    }

    // Fall back to legacy connect endpoint
    const url = this.urls.connectData(Date.now());
    const resp = await this.axiosInstance.get<CareLinkData>(url);
    logger.log('GET data', url);
    return resp.data;
  }

  private throwAndRecord(e: unknown): never {
    const justOpened = this.circuitBreaker.recordFailure();
    if (justOpened) {
      const until = new Date(this.circuitBreaker.getOpenUntil()).toISOString();
      logger.warn('Circuit breaker open — pausing CareLink retries', {
        consecutiveFailures: this.circuitBreaker.getConsecutiveFailures(),
        openUntil: until,
      });
    }
    throw e;
  }

  async fetch(): Promise<CareLinkData> {
    // Circuit breaker (issue #9 item 3): after N consecutive failed fetch()
    // calls, short-circuit without touching the network for the cooldown.
    // The per-attempt backoff inside this method still applies when closed.
    if (this.circuitBreaker.isOpen()) {
      const until = new Date(this.circuitBreaker.getOpenUntil()).toISOString();
      throw new Error(
        `Circuit breaker open — skipping CareLink fetch until ${until} ` +
        `after ${this.circuitBreaker.getConsecutiveFailures()} consecutive failures`,
      );
    }

    this.requestCount = 0;

    // Up to 3 attempts total. The retry decision per attempt is
    // status-aware (see src/retry-policy.ts): 401/403 triggers an
    // authenticated re-attempt; 429 honours Retry-After; permanent 4xx
    // fails fast; 5xx and transport errors retry with capped exponential
    // + jitter.
    const maxRetry = 3;
    logger.info('Starting fetch', { component: 'fetch', maxAttempts: maxRetry });

    // CareLink can invalidate a token before its exp claim — most commonly
    // when the CareLink phone app logs into the same account. On 401/403,
    // force a refresh on the next attempt instead of retrying a dead token.
    let forceRefresh = false;

    for (let i = 1; i <= maxRetry; i++) {
      try {
        this.requestCount = 0;
        const didRefresh = await this.authenticate(forceRefresh);
        // Only clear forceRefresh when this iteration did NOT perform a
        // refresh. If authenticate returned true, the loop just ran a
        // refresh and clearing the flag would let the next 401 fire
        // without another refresh (the pre-fix bug — re-sends dead token
        // until the by-the-clock isTokenExpired check fires again).
        if (!didRefresh) {
          forceRefresh = false;
        }
        const data = await this.getConnectData();
        const closedCircuit = this.circuitBreaker.recordSuccess();
        if (closedCircuit) {
          logger.warn('Circuit breaker closed — CareLink reachable again');
        }
        logger.info('Success!', { component: 'fetch' });
        return data;
      } catch (e: unknown) {
        const err = e as { response?: { status: number; headers?: Record<string, unknown> }; code?: string; cause?: { code?: string }; message?: string };
        const httpStatus = err.response?.status;
        const errorCode = err.code || err.cause?.code || '';
        logger.info(`Attempt ${i} failed: ${httpStatus ? 'HTTP ' + httpStatus : errorCode || (err as Error).message}`, { component: 'fetch', attempt: i });

        // 401/403 is the auth path: the token may simply need a refresh,
        // not a permanent backoff. Short-circuit decideRetry here because
        // the retry policy treats 401/403 as fail-fast (the auth path's
        // own job, not the retry policy's). Skipping decideRetry lets the
        // next iteration run authenticate(forceRefresh = true) before
        // another data call. On the last attempt, give up — the
        // refresh-and-retry cycle has already exhausted itself.
        if (httpStatus === 401 || httpStatus === 403) {
          forceRefresh = true;
          if (i === maxRetry) this.throwAndRecord(e);
          continue;
        }

        // Status-aware retry decision for everything else. Permanent 4xx
        // (other than 401/403) fail fast — no point hammering a host that
        // has nothing to give. 429 honours Retry-After (numeric or
        // HTTP-date). 5xx and transport errors retry with capped
        // exponential + jitter. On the last attempt, decideRetry always
        // returns fail-fast.
        const decision = decideRetry(e, { attempt: i, maxAttempts: maxRetry });
        if (decision.kind === 'fail-fast') {
          this.throwAndRecord(e);
        }
        await sleep(decision.delayMs);
      }
    }

    this.throwAndRecord(new Error('Fetch failed after all retries'));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Determines whether a CareLink device family string indicates a BLE device
 * (780G, Guardian 4, Simplera, etc.). Exported at module level so the
 * helper can be unit-tested without spinning up a CareLinkClient.
 *
 * The patient `monitor/data` endpoint returns the family under `deviceFamily`,
 * while older endpoints use `medicalDeviceFamily`. The fix from upstream
 * PR #2 (https://github.com/domien-f/carelink-bridge/pull/2) made the call
 * sites pass `deviceFamily || medicalDeviceFamily` so BLE detection works
 * for both shapes.
 */
export function isBleDevice(deviceFamily: string | undefined): boolean {
  if (!deviceFamily) return false;
  return deviceFamily.includes('BLE') || deviceFamily.includes('SIMPLERA');
}

/**
 * Known API versions of the carepartner data endpoint, tried newest-first
 * after whatever version the country-settings config hands out. As of
 * 2026-07 the config returns v6 while the app discovery config advertises
 * a v13 base URL, so the fallback list spans both directions. Exported at
 * module level for unit testing.
 */
const BLE_API_VERSIONS = [13, 11, 6, 5];

export function buildEndpointCandidates(url: string): string[] {
  if (!/\/v\d+\//.test(url)) return [url];
  const candidates = [
    url,
    ...BLE_API_VERSIONS.map(v => url.replace(/\/v\d+\//, `/v${v}/`)),
  ];
  return [...new Set(candidates)];
}
