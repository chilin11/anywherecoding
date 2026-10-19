/** Preserve native diagnostic fields without dumping request payloads or credentials. */
export function errorText(value: unknown, fallback = "请求失败"): string {
  if (typeof value === "string") return value.trim() || fallback;
  if (!value || typeof value !== "object") return fallback;
  const data = value as Record<string, any>;
  const parts: string[] = [];
  const add = (value: unknown) => { if (typeof value === "string" && value.trim() && !parts.includes(value.trim())) parts.push(value.trim()); };
  add(data.message); add(data.errorMessage); add(data.result);
  if (Array.isArray(data.errors)) for (const error of data.errors) add(errorText(error, ""));
  if (data.error) add(errorText(data.error, ""));
  add(data.additionalDetails); add(data.details);
  for (const field of ["code", "status", "statusCode", "requestId", "subtype"]) {
    if (typeof data[field] === "string" || typeof data[field] === "number") add(`${field}: ${data[field]}`);
  }
  return parts.join("\n") || fallback;
}
