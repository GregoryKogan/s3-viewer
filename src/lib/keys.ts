/** Key/prefix arithmetic shared by the stores and the views. */

/**
 * S3 prefixes are key prefixes, matched literally. A leading slash is preserved
 * because keys in some buckets genuinely start with one.
 */
export function asFolderPrefix(prefix: string | null | undefined): string {
  const value = (prefix ?? "").trim();
  if (!value) return "";
  return value.endsWith("/") ? value : `${value}/`;
}

/** Reject keys that would escape the connection prefix or break a URL. */
export function validateKey(key: string): string | null {
  if (!key) return "key is empty";
  if (key.startsWith("/")) return "key must not start with '/'";
  if (key.split("/").some((segment) => segment === "..")) return "key must not contain '..'";
  if (key.includes("\u0000")) return "key contains a NUL byte";
  return null;
}

/** Join a folder prefix and a file name, tolerating a missing slash. */
export function joinKey(prefix: string, name: string): string {
  return `${asFolderPrefix(prefix)}${name.replace(/^\/+/, "")}`;
}
