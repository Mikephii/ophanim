import { FC } from "react";
import { IconArrowLeft, IconMenu2, IconRefresh } from "@tabler/icons-react";
import { getViewTitle, type Route } from "../navigation";
import { Logo } from "./Logo";
import { NAV_ITEMS } from "./NavSheet";

interface Props {
  route: Route;
  canGoBack: boolean;
  onBack: () => void;
  onMenuOpen: () => void;
  onRefresh?: () => void;
}

export const Header: FC<Props> = ({
  route,
  canGoBack,
  onBack,
  onMenuOpen,
  onRefresh,
}) => {
  const title = getViewTitle(route);

  return (
    <header
      className="sticky top-0 z-30 flex items-center h-10 px-2 border-b shrink-0"
      style={{
        backgroundColor: "var(--vscode-sideBar-background, var(--vscode-editor-background, hsl(var(--background))))",
        borderColor: "var(--vscode-panel-border, hsl(var(--border)))",
        color: "var(--vscode-editor-foreground, hsl(var(--foreground)))",
      }}
    >
      {/* Back button or route icon */}
      {canGoBack ? (
        <button
          onClick={onBack}
          className="flex items-center justify-center w-8 h-8 rounded hover:bg-[var(--vscode-toolbar-hoverBackground,hsl(var(--muted)))] transition-colors"
          aria-label="Go back"
        >
          <IconArrowLeft className="size-4" />
        </button>
      ) : (() => {
        const navItem = NAV_ITEMS.find((item) => item.view === route.view);
        if (navItem) {
          const Icon = navItem.icon;
          return (
            <div className="flex items-center justify-center w-8 h-8">
              <Icon className="size-4" />
            </div>
          );
        }
        return (
          <div className="flex items-center justify-center w-8 h-8">
            <Logo size={18} />
          </div>
        );
      })()}

      {/* Title */}
      <h1 className="flex-1 text-sm font-medium truncate px-2">{title}</h1>

      {/* Refresh button */}
      {onRefresh && (
        <button
          onClick={onRefresh}
          className="flex items-center justify-center w-8 h-8 rounded hover:bg-[var(--vscode-toolbar-hoverBackground,hsl(var(--muted)))] transition-colors"
          aria-label="Refresh"
        >
          <IconRefresh className="size-4" />
        </button>
      )}

      {/* Menu button */}
      <button
        onClick={onMenuOpen}
        className="flex items-center justify-center w-8 h-8 rounded hover:bg-[var(--vscode-toolbar-hoverBackground,hsl(var(--muted)))] transition-colors"
        aria-label="Open navigation menu"
      >
        <IconMenu2 className="size-4" />
      </button>
    </header>
  );
};
