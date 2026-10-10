// Consistent JSON errors. Controllers throw ApiError; the server maps it to
// { error: { code, message } } without leaking stacks or connection strings.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message = 'invalid request') => new ApiError(400, 'invalid_request', message);
export const notFound = (message = 'not found') => new ApiError(404, 'not_found', message);
export const conflict = (message = 'already processed') => new ApiError(409, 'duplicate_event', message);
export const unprocessable = (message = 'invalid transition') => new ApiError(422, 'invalid_transition', message);
export const internal = (message = 'internal error') => new ApiError(500, 'internal_error', message);
export const unavailable = (message = 'dependency unavailable') => new ApiError(503, 'unavailable', message);

// Map an engine error code (from Go /internal/*) to an HTTP status.
export function statusForEngineCode(code) {
  switch (code) {
    case 'duplicate':
      return 409;
    case 'invalid_transition':
      return 422;
    case 'not_found':
      return 404;
    case 'seed_unavailable':
      return 410;
    case 'rejected':
      return 400;
    default:
      return 503;
  }
}
