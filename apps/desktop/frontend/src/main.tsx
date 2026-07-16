import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "./lib/i18n"; // initialize i18next before any component renders
import App from "./App";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { installGlobalErrorHandlers } from "./lib/globalErrors";
import "@novalis/editor/styles.css";
import "./styles.css";

// Last-resort handlers for uncaught errors / unhandled rejections — routed to
// the global error toast so async failures never disappear silently.
installGlobalErrorHandlers();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {/* App-root boundary: a render crash anywhere below degrades to a compact
        fallback offering a full reload instead of a white screen. */}
    <ErrorBoundary reloadOnRetry className="min-h-screen bg-app text-fg">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
