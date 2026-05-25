/** Time helpers. Everything in BulletinMail uses integer Unix milliseconds. */

export type UnixMs = number & { readonly __brand: unique symbol };

export function now(): UnixMs {
  return Date.now() as UnixMs;
}

export function plusDays(ms: UnixMs, days: number): UnixMs {
  return (ms + days * 86_400_000) as UnixMs;
}

export function plusMinutes(ms: UnixMs, minutes: number): UnixMs {
  return (ms + minutes * 60_000) as UnixMs;
}
