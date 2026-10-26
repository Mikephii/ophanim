import { FC } from "react";
import { Button } from "./ui/button";
import { IconAlertCircle } from "@tabler/icons-react";

interface ErrorStateProps {
  message: string;
  /** Called when user clicks the retry button */
  onRetry?: () => void;
}

/**
 * Shared error state component. Shows error message with optional retry button.
 */
export const ErrorState: FC<ErrorStateProps> = ({ message, onRetry }) => (
  <div className="flex flex-col items-center justify-center h-64 text-center text-muted-foreground px-6">
    <IconAlertCircle className="size-10 mb-3 opacity-40 text-destructive" />
    <p className="text-sm font-medium mb-1">Something went wrong</p>
    <p className="text-xs">{message}</p>
    {onRetry && (
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    )}
  </div>
);
