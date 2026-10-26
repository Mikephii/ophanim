import type { Readable } from "stream";

export type Config = {
  apiKey: string;
  baseUrl: string;
};

export const DEFAULT_TIMEOUT = 5000;

export interface Options {
  retry: boolean;
}
