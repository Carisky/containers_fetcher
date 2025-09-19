import { http } from "../utils/http";
import { buildContainerInfoFromCsv } from "../utils/csv";
import { extractCenFromBctXml, extractStatusFromBctXml } from "../utils/bct";
import { sleep } from "../utils/time";
import type { BctInfo, ContainerInfo } from "../types/index";

export async function fetchContainerInfo(
  cont: string,
  retries = 3
): Promise<Record<string, ContainerInfo>> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const url = `https://baltichub.com/api/multi?csv=true&ids=["${cont}"]`;
      const { data } = await http.get<string>(url, {
        headers: { Accept: "text/csv, */*;q=0.5" },
        responseType: "text",
        timeout: 20000,
      });

      if (!data || data.includes("<div")) {
        if (attempt < retries) await sleep(10000);
      } else {

        const info = buildContainerInfoFromCsv(data);
        const i = info[cont] || {};
        return { [cont]: { cen: i.cen, t_state: i.t_state } };
      }
    } catch (err) {
      if (attempt < retries) await sleep(2000);
    }
  }
  return {};
}

export async function fetchBctForContainer(
  cont: string,
  retries = 3
): Promise<BctInfo> {
  const baseUrl = "https://online.bct.gdynia.pl/Main/Bct/Container";
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const params = {
        ajax: "xContainerResult",
        container: cont,
        xrootAjax: String(Math.floor(10_000_000 + Math.random() * 90_000_000)),
      } as const;

      const { data } = await http.get<string>(baseUrl, {
        params,
        responseType: "text",
        headers: {
          Accept: "text/xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: baseUrl,
          "X-Requested-With": "XMLHttpRequest",
        },
        timeout: 15000,
      });

      const cen = extractCenFromBctXml(data, cont);
      const status = extractStatusFromBctXml(data);
      if (cen || status) return { cen, status };
      if (attempt < retries) await sleep(1500);
    } catch (e) {
      if (attempt < retries) await sleep(2000);
    }
  }
  return {};
}
