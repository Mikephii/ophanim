import { FC } from "react";
import { getViewTitle, type Route } from "../navigation";
import { Logo } from "./Logo";

interface Props {
  route: Route;
  onBack: () => void;
}

export const Header: FC<Props> = ({ route, onBack }) => {
  const title = getViewTitle(route);

  return (
    <header>
      <button onClick={onBack}>Back</button>
      <h1>{title}</h1>
      <Logo size={18} />
    </header>
  );
};
