# Imagine API (Qualcomm Cirrascale AISuite) Documentation

## Overview

The Qualcomm Imagine APIs enable inference execution on Qualcomm AI100 devices. Accessed via the `imagine` Python library (`ImagineClient`). Built on OpenAPI 3.1.0.

**Base Endpoint:** `https://aisuite.cirrascale.com/apis/v2`

---

## Authentication

All endpoints require a Bearer Token (JWT format) passed via the `api_key` parameter in `ImagineClient`.

---

## Setup

```python
from imagine import ImagineClient

client = ImagineClient(
    debug=True,
    max_retries=1,
    endpoint="https://aisuite.cirrascale.com/apis/v2",
    api_key="YOUR_API_KEY"
)
```

---

## Available Models

Retrieve the list of models currently running in the playground. The model name is required for inference calls.

```python
from imagine import ImagineClient
import json

client = ImagineClient(debug=True, max_retries=1, endpoint="https://aisuite.cirrascale.com/apis/v2", api_key="xxxx")

llm_models = client.get_available_models()
str(llm_models)
```

**Compatible models include:** Llama-3.1-8B, Llama-3.1-70B, Mistral-7B, and others.

---

## Chat

Send a chat message to a model and get a response.

```python
from imagine import ChatMessage, ImagineClient

client = ImagineClient(debug=True, max_retries=1, endpoint="https://aisuite.cirrascale.com/apis/v2", api_key="xxxx")

chat_response = client.chat(
    messages=[ChatMessage(role="user", content="What is the best Spanish cheese?")],
    model="Llama-3.1-8B",
    max_tokens=512
)

chat_response.first_content
```

**Parameters:**
- `messages` — list of `ChatMessage(role, content)` objects
- `model` — model name string (from `get_available_models()`)
- `max_tokens` — max tokens to generate

**Response:** `chat_response.first_content` returns the text of the first response message.

---

## API Endpoints Reference

### Chat Completions — `/v2/chat/completions`
- **GET**: Retrieve conversation history (`max_items` parameter)
- **POST**: Start new conversations; supports streaming and non-streaming, tool calling

### Text Completion — `/v2/completions`
- **GET**: Access completion history
- **POST**: Generate text completions from a prompt; supports streaming

### Embeddings — `/v2/embeddings`
- **GET**: View embedding request history
- **POST**: Generate vector embeddings from text
- **Models:** `BAAI/bge-large-en-v1.5`, `BAAI/bge-small-en-v1.5`

### Image Generation — `/v2/images/generations`
- **GET**: Access generation history
- **POST**: Text-to-image synthesis
- **Output formats:** URL or Base64-encoded JSON
- **Parameters:** `guidance_scale`, `num_inference_steps`, `seed`, image dimensions

### Reranker — `/v2/reranker`
Document relevance scoring.

### Transcription — `/v2/transcribe`
Audio-to-text conversion.

### Translation — `/v2/translate`
Multi-language text translation.

### Health Check — `/v2/health`
Service availability monitoring.

---

## Key Parameters

| Parameter | Description |
|---|---|
| `temperature` | Sampling randomness |
| `top_p` | Nucleus sampling threshold |
| `top_k` | Top-k sampling |
| `repetition_penalty` | Penalize repeated tokens |
| `frequency_penalty` | Reduce frequent token usage |
| `max_tokens` | Max tokens to generate |
| `max_seconds` | Max generation time |
| `num_beams` | Beam search width |
| `stream` | Enable streaming (boolean) |
| `response_format` | Output format |

---

## Response Format

Responses include:
- Generated content/data
- Token usage metrics (prompt, completion, total)
- Generation timestamps and duration
- Unique request identifiers

---

## Error Handling

Standard HTTP status codes with JSON error responses containing `message` and `status` fields.
- `401` — authentication failure

---

## MCP Compatibility & Tool Use

The API supports **OpenAI-style tool/function calling** via `/v2/chat/completions`, but is **not natively MCP-compatible** — MCP (Model Context Protocol) is an Anthropic-specific protocol designed for Claude.

**Bridging MCP tools to this API:**
MCP tool definitions are JSON schemas. You can manually convert them into the OpenAI function calling format accepted by `/v2/chat/completions`, then handle tool call responses in your own code.

> **Note:** Models like Llama and Mistral support function calling but may be less reliable with complex tool use compared to Claude.
