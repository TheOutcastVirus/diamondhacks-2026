import { ApiError, type EndpointKey } from './types';

const endpointMap: Record<EndpointKey, string> = {
  reminders: '/api/reminders',
  browser: '/api/browser',
  transcript: '/api/transcript',
  transcriptStream: '/api/transcript/stream',
  prompts: '/api/prompts',
  memory: '/api/memory',
};

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

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

function buildUrl(endpoint: EndpointKey | string, query?: Record<string, QueryValue>) {
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
  const response = await fetch(buildUrl(endpoint, query), {
    method,
    headers: {
      Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...rest,
  });

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

export function createEventStream(
  endpoint: EndpointKey | string,
  options: { query?: Record<string, QueryValue>; withCredentials?: boolean } = {},
) {
  return new EventSource(buildUrl(endpoint, options.query), {
    withCredentials: options.withCredentials ?? false,
  });
}
