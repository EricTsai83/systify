import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
// Resolve the primary mono font (Latin, normal) to its build-hashed URL so we
// can preload it. A static <link> in index.html can't do this — Vite relocates
// and hashes the asset at build time — so the import gives us the correct URL
// in both dev and production. `font-display: swap` (fontsource default) already
// keeps text visible; preloading just shortens the swap window for the mono
// font that the heading/code styles lean on.
import jetbrainsMonoLatinUrl from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import "./index.css";

function preloadPrimaryFont() {
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "font";
  link.type = "font/woff2";
  link.href = jetbrainsMonoLatinUrl;
  // Fonts are always fetched in CORS mode; without this the preload wouldn't
  // match the @font-face request and the browser would download it twice.
  link.crossOrigin = "anonymous";
  document.head.appendChild(link);
}

preloadPrimaryFont();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
