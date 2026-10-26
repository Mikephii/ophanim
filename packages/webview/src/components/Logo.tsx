import { FC } from "react";
import logoLight from "@/assets/ophan.svg";
import logoDark from "@/assets/ophan-dark.svg";

interface LogoProps {
  size?: number;
  className?: string;
}

export const Logo: FC<LogoProps> = ({ size = 32, className }) => {
  return (
    <>
      <img
        src={logoLight}
        alt="Ophan"
        width={size}
        height={size}
        className={`dark:hidden ${className ?? ""}`}
      />
      <img
        src={logoDark}
        alt="Ophan"
        width={size}
        height={size}
        className={`hidden dark:block ${className ?? ""}`}
      />
    </>
  );
};
