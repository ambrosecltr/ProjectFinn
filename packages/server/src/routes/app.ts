import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { serveStatic } from "hono/bun";
import { Hono } from "hono";

const webDistRoot = resolve(process.cwd(), "packages", "web", "dist");
const indexPath = join(webDistRoot, "index.html");
const faviconPath = join(webDistRoot, "icons", "icon-192.png");

export function createAppRoutes(): Hono {
  const app = new Hono();

  app.use("/assets/*", serveStatic({ root: webDistRoot }));
  app.use("/icons/*", serveStatic({ root: webDistRoot }));
  app.get("/favicon.ico", () => new Response(Bun.file(faviconPath), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-cache",
    },
  }));
  app.get("/manifest.webmanifest", () => new Response(Bun.file(join(webDistRoot, "manifest.webmanifest")), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  }));
  app.get("/sw.js", () => new Response(Bun.file(join(webDistRoot, "sw.js")), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/",
    },
  }));

  app.get("*", async () => {
    if (!existsSync(indexPath)) {
      return new Response("Finn web app is not built. Run `bun run web:build`.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return new Response(Bun.file(indexPath), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  return app;
}
