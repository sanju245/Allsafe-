export class StoreError extends Error {
  constructor(message, { code = null, status = null, details = null, hint = null } = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;        // Postgres / PostgREST error code, e.g. 23514 (check violation)
    this.status = status;
    this.details = details;
    this.hint = hint;
  }
}
