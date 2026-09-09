import type { IAudioMetadata } from "music-metadata";

// Include standard and custom text tags, never artwork or binary payloads.
export function embeddedSearchText(metadata: IAudioMetadata): string {
  const values = new Set<string>();
  function collect(value: unknown, depth = 0) {
    if (depth > 12 || value == null || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).replace(/\s+/g, " ").trim();
      if (text) values.add(text);
    } else if (Array.isArray(value)) {
      value.forEach(item => collect(item, depth + 1));
    } else if (typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (!["picture", "data", "image", "binary"].includes(key)) collect(item, depth + 1);
      }
    }
  }
  collect(metadata.common);
  for (const tags of Object.values(metadata.native)) {
    for (const tag of tags) {
      if (!/APIC|PIC|COVERART|METADATA_BLOCK_PICTURE/i.test(tag.id)) collect(tag.value);
    }
  }
  return [...values].join(" ");
}
