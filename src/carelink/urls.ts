const DEFAULT_SERVER_EU = 'carelink.minimed.eu';
const DEFAULT_SERVER_US = 'carelink.minimed.com';

export interface CareLinkUrls {
  me: string;
  profile: string;
  countrySettings: string;
  connectData: (timestamp: number) => string;
  monitorData: string;
  linkedPatients: string;
}

export function resolveServerName(
  server?: string,
  serverName?: string,
): string {
  if (serverName) return serverName;
  if (server?.toUpperCase() === 'EU') return DEFAULT_SERVER_EU;
  if (server?.toUpperCase() === 'US') return DEFAULT_SERVER_US;
  return server || DEFAULT_SERVER_EU;
}

export function buildUrls(
  serverName: string,
  countryCode: string,
  lang: string,
): CareLinkUrls {
  return {
    me: `https://${serverName}/patient/users/me`,
    profile: `https://${serverName}/patient/users/me/profile`,
    countrySettings: `https://${serverName}/patient/countries/settings?countryCode=${countryCode}&language=${lang}`,
    connectData: (timestamp: number) =>
      `https://${serverName}/patient/connect/data?cpSerialNumber=NONE&msgType=last24hours&requestTime=${timestamp}`,
    monitorData: `https://${serverName}/patient/monitor/data`,
    linkedPatients: `https://${serverName}/patient/m2m/links/patients`,
  };
}
