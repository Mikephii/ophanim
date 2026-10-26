import { FC, useCallback } from "react";
import { Drawer } from "vaul";
import {
  IconShield,
  IconAlertTriangle,
  IconCode,
  IconSitemap,
  IconBook,
  IconClipboardCheck,
  IconActivity,
  IconVectorTriangle,
} from "@tabler/icons-react";
import { Badge } from "./ui/badge";
import type { ViewType } from "../navigation";

interface NavItem {
  view: ViewType;
  label: string;
  icon: FC<{ className?: string }>;
  countKey?: "securityIssues" | "functions" | "practices";
}

export const NAV_ITEMS: NavItem[] = [
  { view: "status", label: "Status", icon: IconActivity },
  { view: "home", label: "Security Overview", icon: IconShield },
  {
    view: "security-issues",
    label: "Security Issues",
    icon: IconAlertTriangle,
    countKey: "securityIssues",
  },
  { view: "functions", label: "Functions", icon: IconCode, countKey: "functions" },
  { view: "architecture", label: "Architecture Docs", icon: IconSitemap },
  { view: "graph", label: "Graph Explorer", icon: IconVectorTriangle },
  { view: "security-learn-index", label: "Security Reference", icon: IconBook },
  {
    view: "settings",
    label: "Practices",
    icon: IconClipboardCheck,
    countKey: "practices",
  },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (view: ViewType) => void;
  currentView: ViewType;
  counts?: { securityIssues: number; functions: number; practices: number };
}

export const NavSheet: FC<Props> = ({
  open,
  onOpenChange,
  onNavigate,
  currentView,
  counts,
}) => {
  const handleNav = useCallback(
    (view: ViewType) => {
      onOpenChange(false);
      // Small delay to let drawer close animation start
      requestAnimationFrame(() => onNavigate(view));
    },
    [onOpenChange, onNavigate]
  );

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Drawer.Content
          className="fixed bottom-0 left-0 right-0 z-50 flex flex-col rounded-t-lg"
          style={{
            backgroundColor:
              "var(--vscode-sideBar-background, var(--vscode-editor-background, hsl(var(--background))))",
            borderColor: "var(--vscode-panel-border, hsl(var(--border)))",
            color:
              "var(--vscode-editor-foreground, hsl(var(--foreground)))",
          }}
        >
          {/* Handle */}
          <div className="flex justify-center pt-3 pb-1">
            <div
              className="w-10 h-1 rounded-full"
              style={{
                backgroundColor:
                  "var(--vscode-scrollbarSlider-background, hsl(var(--muted-foreground) / 0.3))",
              }}
            />
          </div>

          <Drawer.Title className="sr-only">Navigation</Drawer.Title>
          <Drawer.Description className="sr-only">
            Navigate between views
          </Drawer.Description>

          {/* Nav items */}
          <nav className="flex flex-col py-2 px-2">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = currentView === item.view;
              const count =
                item.countKey && counts ? counts[item.countKey] : undefined;

              return (
                <button
                  key={item.view}
                  onClick={() => handleNav(item.view)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors w-full text-left ${
                    isActive
                      ? "bg-[var(--vscode-list-activeSelectionBackground,hsl(var(--accent)))] text-[var(--vscode-list-activeSelectionForeground,hsl(var(--accent-foreground)))]"
                      : "hover:bg-[var(--vscode-list-hoverBackground,hsl(var(--muted)))]"
                  }`}
                  aria-current={isActive ? "page" : undefined}
                >
                  <Icon className="size-5 shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  {count != null && count > 0 && (
                    <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                      {count}
                    </Badge>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Bottom spacer for safe area */}
          <div className="h-4" />
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
};
