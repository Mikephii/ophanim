import { FC, useEffect, useState } from "react";
import { useDataBridge } from "../data-bridge";
import { IconCheck } from "@tabler/icons-react";

/**
 * Brief "Updated" toast that appears when the database reloads.
 * Auto-hides after 2 seconds.
 */
export const UpdatedToast: FC = () => {
  const bridge = useDataBridge();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    return bridge.onPush((event) => {
      if (event.type === "dbReloaded") {
        setVisible(true);
      }
    });
  }, [bridge]);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), 2000);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      className="fixed top-2 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium shadow-md animate-in fade-in slide-in-from-top-2 duration-200"
      style={{
        backgroundColor: "var(--vscode-badge-background, hsl(var(--primary)))",
        color: "var(--vscode-badge-foreground, hsl(var(--primary-foreground)))",
      }}
    >
      <IconCheck className="size-3" />
      Updated
    </div>
  );
};
