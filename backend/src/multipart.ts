import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import multer from "multer";

type ParsedMultipartRequest = Readable & {
  headers: Record<string, string>;
  method: string;
  url: string;
  body?: Record<string, unknown>;
  file?: {
    originalname: string;
    mimetype: string;
    buffer: Buffer;
    size: number;
  };
};

class MockServerResponse extends EventEmitter {
  statusCode = 200;

  setHeader(): void {}

  getHeader(): undefined {
    return undefined;
  }

  removeHeader(): void {}

  end(): void {
    this.emit("finish");
  }
}

const uploadSingleFile = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 25 * 1024 * 1024,
  },
}).single("file");

function toNodeHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    normalized[key.toLowerCase()] = value;
  });
  return normalized;
}

export async function parseMultipartUpload(request: Request): Promise<{
  fields: Record<string, unknown>;
  file: {
    originalname: string;
    mimetype: string;
    buffer: Buffer;
    size: number;
  };
}> {
  const payload = Buffer.from(await request.arrayBuffer());
  const nodeRequest = Readable.from([payload]) as ParsedMultipartRequest;
  nodeRequest.headers = {
    ...toNodeHeaders(request.headers),
    "content-length": String(payload.byteLength),
  };
  nodeRequest.method = request.method;
  nodeRequest.url = new URL(request.url).pathname;
  nodeRequest.body = {};

  const nodeResponse = new MockServerResponse();

  await new Promise<void>((resolve, reject) => {
    uploadSingleFile(nodeRequest as never, nodeResponse as never, (error?: unknown) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  if (!nodeRequest.file) {
    throw new Error("Invalid field: file");
  }

  return {
    fields: nodeRequest.body ?? {},
    file: nodeRequest.file,
  };
}
