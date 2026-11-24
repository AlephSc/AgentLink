export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "UNAUTHORIZED"
      | "NOT_FOUND"
      | "CONFLICT"
      | "INVALID_INPUT"
      | "RATE_LIMITED"
      | "REPLY_LIMIT",
  ) {
    super(message);
    this.name = "BridgeError";
  }
}
