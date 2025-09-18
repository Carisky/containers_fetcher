import { escapeRegExp } from "./strings";


export function extractCenFromBctXml(xml: string, cont: string): string | undefined {
const cdataMatch = xml.match(/<content>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/content>/s);
if (!cdataMatch) return undefined;
const html = cdataMatch[1];
const rx = new RegExp(escapeRegExp(cont) + "\\s*\\[\\s*([^\\]]+)\\s*\\]", "i");
const m = html.match(rx);
return m?.[1]?.trim();
}


export function extractStatusFromBctXml(xml: string): string | undefined {
const cdataMatch = xml.match(/<content>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/content>/s);
if (!cdataMatch) return undefined;
const html = cdataMatch[1];
const m = html.match(/Aktualnie znajduje się:[\s\S]*?<img[^>]*alt="([^"]+)"/i);
return m?.[1]?.trim();
}