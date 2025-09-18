export type ContainerId = string;


export interface ContainerCsvInfo {
cen?: string;
t_state?: string;
date: number; // epoch ms
}


export interface ContainerInfo {
cen?: string;
t_state?: string;
}


export interface BctInfo {
cen?: string;
status?: string;
}