import { FC, useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useNavigationContext } from "../navigation";
import { useWebviewQuery } from "../use-webview-query";
import { FunctionCard } from "../components/dashboard/function-card";
import { Pagination } from "../components/ui/pagination";
import { Skeleton } from "../components/ui/skeleton";
import { Button } from "../components/ui/button";
import {
  IconSearch,
  IconShieldCheck,
  IconX,
  IconFunction,
} from "@tabler/icons-react";

type EnrichedFunctionItem = {
  content_hash: string;
  function_name: string;
  file_path: string;
  language: string;
  entity_type: string;
  start_line: number;
  analysis: {
    documentation: { description: string };
    security: { issues: unknown[] };
  };
};

type EnrichedFunctionsResult = {
  items: EnrichedFunctionItem[];
  total: number;
  page: number;
};

const PAGE_SIZE = 12;

export const FunctionsView: FC = () => {
  const nav = useNavigationContext();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [language, setLanguage] = useState("");
  const [securityOnly, setSecurityOnly] = useState(false);
  const [page, setPage] = useState(1);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Debounce search input
  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  // Fetch available languages
  const { data: languages } = useWebviewQuery<string[]>("getAvailableLanguages");

  // Build query params
  const queryParams = useMemo(
    () => ({
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(language ? { language } : {}),
      securityOnly,
      page,
      pageSize: PAGE_SIZE,
    }),
    [debouncedSearch, language, securityOnly, page],
  );

  const { data, isLoading } = useWebviewQuery<EnrichedFunctionsResult>(
    "getEnrichedFunctions",
    queryParams,
  );

  const handleNavigateToFunction = useCallback(
    (contentHash: string, filePath: string) => {
      nav.push({ view: "function-detail", params: { contentHash, filePath } });
    },
    [nav],
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Loading skeleton
  if (isLoading && !data) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-9 w-full" />
        <div className="flex gap-1.5">
          <Skeleton className="h-6 w-12" />
          <Skeleton className="h-6 w-12" />
          <Skeleton className="h-6 w-16" />
        </div>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="px-4 pt-3 pb-2">
        <div
          className="flex items-center gap-2 rounded-md border px-3 h-9"
          style={{
            backgroundColor: "var(--vscode-input-background, hsl(var(--background)))",
            borderColor: "var(--vscode-input-border, hsl(var(--border)))",
          }}
        >
          <IconSearch className="size-3.5 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search functions..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            style={{
              color: "var(--vscode-input-foreground, hsl(var(--foreground)))",
            }}
          />
          {search && (
            <button
              onClick={() => { setSearch(""); setDebouncedSearch(""); setPage(1); }}
              className="text-muted-foreground hover:text-foreground"
            >
              <IconX className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Filter row */}
      <div className="px-4 pb-2 flex items-center gap-1.5 overflow-x-auto">
        {/* Security-only toggle */}
        <button
          onClick={() => { setSecurityOnly((v) => !v); setPage(1); }}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors border shrink-0 ${
            securityOnly
              ? "border-primary bg-primary/10 text-primary"
              : "border-transparent hover:bg-muted text-muted-foreground"
          }`}
        >
          <IconShieldCheck className="size-3" />
          Issues only
        </button>

        {/* Language chips */}
        {(languages ?? []).length > 1 && (
          <>
            <span className="text-muted-foreground text-[10px] mx-0.5">|</span>
            <button
              onClick={() => { setLanguage(""); setPage(1); }}
              className={`px-2 py-1 rounded-md text-xs transition-colors border shrink-0 ${
                !language
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-transparent hover:bg-muted text-muted-foreground"
              }`}
            >
              All
            </button>
            {(languages ?? []).map((lang) => (
              <button
                key={lang}
                onClick={() => { setLanguage(lang); setPage(1); }}
                className={`px-2 py-1 rounded-md text-xs transition-colors border shrink-0 ${
                  language === lang
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-transparent hover:bg-muted text-muted-foreground"
                }`}
              >
                {lang}
              </button>
            ))}
          </>
        )}
      </div>

      {/* Result count + top pagination */}
      <div className="px-4 pb-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground tabular-nums">
          {total === 0
            ? "No functions"
            : `${total} function${total !== 1 ? "s" : ""}`}
        </span>
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          disabled={isLoading}
        />
      </div>

      {/* Function list */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {items.length === 0 && !isLoading ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
            <IconFunction className="size-8 mb-2 opacity-40" />
            <p className="text-sm font-medium">
              {debouncedSearch || language || securityOnly
                ? "No functions match your filters"
                : "No functions found"}
            </p>
            {(debouncedSearch || language || securityOnly) && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => {
                  setSearch("");
                  setDebouncedSearch("");
                  setLanguage("");
                  setSecurityOnly(false);
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <FunctionCard
                key={item.content_hash}
                functionName={item.function_name}
                filePath={item.file_path}
                contentHash={item.content_hash}
                language={item.language}
                description={item.analysis?.documentation?.description ?? ""}
                issueCount={item.analysis?.security?.issues?.length ?? 0}
                onNavigate={handleNavigateToFunction}
              />
            ))}

            {/* Bottom pagination */}
            <Pagination
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
              disabled={isLoading}
            />
          </div>
        )}
      </div>
    </div>
  );
};
