import { parse } from "csv-parse/sync";
import { normalizeHeader } from "./strings";
import type { ContainerCsvInfo } from "../types/index";


export function buildContainerInfoFromCsv(csv: string): Record<string, ContainerCsvInfo> {
const rows: string[][] = parse(csv, { relaxQuotes: true, skipEmptyLines: true });
const map: Record<string, ContainerCsvInfo> = {};


const containerHeaderSynonyms = [
"numer","unitnbr","equipmentno","equipmentnumber","equipment",
"containerno","containernumber","containerid","container"
];
const cenHeaderSynonyms = ["cennumber","cen"];
const tStateSynonyms = ["tstate","tstatus","tst","t"]; // нормализованный "t-state" -> "tstate"
const timeOutSynonyms = ["timeout","timeoutdate","timeoutdatetime"];
const timeInSynonyms = ["timein","timeindate","timeindatetime"];


let contIdx = -1, cenIdx = -1, tStateIdx = -1, timeOutIdx = -1, timeInIdx = -1;


for (const r of rows) {
const norm = r.map(h => normalizeHeader(h));


// заголовок
if (contIdx === -1 && norm.some(h => containerHeaderSynonyms.includes(h))) {
contIdx = norm.findIndex(h => containerHeaderSynonyms.includes(h));
cenIdx = norm.findIndex(h => cenHeaderSynonyms.includes(h));
tStateIdx = norm.findIndex(h => tStateSynonyms.includes(h));
timeOutIdx = norm.findIndex(h => timeOutSynonyms.includes(h));
timeInIdx = norm.findIndex(h => timeInSynonyms.includes(h));
continue;
}


if (contIdx >= 0) {
const cont = String(r[contIdx] ?? "").trim();
if (!cont) continue;


const cen = cenIdx >= 0 ? String(r[cenIdx] ?? "").trim() : "";
const t_state = tStateIdx >= 0 ? String(r[tStateIdx] ?? "").trim() : "";


let dateStr = timeOutIdx >= 0 ? r[timeOutIdx] : "";
if (!dateStr && timeInIdx >= 0) dateStr = r[timeInIdx];
const date = dateStr ? Date.parse(dateStr as string) : 0;


if (!map[cont] || date > map[cont].date) {
map[cont] = { cen: cen || undefined, t_state: t_state || undefined, date };
}
}
}
return map;
}