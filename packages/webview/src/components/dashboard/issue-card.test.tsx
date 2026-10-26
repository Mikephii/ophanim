import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IssueCard } from "./issue-card";

const mockIssue = {
  flag: "sql_injection",
  title: "SQL injection via template literal",
  description: "User input concatenated into query.",
  severity: "error",
  confidence: "high",
};

describe("IssueCard", () => {
  it("renders issue title and description", () => {
    render(
      <IssueCard
        issue={mockIssue}
        functionName="getUser"
        filePath="src/db/queries.ts"
        contentHash="hash1"
        onNavigate={() => {}}
      />,
    );

    expect(screen.getByText("SQL injection via template literal")).toBeDefined();
    expect(
      screen.getByText("User input concatenated into query."),
    ).toBeDefined();
  });

  it("renders function name and file path", () => {
    render(
      <IssueCard
        issue={mockIssue}
        functionName="getUser"
        filePath="src/db/queries.ts"
        contentHash="hash1"
        onNavigate={() => {}}
      />,
    );

    expect(screen.getByText("getUser")).toBeDefined();
    expect(screen.getByText("src/db/queries.ts")).toBeDefined();
  });

  it("calls onNavigate with contentHash when clicked", () => {
    const onNavigate = vi.fn();
    render(
      <IssueCard
        issue={mockIssue}
        functionName="getUser"
        filePath="src/db/queries.ts"
        contentHash="hash1"
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    expect(onNavigate).toHaveBeenCalledWith("hash1", "src/db/queries.ts");
  });

  it("renders priority badge", () => {
    render(
      <IssueCard
        issue={mockIssue}
        functionName="getUser"
        filePath="src/db/queries.ts"
        contentHash="hash1"
        onNavigate={() => {}}
      />,
    );

    // error+high = P0
    expect(screen.getByText("P0")).toBeDefined();
  });

  it("truncates long file paths", () => {
    render(
      <IssueCard
        issue={mockIssue}
        functionName="getUser"
        filePath="packages/very/long/deep/nested/path/to/source/file/queries.ts"
        contentHash="hash1"
        onNavigate={() => {}}
      />,
    );

    // Path should be truncated with ellipsis
    expect(
      screen.getByText(/\.\.\..*queries\.ts/),
    ).toBeDefined();
  });
});
