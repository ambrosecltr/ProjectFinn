import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";

const FINN_PROFILE_PHOTO_PATH = resolve(process.cwd(), "assets", "finn_profile.png");
const FINN_CONTACT_CARD_PATH = "/public/finn/contact-card.vcf";

export function buildFinnContactCard(fromNumber: string, embeddedPhotoBase64?: string): string {
  const escapedNumber = fromNumber.replace(/,/g, "\\,").replace(/;/g, "\\;");

  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Finn",
    "N:;Finn;;;",
    `TEL;TYPE=CELL:${escapedNumber}`,
    ...(embeddedPhotoBase64 ? [`PHOTO;ENCODING=b;TYPE=PNG:${embeddedPhotoBase64}`] : []),
    "END:VCARD",
    "",
  ].join("\r\n");
}

export function buildFinnProfilePhotoUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/public/finn/profile-photo`;
}

export function buildFinnContactCardUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${FINN_CONTACT_CARD_PATH}`;
}

export function createPublicAssetRoutes(deps: { fromNumber?: string }): Hono {
  const app = new Hono();

  app.get("/finn/profile-photo", async (c) => {
    let data: Buffer;
    try {
      data = await readFile(FINN_PROFILE_PHOTO_PATH);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }

    return new Response(data, {
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": 'inline; filename="finn_profile.png"',
      },
    });
  });

  app.get("/finn/contact-card.vcf", (c) => {
    if (!deps.fromNumber) {
      return c.json({ error: "Contact card phone number is not configured" }, 404);
    }

    const fromNumber = deps.fromNumber;
    return readFile(FINN_PROFILE_PHOTO_PATH)
      .then((data) => {
        c.header("Content-Type", "text/vcard; charset=utf-8");
        c.header("Content-Disposition", 'inline; filename="finn-contact-card.vcf"');
        return c.body(buildFinnContactCard(fromNumber, data.toString("base64")));
      })
      .catch(() => c.json({ error: "File not found" }, 404));
  });

  return app;
}
