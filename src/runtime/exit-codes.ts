interface ExitCodeValues {
  readonly Ok: 0;
  readonly Runtime: 1;
  readonly Usage: 2;
  readonly AuthRequired: 3;
  readonly ConfirmationRequired: 4;
  readonly Conflict: 5;
  readonly Retryable: 6;
}

export const ExitCodes: ExitCodeValues = {
  Ok: 0,
  Runtime: 1,
  Usage: 2,
  AuthRequired: 3,
  ConfirmationRequired: 4,
  Conflict: 5,
  Retryable: 6,
};

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];
