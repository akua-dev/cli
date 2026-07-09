export const ExitCodes = {
  Ok: 0,
  Runtime: 1,
  Usage: 2,
  AuthRequired: 3,
  ConfirmationRequired: 4,
  Conflict: 5,
  Retryable: 6,
} as const;

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];
