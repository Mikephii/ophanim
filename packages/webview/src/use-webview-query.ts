// Lightweight query hook for the webview -- replaces the need for TanStack Query.
//
// Sends requests to the DataBridge (VS Code extension host or browser sql.js),
// tracks loading/error/data states, and auto-refetches on dbReloaded events.

import { useState, useEffect, useCallback, useRef } from "react";
import { useDataBridge } from "./data-bridge";

export interface WebviewQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  error: string | undefined;
  refetch: () => void;
}

export function useWebviewQuery<T>(
  method: string,
  params?: Record<string, unknown>,
  options?: { enabled?: boolean; refetchOn?: string[] }
): WebviewQueryResult<T> {
  const bridge = useDataBridge();
  const [data, setData] = useState<T | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const enabled = options?.enabled ?? true;

  // Stable reference to params for comparison
  const paramsKey = params ? JSON.stringify(params) : "";
  const methodRef = useRef(method);
  const paramsRef = useRef(params);
  methodRef.current = method;
  paramsRef.current = params;

  const fetchData = useCallback(async () => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(undefined);

    try {
      const result = await bridge.request<T>(
        methodRef.current,
        paramsRef.current
      );
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }, [bridge, enabled, paramsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch on mount and when params/method change
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refetch on push events (default: dbReloaded, editStateChanged)
  const refetchOn = options?.refetchOn;
  useEffect(() => {
    if (!enabled) return;
    return bridge.onPush((event) => {
      if (refetchOn) {
        if (refetchOn.includes(event.type)) fetchData();
      } else {
        if (event.type === "dbReloaded" || event.type === "editStateChanged") {
          fetchData();
        }
      }
    });
  }, [bridge, enabled, fetchData, refetchOn]);

  return { data, isLoading, error, refetch: fetchData };
}

/** Mutation helper -- fire-and-forget request with success/error callbacks */
export function useWebviewMutation<TParams = Record<string, unknown>>(
  method: string
) {
  const bridge = useDataBridge();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const mutate = useCallback(
    async (params?: TParams) => {
      setIsLoading(true);
      setError(undefined);
      try {
        await bridge.request(
          method,
          params as Record<string, unknown> | undefined
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setError(msg);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [bridge, method]
  );

  return { mutate, isLoading, error };
}
