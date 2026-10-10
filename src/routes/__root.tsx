/// <reference types="vite/client" />
import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "~/styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "AgentTrip — KYA demo" }],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <div className="min-h-screen">
        <header className="sticky top-0 z-20 border-b border-white/5 bg-[#0a0b0d]/85 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-6 px-4 sm:px-6">
            <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-indigo-500/90 text-[11px] font-bold text-white">AT</span>
              AgentTrip
            </Link>
            <nav className="flex gap-1 text-sm">
              <Link to="/" className="rounded-md px-3 py-1.5 text-zinc-400 hover:text-zinc-100" activeProps={{ className: "bg-white/5 !text-zinc-100" }} activeOptions={{ exact: true }}>
                Marketplace
              </Link>
              <Link to="/console" className="rounded-md px-3 py-1.5 text-zinc-400 hover:text-zinc-100" activeProps={{ className: "bg-white/5 !text-zinc-100" }}>
                KYA Console
              </Link>
            </nav>
            <div className="ml-auto hidden text-xs text-zinc-500 sm:block">Principal: Alex Morgan · Mandate mdt_alex_milan_1115</div>
          </div>
        </header>
        <Outlet />
      </div>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="font-sans antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
