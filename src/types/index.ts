export type ContainerId = string;

export interface ContainerCsvInfo {
  cen?: string;
  t_state?: string;
  date: number; // legacy epoch tie breaker
  timeIn?: number;
  timeOut?: number;
}

export interface ContainerInfo {
  cen?: string;
  t_state?: string;
}

export interface BctInfo {
  cen?: string;
  status?: string;
}
