// ============ ERROR TYPES ============
// Pure module -- no VS Code dependencies, fully testable.

export type ErrorSeverity = "fatal" | "recoverable" | "transient";

export interface ErrorRecoveryAction {
  label: string;
  command: string;
  args?: unknown[];
}

export type OphanError =
  | {
      type: "api_key_invalid";
      message: string;
      severity: "fatal";
      recovery: ErrorRecoveryAction;
    }
  | {
      type: "rate_limited";
      message: string;
      severity: "transient";
      retryAfterMs: number;
      recovery: ErrorRecoveryAction;
    }
  | {
      type: "network_error";
      message: string;
      severity: "recoverable";
      recovery: ErrorRecoveryAction;
    }
  | {
      type: "timeout";
      message: string;
      severity: "recoverable";
      recovery: ErrorRecoveryAction;
    }
  | {
      type: "process_crash";
      message: string;
      severity: "recoverable";
      exitCode: number;
      recovery: ErrorRecoveryAction;
    }
  | {
      type: "db_locked";
      message: string;
      severity: "transient";
      recovery: ErrorRecoveryAction;
    }
  | {
      type: "analysis_failed";
      message: string;
      severity: "recoverable";
      file?: string;
      recovery: ErrorRecoveryAction;
    };

// ============ ERROR CLASSIFICATION ============

/** Classify a watch process error message into a typed error with recovery action. */
export function classifyWatchError(message: string, file?: string): OphanError {
  const msg = (message || "").toLowerCase();

  if (msg.includes("api_key") || msg.includes("authentication") || msg.includes("invalid x-api-key") || msg.includes("401")) {
    return {
      type: "api_key_invalid",
      message: "API key is invalid or expired",
      severity: "fatal",
      recovery: {
        label: "Open Settings",
        command: "workbench.action.openSettings",
        args: ["ophan.anthropicApiKey"],
      },
    };
  }

  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("rate_limit")) {
    return {
      type: "rate_limited",
      message: "Anthropic API rate limit reached",
      severity: "transient",
      retryAfterMs: 60_000,
      recovery: {
        label: "View Output",
        command: "ophan.showOutput",
      },
    };
  }

  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("fetch failed") || msg.includes("network")) {
    return {
      type: "network_error",
      message: "Network connection failed",
      severity: "recoverable",
      recovery: {
        label: "Retry",
        command: "ophan.analyzeNow",
      },
    };
  }

  if (msg.includes("etimedout") || msg.includes("timeout")) {
    return {
      type: "timeout",
      message: "Analysis timed out",
      severity: "recoverable",
      recovery: {
        label: "Retry",
        command: "ophan.analyzeNow",
      },
    };
  }

  if (msg.includes("busy") || msg.includes("locked") || msg.includes("sqlite_busy")) {
    return {
      type: "db_locked",
      message: "Database temporarily locked",
      severity: "transient",
      recovery: {
        label: "Retry",
        command: "ophan.analyzeNow",
      },
    };
  }

  return {
    type: "analysis_failed",
    message: message || "Analysis failed",
    severity: "recoverable",
    file,
    recovery: {
      label: "Show Output",
      command: "ophan.showOutput",
    },
  };
}
