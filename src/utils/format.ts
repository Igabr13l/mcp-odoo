export function formatList(rows: string[] | null | undefined): string {
  if (!rows || rows.length === 0) return "No results";
  return rows.join("\n");
}

export function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

export function decodeHtmlEntities(value: unknown): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCharCode(Number.parseInt(entity.slice(2), 16));
    }

    if (entity.startsWith("#")) {
      return String.fromCharCode(Number.parseInt(entity.slice(1), 10));
    }

    return namedEntities[entity.toLowerCase()] || match;
  });
}

export function htmlToText(html: unknown): string {
  if (!hasValue(html) || html === false) return "";

  const text = String(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<\/(ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function redactSecrets(value: unknown): string {
  if (!hasValue(value) || value === false) return "";

  return String(value)
    .replace(
      /-----BEGIN [^-\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\n]+ PRIVATE KEY-----/gi,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /((?:api[_ -]?)?key|(?:access[_ -]?)?token|secret|password|contrase(?:n|ñ)a)(\s*[:=]\s*)[^\n<]+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s<]+/gi, "$1[REDACTED]");
}
