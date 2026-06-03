import { describe, expect, it } from "bun:test";
import { buildFinnContactCard, buildFinnContactCardUrl, buildFinnProfilePhotoUrl, createPublicAssetRoutes } from "./public-assets.js";

describe("public assets", () => {
  it("builds stable public URLs", () => {
    expect(buildFinnProfilePhotoUrl("https://example.com/")).toBe("https://example.com/public/finn/profile-photo");
    expect(buildFinnContactCardUrl("https://example.com/")).toBe("https://example.com/public/finn/contact-card.vcf");
  });

  it("builds a vCard with the configured number", () => {
    expect(buildFinnContactCard("+15551234567")).toContain("TEL;TYPE=CELL:+15551234567");
    expect(buildFinnContactCard("+15551234567")).toContain("FN:Finn");
    expect(buildFinnContactCard("+15551234567")).toContain("N:;Finn;;;");
  });

  it("serves the generated vCard with an embedded profile photo", async () => {
    const app = createPublicAssetRoutes({ fromNumber: "+15551234567" });

    const response = await app.request("http://localhost/finn/contact-card.vcf");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/vcard; charset=utf-8");
    expect(body).toContain("TEL;TYPE=CELL:+15551234567");
    expect(body).toContain("N:;Finn;;;");
    expect(body).toContain("PHOTO;ENCODING=b;TYPE=PNG:");
  });

  it("returns not found for the generated vCard when no line phone is configured", async () => {
    const app = createPublicAssetRoutes({});

    const response = await app.request("http://localhost/finn/contact-card.vcf");

    expect(response.status).toBe(404);
  });
});
