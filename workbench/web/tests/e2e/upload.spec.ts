import { randomBytes } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import { expect, test } from "@playwright/test";
import { loginAs, USERS } from "./helpers";

/** A valid RGB PNG of random noise (a fictional "field image"; it contains no histology). */
function noisePng(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const noise = randomBytes(w * 3 * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    noise.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}

// Resumable chunked upload in the browser: Web Crypto checksum, several chunks, pause, reload, resume,
// ingest job, duplicate detection and the size/type check. The test API uses 64 KiB chunks.
test("upload: pause, reload, resume, ingest, duplicate and unsupported type", async ({ page }) => {
  test.setTimeout(150_000);
  await loginAs(page, USERS.assistant);
  const png = noisePng(420, 420); // ~0.5 MiB → about 9 chunks
  // A date in the name triggers an identifier-risk flag (a fictional name; the flag is the point).
  const file = { name: "field-2026-01-31.png", mimeType: "image/png", buffer: png };

  // Slow the chunk PUTs down so the pause lands mid-transfer.
  await page.route("**/api/v1/uploads/*/chunks/*", async (route) => {
    await new Promise((r) => setTimeout(r, 350));
    await route.continue();
  });

  await page.goto("/worklist");
  await page.getByTestId("open-upload").click();
  const dlg = page.getByTestId("upload-dialog");
  await dlg.getByTestId("upload-file").setInputFiles(file);
  await expect(dlg).toContainText("Field image (JPEG/PNG)");
  await dlg.getByLabel("Coded patient").fill("P-0901");
  await dlg.getByLabel("Study accession").fill("CC0-UPL-0901");
  await dlg.getByTestId("upload-start").click();

  const progress = dlg.getByTestId("upload-progress");
  await expect(progress).toHaveAttribute("data-phase", "uploading");
  await expect(progress).toContainText("Web Crypto SHA-256");
  await expect(progress).toContainText("Identifier-risk flags");
  await expect(progress).toContainText(/chunk [2-9] of \d+/);
  await dlg.getByTestId("upload-pause").click();
  await expect(progress).toHaveAttribute("data-phase", "paused");

  // Interrupt completely: reload the page. The upload is resumed by selecting the same file again.
  await page.reload();
  await page.getByTestId("open-upload").click();
  await expect(dlg).toContainText("Interrupted uploads can be resumed");
  await expect(dlg).toContainText(file.name);
  const chooser = page.waitForEvent("filechooser");
  await dlg.getByRole("button", { name: "Select the same file to resume" }).click();
  await (await chooser).setFiles(file);
  await expect(dlg).toContainText("Resumed: the server already had");
  await expect(progress).toHaveAttribute("data-phase", "done", { timeout: 90_000 });
  await expect(dlg.getByTestId("upload-job")).toContainText("succeeded");
  await expect(dlg.getByRole("link", { name: "Open in Slide Review" })).toBeVisible();

  // The same bytes again: detected as a duplicate, nothing ingested twice.
  await page.unroute("**/api/v1/uploads/*/chunks/*");
  await dlg.getByRole("button", { name: "Upload another file" }).click();
  await dlg.getByTestId("upload-file").setInputFiles({ ...file, name: "copy-of-field.png" });
  await dlg.getByLabel("Coded patient").fill("P-0902");
  await dlg.getByLabel("Study accession").fill("CC0-UPL-0902");
  await dlg.getByTestId("upload-start").click();
  await expect(progress).toHaveAttribute("data-phase", "duplicate");
  await expect(progress).toContainText("Already in this project: nothing was ingested again");

  // Type limits come from /meta: a .txt file is refused before anything is sent.
  await dlg.getByRole("button", { name: "Upload another file" }).click();
  await dlg.getByTestId("upload-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(dlg).toContainText(".txt cannot be uploaded");
});
