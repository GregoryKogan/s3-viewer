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

/**
 * The prefix that reproduces `key` when the single local path named `localName`
 * is planned again.
 *
 * A retry re-uploads one plan item, but `upload_files` plans a batch from a
 * prefix: a file is placed at `prefix + name`, a directory at
 * `prefix + name + "/"`. Strip exactly that suffix so the retried upload lands
 * on the same key, including a file nested in a folder that was dropped whole.
 * Falls back to the key's parent prefix when the name does not match, which is
 * the safe target for an unusually renamed plan item.
 */
export function uploadScopeFor(key: string, localName: string): string {
  const name = localName.replace(/\/+$/, "");
  if (!name) {
    const slash = key.lastIndexOf("/");
    return slash === -1 ? "" : key.slice(0, slash + 1);
  }
  if (key === `${name}/` || key.endsWith(`/${name}/`)) {
    return key.slice(0, -(name.length + 1));
  }
  if (key === name || key.endsWith(`/${name}`)) {
    return key.slice(0, -name.length);
  }
  const slash = key.lastIndexOf("/");
  return slash === -1 ? "" : key.slice(0, slash + 1);
}
