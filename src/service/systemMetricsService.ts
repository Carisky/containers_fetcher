import os from "os";
import path from "path";
import { promises as fs } from "fs";
import si from "systeminformation";
import { getRequestLogs } from "../utils/requestLogFile";

type CpuSnapshot = {
  idle: number;
  total: number;
};

type CoreUsage = {
  coreIndex: number;
  usagePercent: number;
};

export type CpuUsage = {
  averagePercent: number;
  perCore: CoreUsage[];
};

export type MemoryStats = {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
};

export type ProcessMemoryStats = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

export type LogSummary = {
  totalEntries: number;
  last5Minutes: number;
  last15Minutes: number;
  last60Minutes: number;
  recentErrorCount: number;
  fileSizeBytes: number | null;
};

type TemperatureStats = {
  mainC?: number;
  maxC?: number;
  coresC?: number[];
};

type CpuDetails = {
  brand?: string;
  vendor?: string;
  cores?: number;
  physicalCores?: number;
  speedGhz?: number;
  speedMinGhz?: number;
  speedMaxGhz?: number;
  temperature: TemperatureStats;
};

type SwapStats = {
  totalBytes: number;
  usedBytes: number;
  usedPercent: number;
};

type StorageVolumeStats = {
  fs: string;
  type?: string;
  mount?: string;
  sizeBytes: number;
  usedBytes: number;
  usedPercent: number;
};

type NetworkInterfaceStats = {
  iface: string;
  operstate?: string;
  rxBytes: number;
  txBytes: number;
  rxMbit: number;
  txMbit: number;
};

type GpuControllerStats = {
  model: string;
  vendor?: string;
  vramMB?: number;
  temperatureC?: number;
};

type BatteryStats = {
  hasBattery: boolean;
  percent?: number;
  isCharging?: boolean;
  temperatureC?: number;
};

type HardwareMetrics = {
  cpu: CpuDetails;
  memory: {
    swap?: SwapStats;
  };
  storage: StorageVolumeStats[];
  network: NetworkInterfaceStats[];
  gpu: GpuControllerStats[];
  battery?: BatteryStats;
};

export type SystemMetrics = {
  timestamp: string;
  platform: {
    hostname: string;
    arch: string;
    release: string;
    platform: string;
    cpuModel: string;
    cpuCount: number;
    physicalCpuCount?: number;
  };
  cpu: CpuUsage;
  loadAverage: {
    one: number;
    five: number;
    fifteen: number;
  };
  memory: {
    system: MemoryStats;
    process: ProcessMemoryStats;
  };
  uptime: {
    systemSeconds: number;
    processSeconds: number;
  };
  logs: LogSummary;
  versions: {
    node: string;
  };
  environment: {
    nodeEnv?: string;
  };
  hardware: HardwareMetrics;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const takeCpuSnapshot = (): CpuSnapshot[] => {
  return os.cpus().map((cpu) => {
    const { user, nice, sys, idle, irq } = cpu.times;
    const total = user + nice + sys + idle + irq;
    return { idle, total };
  });
};

const calculateCpuUsage = (start: CpuSnapshot[], end: CpuSnapshot[]): CpuUsage => {
  const perCore = start.map((startCpu, index) => {
    const endCpu = end[index];
    const idle = endCpu.idle - startCpu.idle;
    const total = endCpu.total - startCpu.total;
    const usage = total > 0 ? 1 - idle / total : 0;
    return {
      coreIndex: index,
      usagePercent: Number((usage * 100).toFixed(2)),
    };
  });

  const average =
    perCore.reduce((sum, core) => sum + core.usagePercent, 0) /
    (perCore.length || 1);

  return {
    perCore,
    averagePercent: Number(average.toFixed(2)),
  };
};

const measureCpuUsage = async (sampleMs = 500): Promise<CpuUsage> => {
  const start = takeCpuSnapshot();
  await delay(sampleMs);
  const end = takeCpuSnapshot();
  return calculateCpuUsage(start, end);
};

const toMemoryStats = (total: number, free: number): MemoryStats => {
  const used = total - free;
  const percent = total > 0 ? (used / total) * 100 : 0;
  return {
    totalBytes: total,
    usedBytes: used,
    freeBytes: free,
    usedPercent: Number(percent.toFixed(2)),
  };
};

const toNumber = (value: number | null | undefined, fractionDigits = 2): number | undefined => {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return undefined;
  }
  if (fractionDigits == null) {
    return value;
  }
  return Number(value.toFixed(fractionDigits));
};

