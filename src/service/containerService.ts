import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";

import { http } from "../utils/http";
import { buildContainerInfoFromCsv } from "../utils/csv";
import { extractContainerInfoFromBctHtml } from "../utils/bct";
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
  const pageUrl = "https://ebrama.bct.ictsi.com/vbs-check-container";
  const submitUrl = "https://ebrama.bct.ictsi.com/Tiles/TileCheckContainerSubmit";
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const jar = new CookieJar();
      const client = wrapper(
        axios.create({
          jar,
          withCredentials: true,
          timeout: 20000,
          headers: {
            "User-Agent": "Mozilla/5.0",
          },
        })
      );

      const { data: page } = await client.get<string>(pageUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        responseType: "text",
      });

      const tokenMatch = page.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
      const token = tokenMatch?.[1];
      if (!token) {
        throw new Error("Missing anti-forgery token");
      }

      const payload = new URLSearchParams({
        __RequestVerificationToken: token,
        ContainerNo: cont,
        "X-Requested-With": "XMLHttpRequest",
      }).toString();

      const { data: result } = await client.post<string>(submitUrl, payload, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          Referer: pageUrl,
          Accept: "*/*",
        },
        responseType: "text",
      });

      const info = extractContainerInfoFromBctHtml(result);
      if (info.cen || info.status) {
        return info;
      }
      if (attempt < retries) await sleep(1500);
    } catch (e) {
      if (attempt < retries) await sleep(2000);
    }
  }
  return {};
}
