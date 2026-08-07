export function normalizeLimit(value, options = {}, legacyMaximum) {
  const normalizedOptions =
    typeof options === "object"
      ? options
      : { fallback: options, maximum: legacyMaximum };
  const fallback = normalizedOptions.fallback ?? 100;
  const maximum = normalizedOptions.maximum ?? 500;
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(maximum, Math.floor(parsed)))
    : fallback;
}

export function positiveInt(value, options = {}) {
  const label = typeof options === "string" ? options : options.label || "value";
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}