const gatherHardwareMetrics = async (): Promise<HardwareMetrics> => {
  const [
    cpuInfoResult,
    cpuSpeedResult,
    cpuTempResult,
    memResult,
    fsResult,
    networkResult,
    graphicsResult,
    batteryResult,
  ] = await Promise.allSettled([
    si.cpu(),
    si.cpuCurrentSpeed(),
    si.cpuTemperature(),
    si.mem(),
    si.fsSize(),
    si.networkStats(),
    si.graphics(),
    si.battery(),
  ]);

  const getValue = <T>(result: PromiseSettledResult<T>): T | undefined =>
    result.status === "fulfilled" ? result.value : undefined;

  const cpuInfo = getValue(cpuInfoResult);
  const cpuSpeed = getValue(cpuSpeedResult);
  const cpuTemp = getValue(cpuTempResult);
  const memInfo = getValue(memResult);
  const fsInfo = getValue(fsResult) ?? [];
  const networkInfo = getValue(networkResult) ?? [];
  const graphicsInfo = getValue(graphicsResult);
  const batteryInfo = getValue(batteryResult);

  const temperatureCores =
    cpuTemp?.cores?.map((core) => toNumber(core, 1)).filter(
      (value): value is number => value !== undefined
    ) ?? undefined;

  const temperature: TemperatureStats = {
    mainC: toNumber(cpuTemp?.main, 1),
    maxC: toNumber(cpuTemp?.max, 1),
    coresC: temperatureCores && temperatureCores.length > 0 ? temperatureCores : undefined,
  };

  const cpuDetails: CpuDetails = {
    brand: cpuInfo?.brand,
    vendor: cpuInfo?.vendor,
    cores: cpuInfo?.cores,
    physicalCores: cpuInfo?.physicalCores,
    speedGhz: toNumber(cpuSpeed?.avg, 2),
    speedMinGhz: toNumber(cpuSpeed?.min, 2),
    speedMaxGhz: toNumber(cpuSpeed?.max, 2),
    temperature,
  };

  const swap: SwapStats | undefined =
    memInfo && memInfo.swaptotal > 0
      ? {
          totalBytes: memInfo.swaptotal,
          usedBytes: memInfo.swapused,
          usedPercent: toNumber((memInfo.swapused / memInfo.swaptotal) * 100, 2) ?? 0,
        }
      : undefined;

  const storage: StorageVolumeStats[] = fsInfo.map((volume) => {
    const usedPercent =
      volume.use !== undefined
        ? toNumber(volume.use, 2) ?? 0
        : volume.size > 0
        ? Number(((volume.used / volume.size) * 100).toFixed(2))
        : 0;

    return {
      fs: volume.fs || volume.mount || "unknown",
      type: volume.type || undefined,
      mount: volume.mount || undefined,
      sizeBytes: volume.size,
      usedBytes: volume.used,
      usedPercent,
    };
  });

  const network: NetworkInterfaceStats[] = networkInfo
    .filter((stat) => stat.iface)
    .map((stat) => {
      const rxMbit = toNumber(((stat.rx_sec ?? 0) * 8) / 1_000_000, 2) ?? 0;
      const txMbit = toNumber(((stat.tx_sec ?? 0) * 8) / 1_000_000, 2) ?? 0;

      return {
        iface: stat.iface,
        operstate: stat.operstate || undefined,
        rxBytes: stat.rx_bytes,
        txBytes: stat.tx_bytes,
        rxMbit,
        txMbit,
      };
    });

  const batteryTemperature = (batteryInfo as unknown as { temperature?: number } | undefined)?.temperature;

  const gpu: GpuControllerStats[] =
    graphicsInfo?.controllers?.map((controller) => ({
      model: controller.model || "unknown",
      vendor: controller.vendor || undefined,
      vramMB: (typeof controller.vram === "number" ? controller.vram : undefined),
      temperatureC: toNumber(controller.temperatureGpu, 1),
    })) ?? [];

  const battery: BatteryStats | undefined = batteryInfo
    ? {
        hasBattery: Boolean(batteryInfo.hasBattery),
        percent: toNumber(batteryInfo.percent, 1),
        isCharging: batteryInfo.isCharging ?? undefined,
        temperatureC: toNumber(batteryTemperature, 1),
      }
    : undefined;

  return {
    cpu: cpuDetails,
    memory: {
      swap,
    },
    storage,
    network,
    gpu,
    battery,
  };
};

