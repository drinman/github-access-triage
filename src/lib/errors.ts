export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryAfterSeconds?: number;
  readonly credentialInvalid: boolean;
  readonly ambiguousDelivery: boolean;

  constructor(
    code: string,
    message: string,
    httpStatus: number,
    options: {
      retryAfterSeconds?: number;
      credentialInvalid?: boolean;
      ambiguousDelivery?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.credentialInvalid = options.credentialInvalid ?? false;
    this.ambiguousDelivery = options.ambiguousDelivery ?? false;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError(
    "INTERNAL_ERROR",
    "The request could not be completed.",
    500,
    { cause: error },
  );
}
