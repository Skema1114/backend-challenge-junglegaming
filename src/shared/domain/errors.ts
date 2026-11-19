export enum FailureCode {
  INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS",
  REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE = "REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE",
  CURRENCY_MISMATCH = "CURRENCY_MISMATCH",
  WALLET_NOT_FOUND = "WALLET_NOT_FOUND",
  PLAYER_MISMATCH = "PLAYER_MISMATCH",
  WALLET_MISMATCH = "WALLET_MISMATCH",
  ROUND_MISMATCH = "ROUND_MISMATCH",
  INVALID_REFERENCE_KIND = "INVALID_REFERENCE_KIND",
  REFERENCE_NOT_PROCESSED = "REFERENCE_NOT_PROCESSED",
  ALREADY_REVERSED = "ALREADY_REVERSED",
  AMOUNT_MISMATCH = "AMOUNT_MISMATCH",
  REFERENCE_NOT_FOUND = "REFERENCE_NOT_FOUND",
  INVALID_OPERATION = "INVALID_OPERATION",
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string = "DOMAIN_ERROR",
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationDomainError extends DomainError {
  constructor(message: string, code: string = "VALIDATION_ERROR") {
    super(message, code);
  }
}

export class NotFoundDomainError extends DomainError {
  constructor(message: string, code: string = "NOT_FOUND") {
    super(message, code);
  }
}

export class ConflictDomainError extends DomainError {
  constructor(message: string, code: string = "CONFLICT") {
    super(message, code);
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super(message, "INVALID_TRANSACTION_STATE");
  }
}

export class BusinessRejectionError extends DomainError {
  constructor(
    public readonly failureCode: FailureCode,
    message: string,
  ) {
    super(message, failureCode);
  }
}

export class TransientInfrastructureError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TransientInfrastructureError";
  }
}

export class PermanentInfrastructureError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PermanentInfrastructureError";
  }
}
