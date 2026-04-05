import { mkdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

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

function extractTextByMimeType(buffer: Buffer, mimeType: string, filename: string): string | null {
  const lowerMime = mimeType.toLowerCase();
  const lowerName = filename.toLowerCase();

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

function isPdfFile(mimeType: string, filename: string): boolean {
  const lowerMime = mimeType.toLowerCase();
  const lowerName = filename.toLowerCase();
  return lowerMime === "application/pdf" || lowerName.endsWith(".pdf");
}

function isImageFile(mimeType: string, filename: string): boolean {
  const lowerMime = mimeType.toLowerCase();
  const lowerName = filename.toLowerCase();
  return lowerMime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(lowerName);
}

function isVideoFile(mimeType: string, filename: string): boolean {
  const lowerMime = mimeType.toLowerCase();
  const lowerName = filename.toLowerCase();
  return lowerMime.startsWith("video/") || /\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(lowerName);
}

function isAudioFile(mimeType: string, filename: string): boolean {
  const lowerMime = mimeType.toLowerCase();
  const lowerName = filename.toLowerCase();
  return lowerMime.startsWith("audio/") || /\.(mp3|wav|ogg|flac|aac|m4a|opus|weba)$/i.test(lowerName);
}

function isMediaFile(mimeType: string, filename: string): boolean {
  return isImageFile(mimeType, filename) || isVideoFile(mimeType, filename) || isAudioFile(mimeType, filename);
}

function normalizeGeminiText(value: string): string | null {
  const trimmed = value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return trimmed || null;
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
    const mimeType = file.mimeType;
    const originalName = file.originalName;

    let extractedText: string | null = null;

    if (isMediaFile(mimeType, originalName)) {
      // Media files always go through Gemini for description + text extraction
      extractedText = await this.extractMediaWithGoogleAi(buffer, mimeType, originalName);
    } else if (isPdfFile(mimeType, originalName)) {
      extractedText = await this.extractTextWithGoogleAi(buffer, mimeType, originalName);
    } else {
      extractedText = extractTextByMimeType(buffer, mimeType, originalName);
    }
    return this.database.updateUploadedFileExtraction(fileId, {
      textStatus: extractedText ? "ready" : "failed",
      ...(extractedText ? { extractedText } : {}),
    });
  }

  private async callGoogleAi(buffer: Buffer, mimeType: string, prompt: string): Promise<string | null> {
    if (!this.config.googleAi.apiKey?.trim()) {
      return null;
    }

    const response = await fetch(
      `${this.config.googleAi.baseUrl}/models/${encodeURIComponent(this.config.googleAi.model)}:generateContent?key=${encodeURIComponent(this.config.googleAi.apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: mimeType || "application/octet-stream",
                    data: buffer.toString("base64"),
                  },
                },
              ],
            },
          ],
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google AI extraction error ${response.status}: ${body}`);
    }

    const payload = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const text =
      payload.candidates
        ?.flatMap((c) => c.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("\n") ?? "";

    return normalizeGeminiText(text);
  }

  private async extractTextWithGoogleAi(buffer: Buffer, mimeType: string, _filename: string): Promise<string | null> {
    const prompt =
      "Extract the useful readable text from this PDF into plain text for a text-only assistant. Preserve headings and line breaks when they help readability.";
    return this.callGoogleAi(buffer, mimeType, prompt);
  }

  private async extractMediaWithGoogleAi(
    buffer: Buffer,
    mimeType: string,
    filename: string,
  ): Promise<string | null> {
    let prompt: string;

    if (isImageFile(mimeType, filename)) {
      prompt =
        "Analyze this image and respond in two clearly labeled sections:\n\n" +
        "DESCRIPTION:\n" +
        "Provide a very detailed description of the image. Include all subjects, objects, people, animals, text, colors, shapes, setting, spatial layout, actions, expressions, context, and any other observable details. Be thorough.\n\n" +
        "EXTRACTED TEXT:\n" +
        "List all text, numbers, labels, signs, captions, or any other readable content visible in the image, preserving their reading order. If no text is visible, write \"None.\"";
    } else if (isVideoFile(mimeType, filename)) {
      prompt =
        "Analyze this video and respond in two clearly labeled sections:\n\n" +
        "DESCRIPTION:\n" +
        "Provide a very detailed description of the video. Cover all people, objects, settings, actions, events, camera movements, and visual context. Use concise timestamps when helpful. Be thorough.\n\n" +
        "EXTRACTED TEXT:\n" +
        "Transcribe all text visible on screen (titles, captions, signs, overlays) and all spoken dialogue or narration, with speaker labels and timestamps where possible. If none, write \"None.\"";
    } else {
      // Audio
      prompt =
        "Analyze this audio and respond in two clearly labeled sections:\n\n" +
        "DESCRIPTION:\n" +
        "Describe the audio in detail: what type of audio it is, who is speaking (if anyone), the tone, mood, language, background sounds, music, and overall context.\n\n" +
        "TRANSCRIPT:\n" +
        "Provide a full transcript of any spoken content, with speaker labels and timestamps where possible. If no speech is present, write \"None.\"";
    }

    return this.callGoogleAi(buffer, mimeType, prompt);
  }
}