const getLogSummary = async (): Promise<LogSummary> => {
  const logs = await getRequestLogs();
  const now = Date.now();

  const within = (ms: number) =>
    logs.filter((entry) => {
      const timestamp = Date.parse(entry.timestamp);
      if (Number.isNaN(timestamp)) {
        return false;
      }
      return now - timestamp <= ms;
    }).length;

  const recentErrorCount = logs.filter((entry) => {
    const timestamp = Date.parse(entry.timestamp);
    if (Number.isNaN(timestamp)) {
      return false;
    }
    return now - timestamp <= 60 * 60 * 1000 && entry.status >= 400;
  }).length;

  let fileSizeBytes: number | null = null;
  try {
    const stats = await fs.stat(path.join(process.cwd(), "logs", "requests.json"));
    fileSizeBytes = stats.size;
  } catch (error) {
    fileSizeBytes = null;
  }

  return {
    totalEntries: logs.length,
    last5Minutes: within(5 * 60 * 1000),
    last15Minutes: within(15 * 60 * 1000),
    last60Minutes: within(60 * 60 * 1000),
    recentErrorCount,
    fileSizeBytes,
  };
};

export const collectSystemMetrics = async (): Promise<SystemMetrics> => {
  const cpuUsage = await measureCpuUsage();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const systemMemory = toMemoryStats(totalMemory, freeMemory);

  const processMemoryRaw = process.memoryUsage();
  const processMemory: ProcessMemoryStats = {
    rss: processMemoryRaw.rss,
    heapTotal: processMemoryRaw.heapTotal,
    heapUsed: processMemoryRaw.heapUsed,
    external: processMemoryRaw.external,
    arrayBuffers: processMemoryRaw.arrayBuffers,
  };

  const load = os.loadavg();
  const cpus = os.cpus();

  const [logSummary, hardware] = await Promise.all([
    getLogSummary(),
    gatherHardwareMetrics(),
  ]);

  return {
    timestamp: new Date().toISOString(),
    platform: {
      hostname: os.hostname(),
      arch: os.arch(),
      release: os.release(),
      platform: os.platform(),
      cpuModel: cpus[0]?.model || "unknown",
      cpuCount: cpus.length,
      physicalCpuCount: hardware.cpu.physicalCores,
    },
    cpu: cpuUsage,
    loadAverage: {
      one: Number(load[0].toFixed(2)),
      five: Number(load[1].toFixed(2)),
      fifteen: Number(load[2].toFixed(2)),
    },
    memory: {
      system: systemMemory,
      process: processMemory,
    },
    uptime: {
      systemSeconds: os.uptime(),
      processSeconds: process.uptime(),
    },
    logs: logSummary,
    versions: {
      node: process.version,
    },
    environment: {
      nodeEnv: process.env.NODE_ENV || undefined,
    },
    hardware,
  };
};

export default collectSystemMetrics;




