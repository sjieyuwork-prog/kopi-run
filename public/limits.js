// Limits and fixed names shared by the browser and the Worker, so the form hints
// and the server checks can never disagree.

export const LIMITS = {
  maxUsers: 50,
  historySize: 5, // closed sessions kept; older ones are deleted
  usernameMin: 3,
  usernameMax: 20,
  passwordMin: 6,
  passwordMax: 128,
  title: 60,
  note: 80,
  inviteMin: 4,
  inviteMax: 32,
};

export const USERNAME_RE = new RegExp(`^[A-Za-z0-9._-]{${LIMITS.usernameMin},${LIMITS.usernameMax}}$`);
export const INVITE_CODE_RE = new RegExp(`^\\S{${LIMITS.inviteMin},${LIMITS.inviteMax}}$`);

// Values of order_sessions.status.
export const STATUS = { open: 'open', closed: 'closed' };

// Keys of the settings table.
export const SETTING = { version: 'version', inviteCode: 'invite_code' };
