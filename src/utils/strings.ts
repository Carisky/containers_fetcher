export function normalizeHeader(s: string): string {
return (s ?? "")
.replace(/\uFEFF/g, "")
.replace(/"/g, "")
.replace(/[^\p{L}\p{N}]+/gu, "")
.toLowerCase();
}


export function escapeRegExp(s: string) {
return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
}