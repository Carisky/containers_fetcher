import axios from "axios";
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
        return { [cont]: { cen: i.cen, t_state: i.t_state, stop: i.stop } };
      }
    } catch (err) {
      if (attempt < retries) await sleep(2000);
    }
  }
  return {};
}

const storeCookies = async (jar: CookieJar, url: string, cookies: string[] | undefined) => {
  if (!cookies || cookies.length === 0) return;
  for (const cookie of cookies) {
    await jar.setCookie(cookie, url, { ignoreError: true });
  }
};

const collectCookieHeader = async (jar: CookieJar, url: string): Promise<string | undefined> => {
  const cookieStr = await jar.getCookieString(url);
  return cookieStr.trim() ? cookieStr : undefined;
};

export async function fetchBctForContainer(
  cont: string,
  retries = 3
): Promise<BctInfo> {
  const pageUrl = "https://ebrama.bct.ictsi.com/vbs-check-container";
  const submitUrl = "https://ebrama.bct.ictsi.com/Tiles/TileCheckContainerSubmit";
  const client = axios.create({
    timeout: 20000,
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const jar = new CookieJar();
      const { data: page, headers } = await client.get<string>(pageUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        responseType: "text",
      });

      const setCookieHeader = headers["set-cookie"];
      await storeCookies(jar, pageUrl, Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : undefined);

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

      const cookieHeader = await collectCookieHeader(jar, pageUrl);
      const postHeaders: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: pageUrl,
        Accept: "*/*",
      };
      if (cookieHeader) {
        postHeaders.Cookie = cookieHeader;
      }

      const { data: result } = await client.post<string>(submitUrl, payload, {
        headers: postHeaders,
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
