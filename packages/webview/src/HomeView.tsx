import { FC } from "react";
import { FunctionData } from "./data";
import { Logo } from "./components/Logo";
import { Badge } from "./components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Separator } from "./components/ui/separator";
import {
  IconAlertTriangle,
  IconLock,
  IconDatabase,
  IconWorld,
  IconCode,
} from "@tabler/icons-react";

interface Props {
  functionsByFile: Map<string, FunctionData[]>;
  onSelectFunction: (fn: FunctionData) => void;
}

const getIcon = (fn: FunctionData) => {
  if (fn.securityFlags.length > 0)
    return <IconAlertTriangle className="size-4 text-destructive" />;
  if (fn.dataTags.includes("pii") || fn.dataTags.includes("credentials"))
    return <IconLock className="size-4 text-amber-500" />;
  if (fn.dataTags.includes("database"))
    return <IconDatabase className="size-4 text-blue-400" />;
  if (fn.dataTags.includes("external_api"))
    return <IconWorld className="size-4 text-emerald-400" />;
  return <IconCode className="size-4 text-muted-foreground" />;
};

const shortenPath = (filePath: string): string => {
  const parts = filePath.split("/");
  return parts.slice(-3).join("/");
};

const truncate = (str: string, len: number): string => {
  return str.length > len ? str.slice(0, len - 1) + "\u2026" : str;
};

export const HomeView: FC<Props> = ({ functionsByFile, onSelectFunction }) => {
  if (functionsByFile.size === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-screen text-center text-muted-foreground">
        <Logo size={48} className="mb-4 opacity-40" />
        <h2 className="font-medium mb-1 text-foreground">No functions found</h2>
        <p className="text-sm">
          Run <code className="text-primary">ophan init</code> to analyze your
          codebase
        </p>
      </div>
    );
  }

  const totalFunctions = Array.from(functionsByFile.values()).flat().length;

  return (
    <div className="p-4">
      <header className="flex items-center gap-3 mb-4">
        <Logo size={24} />
        <h1 className="text-base font-semibold text-foreground">Ophan</h1>
        <span className="text-muted-foreground text-xs ml-auto">
          {totalFunctions} functions &middot; {functionsByFile.size} files
        </span>
      </header>

      <Separator className="mb-4" />

      <div className="flex flex-col gap-3">
        {Array.from(functionsByFile.entries()).map(([filePath, functions]) => (
          <Card key={filePath} size="sm" className="gap-0 py-0">
            <CardHeader className="py-2.5 px-3">
              <CardTitle className="text-xs font-mono text-muted-foreground font-normal">
                {shortenPath(filePath)}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 py-0">
              {functions.map((fn, i) => (
                <button
                  key={fn.contentHash}
                  className={`flex items-center gap-2 py-2 px-3 bg-transparent border-none cursor-pointer text-left w-full hover:bg-muted/50 text-inherit transition-colors ${
                    i < functions.length - 1 ? "border-b border-border" : ""
                  }`}
                  onClick={() => onSelectFunction(fn)}
                >
                  <span className="shrink-0">{getIcon(fn)}</span>
                  <span className="text-primary font-medium text-sm shrink-0">
                    {fn.name}
                  </span>
                  <span className="text-muted-foreground text-xs truncate flex-1">
                    {truncate(fn.description, 50)}
                  </span>
                  {fn.securityFlags.length > 0 && (
                    <Badge variant="destructive" className="text-[10px] h-4 px-1.5">
                      {fn.securityFlags.length} issue{fn.securityFlags.length > 1 ? "s" : ""}
                    </Badge>
                  )}
                </button>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};
