/** Up to two upper-case initials of a display name, for avatar fallbacks. */
export const initials = (name: string) =>
  name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()
