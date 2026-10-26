import { FC, useState } from "react";
import { Drawer } from "vaul";
import { Button } from "../ui/button";
import { useWebviewMutation } from "../../use-webview-query";

interface IssueDismissProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentHash: string;
  issueIndex: number;
  flag: string;
  onDismissed: () => void;
}

const REASONS = [
  { value: "false_positive", label: "False positive", description: "This is not a real vulnerability" },
  { value: "accepted_risk", label: "Accepted risk", description: "Known issue, accepted by the team" },
  { value: "wont_fix", label: "Won't fix", description: "Not worth fixing at this time" },
] as const;

export const IssueDismiss: FC<IssueDismissProps> = ({
  open,
  onOpenChange,
  contentHash,
  issueIndex,
  flag,
  onDismissed,
}) => {
  const [reason, setReason] = useState<string>("false_positive");
  const [note, setNote] = useState("");
  const { mutate: dismiss, isLoading } = useWebviewMutation("dismissIssue");

  const handleDismiss = async () => {
    try {
      await dismiss({ contentHash, issueIndex, flag, reason, note: note || undefined });
      setNote("");
      setReason("false_positive");
      onOpenChange(false);
      onDismissed();
    } catch {
      // Error is tracked by the mutation hook
    }
  };

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Drawer.Content
          className="fixed bottom-0 left-0 right-0 z-50 flex flex-col rounded-t-lg border-t"
          style={{
            backgroundColor: "var(--vscode-sideBar-background, var(--vscode-editor-background, hsl(var(--background))))",
            borderColor: "var(--vscode-panel-border, hsl(var(--border)))",
            color: "var(--vscode-editor-foreground, hsl(var(--foreground)))",
          }}
        >
          <div className="flex justify-center pt-3 pb-1">
            <div
              className="w-10 h-1 rounded-full"
              style={{
                backgroundColor: "var(--vscode-scrollbarSlider-background, hsl(var(--muted-foreground) / 0.3))",
              }}
            />
          </div>
          <Drawer.Title className="sr-only">Dismiss Issue</Drawer.Title>
          <Drawer.Description className="sr-only">
            Choose a reason for dismissing this security issue
          </Drawer.Description>

          <div className="px-4 pb-6 pt-2 space-y-4">
            <h3 className="text-sm font-semibold">Dismiss Issue</h3>

            {/* Reason selection */}
            <div className="space-y-1.5">
              {REASONS.map((r) => (
                <button
                  key={r.value}
                  onClick={() => setReason(r.value)}
                  className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-colors border ${
                    reason === r.value
                      ? "border-primary bg-primary/10"
                      : "border-transparent hover:bg-muted"
                  }`}
                >
                  <span className="font-medium">{r.label}</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    {r.description}
                  </span>
                </button>
              ))}
            </div>

            {/* Optional note */}
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Note (optional)
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add context about this decision..."
                rows={2}
                className="w-full text-sm rounded-md border px-3 py-2 resize-none"
                style={{
                  backgroundColor: "var(--vscode-input-background, hsl(var(--background)))",
                  borderColor: "var(--vscode-input-border, hsl(var(--border)))",
                  color: "var(--vscode-input-foreground, hsl(var(--foreground)))",
                }}
              />
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="flex-1"
                onClick={handleDismiss}
                disabled={isLoading}
              >
                {isLoading ? "Dismissing..." : "Dismiss"}
              </Button>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
};
