export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export function serializeCookie(value: string, httpOnly: boolean): string {
  if (/[\r\n]/.test(value)) throw new Error('Invalid cookie value');
  return value
    + `; Path=/; Secure; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`
    + (httpOnly ? '; HttpOnly' : '');
}

export function expireCookie(name: string, httpOnly: boolean): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid cookie name');
  return `${name}=; Path=/; Secure; SameSite=Lax; Max-Age=0` + (httpOnly ? '; HttpOnly' : '');
}
