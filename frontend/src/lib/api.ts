import { ApiError, type EndpointKey } from './types';

const endpointMap: Record<EndpointKey, string> = {
  reminders: '/api/reminders',
  browser: '/api/browser',
  transcript: '/api/transcript',
  transcriptStream: '/api/transcript/stream',
  prompts: '/api/prompts',
  memory: '/api/memory',
  files: '/api/files',
};

const defaultDevApiBaseUrl = import.meta.env.DEV ? 'http://127.0.0.1:8000' : '';
const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
const apiBaseUrl = (configuredApiBaseUrl || defaultDevApiBaseUrl).replace(/\/$/, '');

type QueryValue = string | number | boolean | null | undefined;
type RequestOptions = Omit<RequestInit, 'body' | 'method'> & {
  body?: unknown;
  query?: Record<string, QueryValue>;
};

function resolvePath(endpoint: EndpointKey | string) {
  if (endpoint in endpointMap) {
    return endpointMap[endpoint as EndpointKey];
  }

  return endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
}

export function buildUrl(endpoint: EndpointKey | string, query?: Record<string, QueryValue>) {
  const path = resolvePath(endpoint);
  const url = new URL(`${apiBaseUrl}${path}`, window.location.origin);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined || value === '') {
        continue;
      }

      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

function isNetworkFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    error.name === 'TypeError' ||
    message.includes('networkerror') ||
    message.includes('failed to fetch') ||
    message.includes('load failed')
  );
}

function toApiError(error: unknown, endpoint: EndpointKey | string): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (isNetworkFailure(error)) {
    const path = resolvePath(endpoint);
    const message =
      path === '/api/browser' || path === '/api/agent/turn'
        ? 'Unable to reach the backend or Browser Use service. Check that the backend is running, then try again.'
        : 'Unable to reach the backend. Check that the server is running, then try again.';
    return new ApiError(message, 0, null);
  }

  if (error instanceof Error) {
    return new ApiError(error.message, 0, null);
  }

  return new ApiError('Unexpected request failure.', 0, null);
}

async function parseResponse(response: Response) {
  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  endpoint: EndpointKey | string,
  options: RequestOptions = {},
) {
  const { body, query, headers, ...rest } = options;
  let response: Response;
  try {
    response = await fetch(buildUrl(endpoint, query), {
      method,
      headers: {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...rest,
    });
  } catch (error) {
    throw toApiError(error, endpoint);
  }

  const payload = await parseResponse(response);

  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'message' in payload
        ? String(payload.message)
        : `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status, payload);
  }

  return payload as T;
}

export function get<T>(endpoint: EndpointKey | string, options?: Omit<RequestOptions, 'body'>) {
  return request<T>('GET', endpoint, options);
}

export function post<T>(
  endpoint: EndpointKey | string,
  body?: unknown,
  options?: Omit<RequestOptions, 'body'>,
) {
  return request<T>('POST', endpoint, { ...options, body });
}

export function patch<T>(
  endpoint: EndpointKey | string,
  body?: unknown,
  options?: Omit<RequestOptions, 'body'>,
) {
  return request<T>('PATCH', endpoint, { ...options, body });
}

export function del<T>(endpoint: EndpointKey | string, options?: Omit<RequestOptions, 'body'>) {
  return request<T>('DELETE', endpoint, options);
}

export async function postAudio(endpoint: EndpointKey | string, blob: Blob): Promise<ArrayBuffer> {
  const form = new FormData();
  form.append('audio', blob, 'recording.webm');
  let response: Response;
  try {
    response = await fetch(buildUrl(endpoint), { method: 'POST', body: form });
  } catch (error) {
    throw toApiError(error, endpoint);
  }
  if (!response.ok) {
    throw new ApiError(`Audio request failed`, response.status, null);
  }
  return response.arrayBuffer();
}

export async function uploadFile(
  endpoint: EndpointKey | string,
  file: File,
  metadata: Record<string, string | undefined> = {},
) {
  const form = new FormData();
  form.append('file', file, file.name);
  for (const [key, value] of Object.entries(metadata)) {
    if (value) {
      form.append(key, value);
    }
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(endpoint), { method: 'POST', body: form });
  } catch (error) {
    throw toApiError(error, endpoint);
  }
  const payload = await parseResponse(response);
  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'message' in payload
        ? String(payload.message)
        : `Upload failed with status ${response.status}`;
    throw new ApiError(message, response.status, payload);
  }
  return payload;
}

export function createEventStream(
  endpoint: EndpointKey | string,
  options: { query?: Record<string, QueryValue>; withCredentials?: boolean } = {},
) {
  return new EventSource(buildUrl(endpoint, options.query), {
    withCredentials: options.withCredentials ?? false,
  });
}
