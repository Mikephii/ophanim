import { FC } from "react";
import type { Route } from "../navigation";
import { HomeView } from "../views/HomeView";
import { StatusView } from "../views/StatusView";
import { FunctionDetailView } from "../views/FunctionDetailView";
import { SecurityIssuesView } from "../views/SecurityIssuesView";
import { FunctionsView } from "../views/FunctionsView";
import { ArchitectureView } from "../views/ArchitectureView";
import { CommunityView } from "../views/CommunityView";
import { GroupView } from "../views/GroupView";
import { ConcernView } from "../views/ConcernView";
import { ConcernsIndexView } from "../views/ConcernsIndexView";
import { SecurityLearnIndexView } from "../views/SecurityLearnIndexView";
import { SecurityLearnView } from "../views/SecurityLearnView";
import { SettingsView } from "../views/SettingsView";
import { GraphView } from "../views/GraphView";
import type { FunctionData } from "../useVSCode";

interface Props {
  route: Route;
  /** Pre-loaded function data from legacy CodeLens flow */
  legacyFunctionData?: FunctionData | null;
}

/** Placeholder for views not yet implemented */
const ComingSoon: FC<{ title: string }> = ({ title }) => (
  <div className="flex flex-col items-center justify-center h-64 text-center text-muted-foreground">
    <p className="text-sm font-medium">{title}</p>
    <p className="text-xs mt-1">Coming soon</p>
  </div>
);

export const ViewRouter: FC<Props> = ({
  route,
  legacyFunctionData,
}) => {
  switch (route.view) {
    case "home":
      return <HomeView />;

    case "status":
      return <StatusView />;

    case "function-detail":
      return <FunctionDetailView legacyData={legacyFunctionData} />;

    case "security-issues":
      return <SecurityIssuesView />;

    case "functions":
      return <FunctionsView />;

    case "architecture":
      return <ArchitectureView />;

    case "community-detail":
      return <CommunityView />;

    case "group-detail":
      return <GroupView />;

    case "concern-detail":
      return <ConcernView />;

    case "concerns-index":
      return <ConcernsIndexView />;

    case "security-learn-index":
      return <SecurityLearnIndexView />;

    case "security-learn":
      return <SecurityLearnView />;

    case "graph":
      return <GraphView />;

    case "settings":
      return <SettingsView />;

    default:
      return <ComingSoon title="Unknown View" />;
  }
};
