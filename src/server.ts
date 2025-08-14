import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { parse } from "csv-parse/sync";
import cors from "cors";

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = parseInt(process.env.PORT || "3400", 10);

function normalizeHeader(s: string): string {
  return (s ?? "")
    .replace(/\uFEFF/g, "")
    .replace(/"/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function escapeRegExp(s: string) { return s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"); }

// --- универсальный парсер CSV -> { cont: { cen?, t_state?, date } } ---
function buildContainerInfoFromCsv(csv: string): Record<string, { cen?: string; t_state?: string; date: number }> {
  const rows: string[][] = parse(csv, { relaxQuotes: true, skipEmptyLines: true });
  const map: Record<string, { cen?: string; t_state?: string; date: number }> = {};

  const containerHeaderSynonyms = [
    "numer","unitnbr","equipmentno","equipmentnumber","equipment",
    "containerno","containernumber","containerid","container"
  ];
  const cenHeaderSynonyms = ["cennumber","cen"];
  const tStateSynonyms = ["tstate","tstatus","tst","t"]; // нормализованный "t-state" -> "tstate"
  const timeOutSynonyms = ["timeout","timeoutdate","timeoutdatetime"];
  const timeInSynonyms  = ["timein","timeindate","timeindatetime"];

  let contIdx = -1, cenIdx = -1, tStateIdx = -1, timeOutIdx = -1, timeInIdx = -1;

  for (const r of rows) {
    const norm = r.map(h => normalizeHeader(h));

    // заголовок
    if (contIdx === -1 && (norm.some(h => containerHeaderSynonyms.includes(h)))) {
      contIdx   = norm.findIndex(h => containerHeaderSynonyms.includes(h));
      cenIdx    = norm.findIndex(h => cenHeaderSynonyms.includes(h));
      tStateIdx = norm.findIndex(h => tStateSynonyms.includes(h));
      timeOutIdx = norm.findIndex(h => timeOutSynonyms.includes(h));
      timeInIdx  = norm.findIndex(h => timeInSynonyms.includes(h));
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

async function fetchContainerInfo(cont: string, retries = 3): Promise<Record<string, { cen?: string; t_state?: string }>> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const url = `https://baltichub.com/api/multi?csv=true&ids=${encodeURIComponent(JSON.stringify([cont]))}`;
      const { data } = await axios.get<string>(url, {
        headers: { Accept: "text/csv, */*;q=0.5" },
        responseType: "text",
        timeout: 20000
      });

      if (!data || data.includes("<div")) {
        console.log(`    ✗ Лимит/пусто для ${cont} (попытка ${attempt}/${retries})`);
        if (attempt < retries) await sleep(10000);
      } else {
        const info = buildContainerInfoFromCsv(data);
        const i = info[cont] || {};
        console.log(`    ✓ ${cont} → CEN=${i.cen || "-"} T-State=${i.t_state || "-"}`);
        return { [cont]: { cen: i.cen, t_state: i.t_state } };
      }
    } catch (err: any) {
      console.log(`    ⚠ Ошибка для ${cont} (попытка ${attempt}/${retries}): ${err.message || String(err)}`);
      if (attempt < retries) await sleep(2000);
    }
  }
  return {};
}

/** BCT вспомогательные (оставил без изменений) */
function extractCenFromBctXml(xml: string, cont: string): string | undefined {
  const cdataMatch = xml.match(/<content>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/content>/s);
  if (!cdataMatch) return undefined;
  const html = cdataMatch[1];
  const rx = new RegExp(escapeRegExp(cont) + "\\s*\\[\\s*([^\\]]+)\\s*\\]", "i");
  const m = html.match(rx);
  return m?.[1]?.trim();
}

function extractStatusFromBctXml(xml: string): string | undefined {
  const cdataMatch = xml.match(/<content>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/content>/s);
  if (!cdataMatch) return undefined;
  const html = cdataMatch[1];
  const m = html.match(/Aktualnie znajduje się:[\s\S]*?<img[^>]*alt="([^"]+)"/i);
  return m?.[1]?.trim();
}

async function fetchBctForContainer(cont: string, retries = 3): Promise<{ cen?: string; status?: string }> {
  const baseUrl = "https://online.bct.gdynia.pl/Main/Bct/Container";
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const params = {
        ajax: "xContainerResult",
        container: cont,
        xrootAjax: String(Math.floor(10_000_000 + Math.random() * 90_000_000))
      };
      const { data } = await axios.get<string>(baseUrl, {
        params, responseType: "text",
        headers: {
          "Accept": "text/xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": "Mozilla/5.0", "Referer": baseUrl, "X-Requested-With": "XMLHttpRequest"
        },
        timeout: 15000
      });

      const cen = extractCenFromBctXml(data, cont);
      const status = extractStatusFromBctXml(data);
      if (cen || status) return { cen, status };
      if (attempt < retries) await sleep(1500);
    } catch (e: any) {
      console.log(`BCT ${cont}: попытка ${attempt}/${retries} — ${e.message || e}`);
      if (attempt < retries) await sleep(2000);
    }
  }
  return {};
}

// --- новый BCT роут (как был)
app.post("/lookup-bct", async (req, res) => {
  const { containers } = req.body as { containers: string[] };
  if (!Array.isArray(containers) || containers.length === 0) {
    return res.status(400).json({ error: "No containers provided" });
  }
  console.log(`[BCT] Получен запрос на ${containers.length} контейнер(ов)`);
  const map: Record<string, { status: string; cen?: string }> = {};
  for (const cont of containers) {
    console.log(`[BCT] → ${cont}`);
    const { cen, status } = await fetchBctForContainer(cont);
    if (status || cen) map[cont] = { status: status ?? "", cen };
    await sleep(1200);
  }
  console.log(`[BCT] Готово, найдено ${Object.keys(map).length} записей (status/cen)`);
  res.json({ map });
});

// --- /lookup с поддержкой t_status ---
app.post("/lookup", async (req, res) => {
  const { containers } = req.body as { containers: string[] };
  // t_status может прийти как query (?t_status=true) или в body
  const wantT =
    String((req.query?.t_status ?? (req.body as any)?.t_status) ?? "")
      .toLowerCase() === "true" || (req.body as any)?.t_status === true;

  const now = new Date().toISOString();
  console.log(`[${now}] /lookup: containers=${containers?.length || 0}, t_status=${wantT}`);

  if (!Array.isArray(containers) || containers.length === 0) {
    return res.status(400).json({ error: "No containers provided" });
  }

  // Собираем информацию (cen + t_state)
  const infoMap: Record<string, { cen?: string; t_state?: string }> = {};
  for (const cont of containers) {
    console.log(`  → ${cont}`);
    const info = await fetchContainerInfo(cont);
    Object.assign(infoMap, info);
    await sleep(2000);
  }

  // Ответ: либо старый формат (map -> cen), либо расширенный (map -> {cen, t_state})
  if (!wantT) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(infoMap)) map[k] = v.cen ?? "";
    console.log(`[${new Date().toISOString()}] Готово, найдено ${Object.keys(map).length} CEN (legacy)`);
    return res.json({ map });
  } else {
    const map: Record<string, { cen: string; t_state: string }> = {};
    for (const [k, v] of Object.entries(infoMap)) {
      map[k] = { cen: v.cen ?? "", t_state: v.t_state ?? "" };
    }
    console.log(`[${new Date().toISOString()}] Готово, найдено ${Object.keys(map).length} записей (cen+t_state)`);
    return res.json({ map });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
