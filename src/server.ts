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

function buildContainerCenMapFromCsv(csv: string): Record<string, string> {
  const rows: string[][] = parse(csv, { relaxQuotes: true, skipEmptyLines: true });
  const map: Record<string, { cen: string; date: number }> = {};

  const containerHeaderSynonyms = [
    "numer", "unitnbr", "equipmentno", "equipmentnumber", "equipment",
    "containerno", "containernumber", "containerid", "container"
  ];
  const cenHeaderSynonyms = ["cennumber", "cen"];
  const timeOutSynonyms = ["timeout", "timeoutdate", "timeoutdatetime"];
  const timeInSynonyms = ["timein", "timeindate", "timeindatetime"];

  let contIdx = -1, cenIdx = -1, timeOutIdx = -1, timeInIdx = -1;

  for (const r of rows) {
    const norm = r.map(h => normalizeHeader(h));

    if (contIdx === -1 && cenIdx === -1) {
      if (norm.some(h => containerHeaderSynonyms.includes(h)) &&
          norm.some(h => cenHeaderSynonyms.includes(h))) {
        contIdx = norm.findIndex(h => containerHeaderSynonyms.includes(h));
        cenIdx = norm.findIndex(h => cenHeaderSynonyms.includes(h));
        timeOutIdx = norm.findIndex(h => timeOutSynonyms.includes(h));
        timeInIdx = norm.findIndex(h => timeInSynonyms.includes(h));
        continue;
      }
    }

    if (contIdx >= 0 && cenIdx >= 0) {
      const cont = String(r[contIdx] ?? "").trim();
      const cen = String(r[cenIdx] ?? "").trim();

      let dateStr = timeOutIdx >= 0 ? r[timeOutIdx] : "";
      if (!dateStr && timeInIdx >= 0) {
        dateStr = r[timeInIdx];
      }
      const date = dateStr ? Date.parse(dateStr) : 0;

      if (cont && cen) {
        if (!map[cont] || date > map[cont].date) {
          map[cont] = { cen, date };
        }
      }
    }
  }

  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.cen]));
}

async function fetchContainer(cont: string, retries = 3): Promise<Record<string, string>> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const url = `https://baltichub.com/api/multi?csv=true&ids=${encodeURIComponent(JSON.stringify([cont]))}`;
      const { data } = await axios.get<string>(url, {
        headers: { Accept: "text/csv, */*;q=0.5" },
        responseType: "text"
      });

      if (!data || data.includes("<div")) {
        console.log(`    ✗ Лимит/пусто для ${cont} (попытка ${attempt}/${retries})`);
        if (attempt < retries) {
          // пауза 10 секунд при HTML
          await new Promise(r => setTimeout(r, 10000));
        }
      } else {
        const map = buildContainerCenMapFromCsv(data);
        console.log(`    ✓ Успех: ${cont} → ${map[cont] || "(нет данных)"}`);
        return map;
      }
    } catch (err: any) {
      console.log(`    ⚠ Ошибка для ${cont} (попытка ${attempt}/${retries}): ${err.message || String(err)}`);
      if (attempt < retries) {
        // пауза 2 секунды при обычной ошибке
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  return {};
}


app.post("/lookup", async (req, res) => {
  const { containers } = req.body as { containers: string[] };

  const now = new Date().toISOString();
  console.log(`[${now}] Получен запрос на ${containers?.length || 0} контейнеров`);

  if (!Array.isArray(containers) || containers.length === 0) {
    return res.status(400).json({ error: "No containers provided" });
  }

  const finalMap: Record<string, string> = {};

  for (const cont of containers) {
    console.log(`  → Обработка контейнера ${cont}`);
    const map = await fetchContainer(cont);
    Object.assign(finalMap, map);
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`[${new Date().toISOString()}] Готово, найдено ${Object.keys(finalMap).length} CEN`);
  res.json({ map: finalMap });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
