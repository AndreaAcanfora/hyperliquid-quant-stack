import { DEFAULT_SETTINGS, type LabSettings } from "./lab";

const ALL_COINS = DEFAULT_SETTINGS.coins;

/** Lab settings from a URL query string; unknown or invalid values fall back to the defaults. */
export function parseSettings(search: string): LabSettings {
  const q = new URLSearchParams(search);
  const num = (k: string, d: number) => {
    const raw = q.get(k);
    return raw !== null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : d;
  };
  const coins = q.get("coins")?.split(",").filter((c) => ALL_COINS.includes(c));
  return {
    horizon: num("h", DEFAULT_SETTINGS.horizon),
    volTarget: num("vol", DEFAULT_SETTINGS.volTarget),
    grossCap: num("cap", DEFAULT_SETTINGS.grossCap),
    band: num("band", DEFAULT_SETTINGS.band),
    longOnly: q.get("shorts") !== "1",
    coins: coins && coins.length > 0 ? [...new Set(coins)] : DEFAULT_SETTINGS.coins,
    startYear: num("from", DEFAULT_SETTINGS.startYear),
  };
}

/** The query string for `s`, listing only what differs from the defaults. */
export function serializeSettings(s: LabSettings): string {
  const q = new URLSearchParams();
  if (s.horizon !== DEFAULT_SETTINGS.horizon) q.set("h", String(s.horizon));
  if (s.volTarget !== DEFAULT_SETTINGS.volTarget) q.set("vol", String(s.volTarget));
  if (s.grossCap !== DEFAULT_SETTINGS.grossCap) q.set("cap", String(s.grossCap));
  if (s.band !== DEFAULT_SETTINGS.band) q.set("band", String(s.band));
  if (!s.longOnly) q.set("shorts", "1");
  if (s.coins.length !== ALL_COINS.length) q.set("coins", s.coins.join(","));
  if (s.startYear !== DEFAULT_SETTINGS.startYear) q.set("from", String(s.startYear));
  return q.toString();
}
