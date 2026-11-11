export class PublicError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'invalid_request') {
    super(message);
    this.name = 'PublicError';
    this.status = status;
    this.code = code;
  }
}
