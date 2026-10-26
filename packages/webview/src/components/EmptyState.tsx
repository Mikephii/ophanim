import { FC, ReactNode } from "react";
import { Button } from "./ui/button";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Optional action button */
  action?: {
    label: string;
    onClick: () => void;
  };
}

/**
 * Shared empty state component for views with no data.
 * Renders a centered icon + title + description + optional action button.
 */
export const EmptyState: FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
}) => (
  <div className="flex flex-col items-center justify-center h-64 text-center text-muted-foreground px-6">
    {icon && <div className="mb-3 opacity-40">{icon}</div>}
    <p className="text-sm font-medium mb-1">{title}</p>
    {description && <p className="text-xs">{description}</p>}
    {action && (
      <Button
        variant="ghost"
        size="sm"
        className="mt-3"
        onClick={action.onClick}
      >
        {action.label}
      </Button>
    )}
  </div>
);
