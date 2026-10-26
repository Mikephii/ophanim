import { FC } from "react";
import { Button } from "./button";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";

type PaginationProps = {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
};

export const Pagination: FC<PaginationProps> = ({
  page,
  totalPages,
  onPageChange,
  disabled,
}) => {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        variant="outline"
        size="xs"
        onClick={() => onPageChange(page - 1)}
        disabled={disabled || page <= 1}
      >
        <IconChevronLeft className="size-3" />
        Prev
      </Button>
      <span className="text-xs text-muted-foreground tabular-nums">
        {page} / {totalPages}
      </span>
      <Button
        variant="outline"
        size="xs"
        onClick={() => onPageChange(page + 1)}
        disabled={disabled || page >= totalPages}
      >
        Next
        <IconChevronRight className="size-3" />
      </Button>
    </div>
  );
};
