import { mkdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { inflateSync } from "node:zlib";

import type { AppConfig } from "./config";
import type { UploadedFile } from "./contracts";
import type { GazabotDatabase } from "./db";

function sanitizeDisplayName(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function sanitizeStoragePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function decodePdfEscapes(input: string): string {
  return input
    .replace(/\\([nrtbf()\\])/g, (_match, token: string) => {
      switch (token) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "b":
          return "\b";
        case "f":
          return "\f";
        default:
          return token;
      }
    })
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function extractStringsFromPdfStream(stream: string): string[] {
  const parts: string[] = [];
  const pushLiteral = (value: string) => {
    const normalized = decodePdfEscapes(value).replace(/\s+/g, " ").trim();
    if (normalized) {
      parts.push(normalized);
    }
  };

  const literalRegex = /\((?:\\.|[^\\)])*\)\s*(?:Tj|TJ|')/g;
  for (const match of stream.matchAll(literalRegex)) {
    const value = match[0].replace(/\)\s*(?:Tj|TJ|')$/, "").slice(1);
    pushLiteral(value);
  }

  const arrayRegex = /\[(.*?)\]\s*TJ/gs;
  for (const match of stream.matchAll(arrayRegex)) {
    const body = match[1] ?? "";
    for (const nested of body.matchAll(/\((?:\\.|[^\\)])*\)/g)) {
      pushLiteral(nested[0].slice(1, -1));
    }
  }

  return parts;
}

function extractPdfText(buffer: Buffer): string {
  const pdf = buffer.toString("latin1");
  const textChunks: string[] = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;

  for (const match of pdf.matchAll(streamRegex)) {
    const raw = match[1] ?? "";
    let decoded: string;

    try {
      decoded = inflateSync(Buffer.from(raw, "latin1")).toString("latin1");
    } catch {
      decoded = raw;
    }

    textChunks.push(...extractStringsFromPdfStream(decoded));
  }

  return textChunks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractTextByMimeType(buffer: Buffer, mimeType: string, filename: string): string | null {
  const lowerMime = mimeType.toLowerCase();
  const lowerName = filename.toLowerCase();

  if (lowerMime === "application/pdf" || lowerName.endsWith(".pdf")) {
    return extractPdfText(buffer) || null;
  }

  if (
    lowerMime.startsWith("text/") ||
    lowerMime === "application/json" ||
    lowerMime === "application/xml" ||
    lowerMime === "text/xml" ||
    /\.(txt|md|json|csv|xml|html|htm|log)$/i.test(lowerName)
  ) {
    return buffer.toString("utf8").trim() || null;
  }

  return null;
}

export class UploadedFileService {
  constructor(
    private readonly config: AppConfig,
    private readonly database: GazabotDatabase,
  ) {}

  async saveUpload(
    file: File,
    options: { displayName?: string; promptId?: string; fieldName?: string; reminderId?: string } = {},
  ): Promise<UploadedFile> {
    const originalName = basename(file.name || "upload");
    const displayName = sanitizeDisplayName(options.displayName || originalName) || originalName;
    const extension = extname(originalName);
    const buffer = Buffer.from(await file.arrayBuffer());

    const record = this.database.createUploadedFile({
      name: displayName,
      originalName,
      storagePath: "",
      mimeType: file.type || "application/octet-stream",
      sizeBytes: buffer.byteLength,
      ...(options.promptId ? { promptId: options.promptId } : {}),
      ...(options.fieldName ? { promptFieldName: options.fieldName } : {}),
      ...(options.reminderId ? { reminderId: options.reminderId } : {}),
    });

    const storageName = `${record.id}_${sanitizeStoragePart(displayName) || "upload"}${extension}`;
    const storagePath = join(this.config.uploadsDir, storageName);
    await mkdir(this.config.uploadsDir, { recursive: true });
    await Bun.write(storagePath, buffer);

    const updated = this.database.replaceUploadedFileStorage(record.id, storagePath);
    await this.extractTextIfPossible(updated.id);
    return this.database.getUploadedFile(updated.id) ?? updated;
  }

  async extractTextIfPossible(fileId: string): Promise<UploadedFile> {
    const file = this.database.getUploadedFile(fileId);
    if (!file) {
      throw new Error(`Uploaded file not found: ${fileId}`);
    }

    const storagePath = this.database.getUploadedFileStoragePath(fileId);
    if (!storagePath) {
      return this.database.updateUploadedFileExtraction(fileId, { textStatus: "failed" });
    }

    const buffer = await readFile(storagePath);
    const extractedText = extractTextByMimeType(buffer, file.mimeType, file.originalName);
    return this.database.updateUploadedFileExtraction(fileId, {
      textStatus: extractedText ? "ready" : "failed",
      ...(extractedText ? { extractedText } : {}),
    });
  }
}
