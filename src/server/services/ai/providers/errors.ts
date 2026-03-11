export class ProviderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider request timed out after ${timeoutMs}ms`);
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderAPIError extends Error {
  public readonly statusCode: number;
  public readonly responseBody: string;

  constructor(statusCode: number, responseBody: string) {
    super(`Provider API error (${statusCode}): ${responseBody}`);
    this.name = 'ProviderAPIError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class ProviderAuthError extends Error {
  constructor(message: string = 'Invalid or missing API key') {
    super(message);
    this.name = 'ProviderAuthError';
  }
}
