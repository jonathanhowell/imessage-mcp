/** One-line description of an error, e.g. `SqliteError 14: unable to open database file`. */
export const errorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  if (error.name === "SqliteError" && typeof code === "number") {
    return `SqliteError ${code}: ${error.message.replace(/^\d+:\s*/, "")}`;
  }
  return error.name === "Error"
    ? error.message
    : `${error.name}: ${error.message}`;
};
