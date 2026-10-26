import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// VS Code theme detection -- sync dark/light class with VS Code's active theme.
// VS Code adds vscode-dark, vscode-light, or vscode-high-contrast to <body>.
function syncThemeClass() {
  const isDark =
    document.body.classList.contains("vscode-dark") ||
    document.body.classList.contains("vscode-high-contrast");
  const isVSCode =
    document.body.classList.contains("vscode-dark") ||
    document.body.classList.contains("vscode-light") ||
    document.body.classList.contains("vscode-high-contrast");

  if (isVSCode) {
    document.documentElement.classList.toggle("dark", isDark);
  }
}

// Sync on load and observe changes (theme can change while webview is open)
syncThemeClass();
const observer = new MutationObserver(syncThemeClass);
observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
